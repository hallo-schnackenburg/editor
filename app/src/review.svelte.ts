// The review: the submissions of everybody as GitHub has them (a pull request each), and what is done with them: look at what
// a submission does, talk about it, submit it, accept it (merge) or close it. Everybody in the team may; there are no roles.
// The state is GitHub's; this only reads it and asks for the actions.

import { validateEntryYaml, type Issue } from '@editor/core'
import { ApiError, SignedOut, type Api, type Submission, type SubmissionDetail, type SubmissionItem, type Comment, type News } from './api.js'

export type Action = 'submit' | 'merge' | 'close'

/** The submissions that are listed: the ones that can still be changed (accepted and closed ones are not shown for now). */
export const isListed = (c: Submission): boolean => c.state === 'draft' || c.state === 'submitted'

/** What the review needs of the workspace: the list of submissions it keeps, and what to do when the open submission is accepted. */
export interface Host {
  submissions: Submission[]
  loadSubmissions(): Promise<void>
  accepted(submission: Submission): Promise<void>
  signedOut(): void
  /** What the submission does to the entries, worked out from what the workspace has (undefined: it does not have the submission's entries). */
  items?(number: number): SubmissionItem[] | undefined
  /** The comments that were read before (kept for the next visit), and the place to keep new ones. */
  kept?(number: number): Comment[] | undefined
  keep?(number: number, comments: Comment[]): void
}

export class Review {
  /** The submission whose details are loaded: the one that is worked on. */
  selected = $state<number>()
  /** Its details are shown in the middle (instead of an entry). */
  detailOpen = $state(false)
  /** What GitHub said of the submission: the checks, and the entries as long as the workspace does not have them. */
  #remote = $state.raw<SubmissionDetail>()
  /** What the submission does: the entries are the workspace's own (no waiting), the rest is GitHub's, as far as it was read. */
  detail = $derived.by<SubmissionDetail | undefined>(() => {
    const remote = this.#remote?.submission.number === this.selected ? this.#remote : undefined
    const items = this.selected === undefined ? undefined : this.#host.items?.(this.selected)
    const submission = this.submission ?? remote?.submission
    if (!items || !submission) return remote
    return { submission, items, truncated: false, checks: remote?.checks ?? 'none' }
  })
  detailState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  comments = $state.raw<Comment[]>([])
  /** The action that is being done right now. */
  acting = $state<Action>()
  error = $state('')

  readonly #api: Api
  readonly #host: Host
  /** Only the newest request counts (the person may click on while one is on its way). */
  #loading = 0
  /** What was read of a submission before: shown at once when it is opened again, while the new state is on its way. */
  readonly #seen = new Map<number, { detail: SubmissionDetail; comments: Comment[] }>()

  constructor(api: Api, host: Host) {
    this.#api = api
    this.#host = host
  }

  // Getters, not $derived: they read the host's list, which is only there once the constructor has run.
  get shown(): Submission[] {
    return this.#host.submissions.filter(isListed).sort((a, b) => b.updated.localeCompare(a.updated))
  }

  get submission(): Submission | undefined {
    return this.#host.submissions.find((c) => c.number === this.selected)
  }

  /** What is wrong with the entries of the open submission, by path (the automatic check says more, with the references). */
  problems = $derived.by(() => {
    const found = new Map<string, Issue[]>()
    for (const item of this.detail?.items ?? []) {
      const issues = item.after === undefined ? [] : validateEntryYaml(item.after)
      if (issues.length > 0) found.set(item.path, issues)
    }
    return found
  })

  /** Why the open submission cannot be accepted, if it cannot. */
  blocked = $derived(this.blockReason(this.detail))

  /** Why a submission cannot be accepted, if it cannot (what the screen blocks, the chat is blocked by too). */
  blockReason(detail: SubmissionDetail | undefined): string | undefined {
    if (detail?.checks === 'failure') return 'Die automatische Prüfung ist fehlgeschlagen.'
    if ((detail?.items ?? []).some((item) => item.after !== undefined && validateEntryYaml(item.after).length > 0)) return 'Einträge der Einreichung sind nicht gültig.'
    return undefined
  }

  /** Reads a submission and its comments without looking at it (nothing in the screen changes). */
  async peek(number: number): Promise<{ detail: SubmissionDetail; comments: Comment[] }> {
    const [detail, comments] = await Promise.all([this.#api.submission(number), this.#api.comments(number)])
    return { detail, comments }
  }

  async select(number: number | undefined): Promise<void> {
    this.selected = number
    this.error = ''
    if (number === undefined) {
      this.#remote = undefined
      this.comments = []
      this.detailState = 'idle'
      return
    }
    const seen = this.#seen.get(number)
    const kept = this.#host.kept?.(number)
    this.#remote = seen?.detail
    this.comments = seen?.comments ?? kept ?? []
    // What is known (the entries of the workspace, comments read before) is shown at once; GitHub's answer follows.
    const known = seen !== undefined || this.detail !== undefined
    if (known) this.detailState = 'ready'
    await this.#reload(number, { quiet: known })
  }

  /** News: the list was refreshed by the workspace; the open submission and its comments are asked for again if they are the ones that changed. */
  async news(news?: News): Promise<void> {
    if (this.selected === undefined) return
    if (news?.type === 'push' || news?.number === undefined || news.number === this.selected) await this.#reload(this.selected, { quiet: true })
  }

  async #reload(number: number, { quiet = false } = {}): Promise<void> {
    const mine = ++this.#loading
    if (!quiet) this.detailState = 'loading'
    try {
      const [detail, comments] = await Promise.all([this.#api.submission(number), this.#api.comments(number)])
      if (mine !== this.#loading) return
      this.#remote = detail
      this.comments = comments
      this.detailState = 'ready'
      this.#seen.set(number, { detail, comments })
      this.#host.keep?.(number, comments)
    } catch (error) {
      if (mine !== this.#loading) return
      if (error instanceof SignedOut) return this.#host.signedOut()
      this.detailState = 'failed'
      this.error = (error as Error).message
    }
  }

  /** The submission an action is for: the one given by its number, else the open one. */
  #target(number: number | undefined): Submission | undefined {
    return number === undefined ? this.submission : this.#host.submissions.find((c) => c.number === number)
  }

  async act(action: Action, number?: number): Promise<boolean> {
    const submission = this.#target(number)
    if (!submission || this.acting) return false
    this.acting = action
    this.error = ''
    try {
      await this.#api[action](submission.number)
      await this.#host.loadSubmissions()
      if (this.selected === submission.number) await this.#reload(submission.number, { quiet: true })
      if (action === 'merge') await this.#host.accepted(submission)
      return true
    } catch (error) {
      if (error instanceof SignedOut) this.#host.signedOut()
      else {
        this.error = error instanceof ApiError ? error.message : (error as Error).message
        // The server may know better than we did (accepted elsewhere meanwhile): look again.
        await this.#host.loadSubmissions().catch(() => undefined)
      }
      return false
    } finally {
      this.acting = undefined
    }
  }

  /** Gives the open submission another name (the title of its pull request). */
  async rename(name: string, number?: number): Promise<boolean> {
    const submission = this.#target(number)
    if (!submission || this.acting || !name.trim()) return false
    this.error = ''
    try {
      await this.#api.rename(submission.number, name)
      await this.#host.loadSubmissions()
      if (this.selected === submission.number) await this.#reload(submission.number, { quiet: true })
      return true
    } catch (error) {
      if (error instanceof SignedOut) this.#host.signedOut()
      else this.error = (error as Error).message
      return false
    }
  }

  async comment(body: string, given?: number): Promise<boolean> {
    const number = given ?? this.selected
    if (number === undefined || !body.trim()) return false
    try {
      const comment = await this.#api.comment(number, body)
      if (this.selected === number && !this.comments.some((c) => c.id === comment.id)) this.comments = [...this.comments, comment]
      return true
    } catch (error) {
      if (error instanceof SignedOut) this.#host.signedOut()
      else this.error = (error as Error).message
      return false
    }
  }
}
