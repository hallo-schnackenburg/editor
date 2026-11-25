// The state of the editor: who is signed in, the entries as loaded and as changed, which one is open, and the submissions (a branch
// and a pull request each). The work is done on the active submission, which anybody may change: with none (a new draft), the first
// thing that is saved makes its branch and its draft pull request (named by the day until it is named), and everything finished
// ("Fertig") is one more commit on the active branch. What is being typed is only in the editor until then. The changes shown are
// what the active branch differs from the base branch in. Another submission is chosen with `switchTo`, which asks about what is not
// saved. The screens only show all this and call these methods.

import { FOLDER_PATH, MODEL, readValue, setField, slugify, submissionBranch, type EntryType, type IndexEntry as Line, type Issue } from '@contents-editor/core'
import type { Agent, AppState, IndexEntry, TrailStep } from './agent.js'

/** How many times the assistant may look things up for one message. */
const MAX_STEPS = 8
import { carryOut, type ChatMessage } from './chat.js'
import { ApiError, SignedOut, type Api, type Submission, type SubmissionItem, type SubmissionRef, type Comment, type Listener, type News, type User } from './api.js'
import { folderOf, foldersOf, idOf, describeIssue, isMarker, issuesOf, makeEntry, makeStub, marker, nameFieldOf, newEntry, planRemoval, planRename, refsIn, shownTitle, titleOf, typeOf, withText, type Entry, type RenamePlan } from './logic.js'
import { Known, MemoryStore, type Listed, type Store, type View } from './known.js'
import { Review, type Host } from './review.svelte.js'

/** A save that is on its way: what is written, where, and how things were before (to take it back if it fails). */
interface Job {
  writes: { path: string; text: string }[]
  removals: string[]
  ref: SubmissionRef
  made: boolean
  /** The saved texts before it (an entry save takes them back if it fails). */
  before?: Map<string, string>
  /** What to take back if it fails, when it is not entries (a topic). */
  undo?: () => void
  message?: string
}

/** One thing the person did: made an entry, changed one, deleted one, or renamed one (with what goes with it). */
export interface Change {
  kind: 'new' | 'changed' | 'removed' | 'renamed'
  /** The entry as it is now (for a renamed one: under its new name; for a deleted one: as it was). */
  entry: Entry
  /** Renamed: where the entry was, how many entries below it moved with it, and how many others got new references. */
  from?: string
  moved?: number
  /** A topic of the contents (its .folder.yaml), not an entry. */
  topic?: boolean
  references?: number
}

/**
 * A renaming as the person did it: what moved (the entry as it was, and the path it has now) and what only got new references (its
 * text before and after). It is what "take back" undoes, and what the list of changes shows as one line (until the page is loaded again).
 */
export interface Rename {
  moves: { before: Entry; to: string }[]
  rewrites: { path: string; before: string; after: string }[]
}

/** More entries than this moving at once are asked about first. */
export const ASK_ABOVE = 5

/** How often the server is asked for news while the page is visible and the live connection is not there. */
export const POLL_MS = 60_000

/** The name of a submission when the person gives none: the day, as the captures of the archive are named. */
export const defaultName = (): string =>
  `Einreichung vom ${new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })}`

/** A submission that can still be changed: a draft, or one that is handed in and waits. */
const isOpen = (c: Submission): boolean => c.state === 'draft' || c.state === 'submitted'

const texts = (entries: { path: string; text: string }[]): Map<string, string> => new Map(entries.map((e) => [e.path, e.text]))

/** How many entries are read at the same time. */
const PARALLEL = 8

/** The names of the topics: the folder of each .folder.yaml of the index, by folder (contents/natur). */
function folderNames(lines: Line[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const line of lines) if (line.type === 'folder') names[line.path.slice(0, line.path.lastIndexOf('/'))] = line.title
  return names
}

const VIEW_KEY = 'contents-editor:view'

/** Where the person was last (kept at once, in the browser's storage), if it is theirs. */
function lastView(login: string): View | undefined {
  try {
    const kept = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as { login?: string; view?: View } | null
    return kept?.login === login ? kept.view : undefined
  } catch {
    return undefined
  }
}

export class Workspace implements Host {
  /** `undefined` until it is known whether somebody is signed in. */
  user = $state<User | null | undefined>(undefined)
  /** The entries as the person sees them: the ones of their draft (or of the base), with what they are typing laid over them. */
  entries = $state<Entry[]>([])
  /** The names of the topic folders of the contents as their .folder.yaml gives them, by folder (contents/natur). */
  folders = $state<Record<string, string>>({})
  /** The branch that is worked on; none: a new draft (it shows the base branch, and the first save makes the branch). */
  branch = $state<string>()
  /** A switch to another branch (or to a new draft) that waits for the answer about what is not saved. */
  switching = $state<{ branch: string | undefined }>()
  /** The submissions as the server has them. */
  submissions = $state<Submission[]>([])
  /** The renamings among the changes (each: the entries that moved, and the ones that got other references). */
  renames = $state<Rename[]>([])
  selectedPath = $state<string>()
  loading = $state(false)
  /** The open entry is being read. */
  opening = $state(false)
  /** Something is being written to the draft. */
  saving = $state(false)
  /** Something went wrong that the person should read. */
  error = $state<string>()
  /** The problems the server found when it refused an entry (the editor shows its own while typing). */
  refused = $state<Issue[]>([])
  /** Whether the live connection is open (if not, the server is asked now and then). */
  liveOpen = $state(false)
  /** Where the person wants an entry to go (its folder, by path), until they are done with it. */
  moveTo = $state<Record<string, string>>({})
  /** The name the draft is to get when it is made (the person changed it before the first save). */
  #wanted = $state('')
  /** The name of the new draft whose branch is made, until the pull request exists. */
  #named = ''
  /** The person chose a branch (or a new draft) themselves: the draft they worked on last is not chosen again for them. */
  #picked = false
  /** How many saves are on their way or wait for their turn. */
  #pending = 0
  /** The commits this editor made itself (the newest ones): the news about them is nothing new. */
  #own: string[] = []
  /** The conversation with the assistant; it lasts as long as the page. */
  chat = $state<ChatMessage[]>([])
  /** The assistant is working on a message. */
  thinking = $state(false)
  /** An entry the assistant changed or made: its form is to be opened, so that the person sees the changes and finishes them. */
  openForm = $state<string>()
  /** A form for making or editing an entry is open (set by the screen): handing in waits until it is closed. */
  formOpen = $state(false)

  /** The names of the topics the base branch has (the draft's are in `folders`). */
  #baseFolders = $state.raw<Record<string, string>>({})

  readonly review: Review
  readonly #api: Api
  /** What the draft has (or the base, while there is no draft), by path: what is not in it is not saved yet. */
  #saved = $state.raw(new Map<string, string>())
  /** What the base branch has: the changes are the difference to it. */
  #base = $state.raw(new Map<string, string>())
  /** The lines of the index the base branch has, by path (what the changes show of an entry that is gone). */
  #baseLines = $state.raw(new Map<string, Line>())
  /** Whether the base was read (it is not asked for again when another submission is opened; news says when it changed). */
  #baseKnown = false
  /** What was read of the repository (also kept in the browser): shown at once, then looked at again. */
  readonly #known = new Known()
  readonly #store: Store
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  /** The place the person is at is only kept once the start has restored the old one. */
  #viewReady = false
  #warming = false
  #warmAgain = false
  #listener: Listener | undefined
  #poll: ReturnType<typeof setInterval> | undefined
  #loading = 0
  #stopWatching: (() => void) | undefined
  /** Writes one after the other. */
  #queue: Promise<unknown> = Promise.resolve()

  readonly #agent: Agent | undefined

  constructor(api: Api, agent?: Agent, store: Store = new MemoryStore()) {
    this.#api = api
    this.#agent = agent
    this.#store = store
    this.review = new Review(api, this)
  }

  /** The open entry, once it is read (an entry that is known from the index only is read when it is opened). */
  selected = $derived.by(() => {
    const found = this.entries.find((e) => e.path === this.selectedPath)
    return found && !found.unloaded ? found : undefined
  })
  /** What is typed and not saved yet. */
  dirty = $derived(this.entries.filter((e) => this.#saved.get(e.path) !== e.text))
  issues = $derived(this.selected ? issuesOf(this.selected, this.entries) : [])

  /** The person's newest draft: the one they come back to. */
  ownDraft = $derived(this.user ? this.submissions.find((c) => c.state === 'draft' && c.author === this.user!.login) : undefined)
  /** The submission of the branch that is worked on, as the server has it (the open one if the branch had several pull requests over time). */
  active = $derived(this.branch === undefined ? undefined : (this.submissions.find((c) => c.branch === this.branch && isOpen(c)) ?? this.submissions.find((c) => c.branch === this.branch)))
  /** The active submission while it is a draft (one that is handed in is not handed in again). */
  draft = $derived(this.active?.state === 'draft' ? this.active : undefined)
  /** Whether changes can be made: somebody is signed in, and the submission is not finished (anybody may change an open one). */
  editable = $derived(this.user != null && (this.active === undefined || isOpen(this.active)))
  /** Why not, in words. */
  readonlyReason = $derived(this.editable ? undefined : this.user ? 'Diese Einreichung ist abgeschlossen, sie lässt sich nicht mehr ändern.' : 'Du bist nicht angemeldet.')
  /** What is typed and not saved, without the new entries that still have their placeholder: switching away asks about it. */
  unsavedWork = $derived(this.dirty.filter((e) => !this.isUntouched(e.path)))

  /** The renamings that are still to be seen as such: all they made is saved and is not in the base. */
  #activeRenames = $derived(this.renames.filter((g) => g.moves.every((m) => this.#saved.has(m.to) && !this.#base.has(m.to))))
  /**
   * The changes against the base: what was renamed, made new, changed and deleted, in this order. A renaming is one change, with all that
   * goes with it. Only what is saved counts: what is still being typed is not a change yet.
   */
  changes = $derived.by<Change[]>(() => {
    const saved = this.#saved
    const base = this.#base
    const entryOf = (path: string): Entry => {
      const open = this.entries.find((e) => e.path === path)
      return open && open.text === saved.get(path) ? open : makeEntry(path, saved.get(path)!, 'saved')
    }
    const part = new Set<string>()
    const renamed: Change[] = []
    for (const g of this.#activeRenames) {
      for (const m of g.moves) part.add(m.to).add(m.before.path)
      for (const r of g.rewrites) part.add(r.path)
      renamed.push({ kind: 'renamed', entry: entryOf(g.moves[0].to), from: g.moves[0].before.path, moved: g.moves.length - 1, references: g.rewrites.length })
    }
    return [
      ...renamed,
      ...[...saved.keys()].filter((p) => !base.has(p) && !part.has(p)).map((p): Change => ({ kind: 'new', entry: entryOf(p) })),
      ...[...saved.keys()].filter((p) => base.has(p) && base.get(p) !== saved.get(p) && !part.has(p)).map((p): Change => ({ kind: 'changed', entry: entryOf(p) })),
      ...[...base].filter(([p]) => !saved.has(p) && !part.has(p)).map(([p, text]): Change => ({ kind: 'removed', entry: isMarker(text) && this.#baseLines.has(p) ? makeStub(this.#baseLines.get(p)!) : makeEntry(p, text, 'base') })),
      // The topics that are not in the base yet.
      ...Object.entries(this.folders).filter(([folder]) => this.#baseFolders[folder] === undefined).map(([folder, title]): Change => ({ kind: 'new', topic: true, entry: makeEntry(`${folder}/.folder.yaml`, `title: ${JSON.stringify(title)}\n`, 'saved') })),
    ]
  })
  /** The entries of the draft that are not finished (a required field is missing, a reference leads nowhere), with what is missing in words. */
  unfinished = $derived.by(() =>
    this.changes.flatMap((c) => {
      const found = c.topic || c.kind === 'removed' ? undefined : this.entries.find((e) => e.path === c.entry.path)
      const entry = found && !found.unloaded ? found : undefined
      const issues = entry ? issuesOf(entry, this.entries) : []
      return entry && issues.length > 0 ? [{ entry, missing: issues.map((i) => describeIssue(entry, i)) }] : []
    }),
  )
  problems = $derived(new Map(this.unfinished.map((u) => [u.entry.path, u.missing] as const)))

  async start(): Promise<void> {
    // Who is signed in is asked for while the browser's store is read: what was kept is shown for the person who was there at once, without
    // waiting for the answer (if they are not signed in any more, the page says so a moment later).
    const asking = this.#api.me().then(
      (user) => ({ user }),
      (error: Error) => ({ error }),
    )
    let shown: string | undefined | null = null
    let view: View | undefined
    let provisional = false
    try {
      const snapshot = await this.#store.load()
      if (snapshot?.user && snapshot.login === snapshot.user.login) {
        provisional = true
        this.user = snapshot.user
        this.#known.restore(snapshot)
        this.submissions = snapshot.submissions
        view = lastView(snapshot.login) ?? snapshot.view
        const back = view?.branch ? this.submissions.find((c) => c.branch === view!.branch && isOpen(c)) : undefined
        if (view) {
          // Back to where the person was: the submission they worked on, or the database.
          this.#picked = true
          this.branch = back?.branch
        } else if (!this.#picked && this.branch === undefined && this.ownDraft) this.branch = this.ownDraft.branch
        const seen = this.#known.recall(this.branch)
        if (seen) {
          this.#show(seen)
          shown = this.branch
        }
        this.#showDetails(view?.detailOpen ?? true)
        // The entry that was open is open again at once, not after the answers of GitHub.
        if (view?.path && this.entries.some((e) => e.path === view!.path)) this.select(view.path)
      }
    } catch {
      this.#known.clear()
    }
    const answer = await asking
    const user = 'user' in answer ? answer.user : null
    if ('error' in answer) this.error = answer.error.message
    if (!user || (provisional && user.login !== this.user?.login)) {
      if (provisional) this.signedOut()
      this.user = user
      if (!user) return
      shown = null
      view = undefined
    } else this.user = user
    await this.loadSubmissions()
    // The submission they were at is not there any more: the database.
    if (this.branch !== undefined && !this.active) this.branch = undefined
    // Without a place to go back to, the person comes back to the draft they worked on.
    if (!this.#picked && this.branch === undefined && this.ownDraft) this.branch = this.ownDraft.branch
    this.#showDetails(view?.detailOpen ?? true)
    await this.load({ quiet: shown !== null && shown === this.branch })
    if (view?.path && this.entries.some((e) => e.path === view!.path)) this.select(view.path)
    this.#viewReady = true
    this.startLive()
    void this.#warm()
  }

  /** The submission that is worked on shows its details (as when it was chosen), also when the page was loaded again. */
  #showDetails(open: boolean): void {
    const active = this.active
    if (this.branch === undefined || !active) return
    this.review.detailOpen = open
    if (this.review.selected !== active.number) void this.review.select(active.number)
  }

  /** Where the person is (kept, so that loading the page again brings them back). */
  rememberView(): void {
    if (!this.user || !this.#viewReady) return
    const view: View = { branch: this.branch ?? null, detailOpen: this.review.detailOpen, path: this.selectedPath }
    this.#known.view = view
    // Written at once (the store follows a moment later): the page may be loaded again right after a click.
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ login: this.user.login, view }))
    } catch {
      // no storage: the store has it
    }
    this.#persist()
  }

  async loadSubmissions(): Promise<void> {
    try {
      this.submissions = await this.#api.submissions()
      this.#known.submissions = this.submissions
      this.#persist()
    } catch (error) {
      this.#fail(error)
      return
    }
    // The submission that is worked on was accepted or closed (here or elsewhere): what is left is the base branch.
    const active = this.active
    if (active && !isOpen(active)) await this.#backToBase()
  }

  /** The entries of the branch that is shown, and (for the own work) the base for the changes. What is typed and not saved stays. */
  async load({ quiet = false, withBase = true, withBranch = true } = {}): Promise<void> {
    const mine = ++this.#loading
    if (!quiet) this.loading = true
    this.error = undefined
    try {
      const from = this.branch
      const head = this.active?.branch === from ? this.active?.head : undefined // asked before the branch is read: what is read is not older
      // The base is asked for as well (the changes are the difference to it), unless it is known not to have changed.
      const [fetched, other] = await Promise.all([withBranch ? this.#api.index(from) : undefined, from !== undefined && withBase ? this.#api.index(undefined) : undefined])
      const base = from === undefined ? fetched : other
      if (mine !== this.#loading) return // another branch was chosen meanwhile
      if (base) {
        this.#known.setBase(base)
        this.#baseKnown = true
      }
      if (fetched && from !== undefined) this.#known.setBranch(from, fetched, head)
      const result = fetched ?? this.#known.recall(from)
      if (!result) return
      this.#persist()
      const before = this.#saved
      this.folders = folderNames(result.entries)
      if (base) this.#takeBase(base)
      const loaded = result.entries.filter((r) => r.type !== 'folder')
      // What the person typed (differs from what the branch had) stays, what they moved away or deleted but did not save stays gone, new entries stay.
      const typed = new Map(this.entries.filter((e) => before.get(e.path) !== e.text).map((e) => [e.path, e]))
      const gone = new Set([...before.keys()].filter((p) => !this.entries.some((e) => e.path === p)))
      const entries = loaded.filter((r) => !gone.has(r.path)).map((r) => typed.get(r.path) ?? this.#entryOf(r))
      for (const e of typed.values()) if (!loaded.some((r) => r.path === e.path)) entries.push(e)
      this.#saved = this.#versions(loaded)
      this.entries = entries.map((e) => (typed.has(e.path) ? e : { ...e, saved: e.text }))
      this.renames = this.renames.filter((g) => g.moves.every((m) => entries.some((e) => e.path === m.to)))
    } catch (error) {
      if (mine === this.#loading) this.#fail(error)
    } finally {
      if (mine === this.#loading) this.loading = false
    }
  }

  /** The entry of a line of the index: read if its text is known (it was opened before), else as far as the index tells. */
  #entryOf(line: Line): Entry {
    const text = this.#known.text(line.sha)
    return text === undefined ? makeStub(line) : makeEntry(line.path, text, line.sha)
  }

  /** What the maps of saved and base texts hold for the lines: the text if it is known, else the marker of its version. */
  #versions(lines: Line[]): Map<string, string> {
    return new Map(lines.map((l) => [l.path, this.#known.text(l.sha) ?? marker(l.sha)]))
  }

  /** The base the changes are measured against. */
  #takeBase(base: Listed): void {
    this.#baseFolders = folderNames(base.entries)
    const lines = base.entries.filter((r) => r.type !== 'folder')
    this.#baseLines = new Map(lines.map((l) => [l.path, l]))
    this.#base = this.#versions(lines)
  }

  /** Shows what was read of a branch before (no waiting; `load` follows with the current state). */
  #show(result: Listed): void {
    this.folders = folderNames(result.entries)
    // The base the changes are measured against (as far as it was read: it is asked for again if it may have changed).
    const base = result.branch === null ? result : this.#known.base
    if (base && this.#base.size === 0) this.#takeBase(base)
    const loaded = result.entries.filter((r) => r.type !== 'folder')
    this.#saved = this.#versions(loaded)
    this.entries = loaded.map((r) => this.#entryOf(r))
  }

  /**
   * Works on another submission (none: on a new draft). What is typed and not saved is asked about first (the screen shows the question
   * while `switching` is set, and answers it with `answerSwitch`); returns whether the switch was made.
   */
  async switchTo(branch: string | undefined, { force = false } = {}): Promise<boolean> {
    this.#picked = true
    if (branch === this.branch) return true
    if (!force && this.unsavedWork.length > 0) {
      this.switching = { branch }
      return false
    }
    this.switching = undefined
    this.branch = branch
    this.entries = []
    this.renames = []
    this.#saved = new Map()
    this.refused = []
    this.moveTo = {}
    this.#wanted = ''
    this.#pristine.clear()
    const seen = this.#known.recall(branch)
    if (seen) this.#show(seen)
    // What is known is right as long as the head is the same (the base: as long as nothing was heard of it); only the rest is asked for.
    const fresh = branch === undefined ? this.#baseKnown : this.#known.valid(branch, this.active?.head)
    // The details of the submission are shown at once (the main branch has none), with what is known; what GitHub says follows.
    const selecting = this.review.select(this.active?.number)
    this.review.detailOpen = branch !== undefined
    if (!seen || !fresh || !this.#baseKnown) await this.load({ quiet: seen !== undefined, withBase: !this.#baseKnown, withBranch: !seen || !fresh })
    if (this.selectedPath && !this.entries.some((e) => e.path === this.selectedPath)) this.selectedPath = undefined
    await selecting
    return true
  }

  /** The answer to the question about what is not saved: save it (and switch if that worked), throw it away (and switch), or stay. */
  async answerSwitch(answer: 'save' | 'discard' | 'stay'): Promise<void> {
    const target = this.switching
    if (!target) return
    if (answer === 'stay') {
      this.switching = undefined
      return
    }
    if (answer === 'save' && !(await this.finish())) {
      this.switching = undefined // what is wrong is in `error`
      return
    }
    await this.switchTo(target.branch, { force: true })
  }

  /** The branch that was worked on is finished (accepted, closed): the base branch is shown, with what was typed still there. */
  async #backToBase(): Promise<void> {
    this.branch = undefined
    this.renames = []
    this.review.detailOpen = false
    await this.review.select(undefined)
    await this.load({ quiet: true })
  }

  /** Opens an entry (or none). Returns when it is read: an entry that is known from the index only is read from the server first. */
  select(path: string | undefined): Promise<void> {
    this.selectedPath = path
    this.#dropPristine(path)
    this.refused = []
    return path ? this.ensure([path], true) : Promise.resolve()
  }

  /**
   * Reads the entries that are known from the index only (a few at a time), together with what the base has of them, so that changes and
   * "take back" know both. Whoever needs the text of entries (to open, rename, delete or change them) calls this first.
   */
  async ensure(paths: string[], opening = false): Promise<void> {
    const todo = [...new Set(paths)].filter((p) => this.entries.find((e) => e.path === p)?.unloaded)
    if (todo.length === 0) return
    if (opening) this.opening = true
    try {
      for (let i = 0; i < todo.length; i += PARALLEL) await Promise.all(todo.slice(i, i + PARALLEL).map((p) => this.#read(p)))
    } catch (error) {
      this.#fail(error)
    } finally {
      if (opening) this.opening = false
    }
  }

  /** Reads an entry with what renaming it touches: the entries below it and the ones that refer to it or to them. */
  async ensureAround(path: string): Promise<void> {
    await this.ensure([path])
    const entry = this.entries.find((e) => e.path === path)
    const type = entry && typeOf(entry)
    if (!entry || !type) return
    const below = MODEL.types[type].class === 'entity' ? this.entries.filter((e) => e.path.startsWith(`${MODEL.types[type].dir}/${idOf(entry)}/`)) : []
    const ids = new Set([idOf(entry), ...below.map(idOf)])
    await this.ensure([...below.map((e) => e.path), ...this.entries.filter((e) => refsIn(e).some((id) => ids.has(id))).map((e) => e.path)])
  }

  async #read(path: string): Promise<void> {
    const stub = this.entries.find((e) => e.path === path)
    if (!stub?.unloaded || !stub.sha) return
    let sha = stub.sha
    let text = this.#known.text(sha)
    if (text === undefined) {
      const fetched = await this.#api.entry(path, this.branch)
      if (!fetched) throw new Error(`Den Eintrag „${path}“ gibt es nicht mehr. Lade die Einträge neu.`)
      sha = fetched.sha
      text = fetched.text
      this.#known.keepText(sha, text)
      this.#persist()
    }
    // The base has the same version, or its text is asked for too (the changes need both).
    const baseMark = this.#base.get(path)
    if (baseMark !== undefined && isMarker(baseMark)) await this.#readBase(path, baseMark === marker(stub.sha) ? text : undefined)
    // Meanwhile the entry may have been changed or replaced: then what was read is not wanted.
    const now = this.entries.find((e) => e.path === path)
    if (!now?.unloaded || now.sha !== stub.sha) return
    const read = makeEntry(path, text, sha)
    this.entries = this.entries.map((e) => (e.path === path ? read : e))
    if (this.#saved.get(path) === marker(stub.sha)) this.#saved = new Map(this.#saved).set(path, text)
  }

  /** The text of the base's version of an entry (`known` if it is already at hand). */
  async #readBase(path: string, known?: string): Promise<void> {
    const mark = this.#base.get(path)
    if (mark === undefined || !isMarker(mark)) return
    let text = known
    if (text === undefined) {
      text = this.#known.text(mark.slice(1))
      if (text === undefined) {
        const fetched = await this.#api.entry(path, undefined)
        if (!fetched) return
        text = fetched.text
        this.#known.keepText(fetched.sha, text)
      }
    }
    if (this.#base.get(path) === mark) this.#base = new Map(this.#base).set(path, text)
  }

  /** New entries with a placeholder for a name, as long as nothing was changed: texts as they were made, by path. */
  #pristine = new Map<string, string>()

  /** A new entry that was left again without a change is not wanted: it goes (the one that is chosen now stays). */
  #dropPristine(keep: string | undefined): void {
    const gone = this.entries.filter((e) => e.path !== keep && this.#pristine.get(e.path) === e.text && !this.#saved.has(e.path))
    if (gone.length === 0) return
    this.entries = this.entries.filter((e) => !gone.includes(e))
    for (const e of gone) this.#pristine.delete(e.path)
  }

  /** Replaces the text of the open entry (typed in the YAML, or made by a field). */
  edit(text: string): void {
    if (!this.editable) return
    this.entries = this.entries.map((e) => (e.path === this.selectedPath ? withText(e, text) : e))
    this.refused = []
  }

  /** Whether a new entry still has the placeholder name and nothing else was changed. */
  isUntouched(path: string): boolean {
    return this.#pristine.get(path) === this.entries.find((e) => e.path === path)?.text
  }

  /** Whether the entry was never saved (made here, not in the draft or the database yet). */
  isNew(path: string): boolean {
    return !this.#saved.has(path)
  }

  /** Makes a new entry and opens it. With `numbered`, an id that is in use gets a number; otherwise that is an error. */
  create(type: EntryType, label: string, folder?: string, options: { parent?: string; kind?: string; numbered?: boolean; placeholder?: boolean } = {}): void {
    if (!this.editable) throw new Error(this.readonlyReason)
    const used = (id: string) => this.entries.some((e) => idOf(e) === id)
    let entry = newEntry(type, label, folder, undefined, { parent: options.parent, kind: options.kind, taken: options.numbered ? used : undefined })
    if (used(idOf(entry)) || this.entries.some((e) => e.path === entry.path)) throw new Error(`Es gibt schon einen Eintrag mit der ID „${idOf(entry)}“.`)
    // With a placeholder, the label only gives the file a name for now; the name field starts empty and the file follows what is typed.
    if (options.placeholder) {
      const blanked = setField(entry.text, nameFieldOf(type), '', entry.data?.[nameFieldOf(type)])
      if (blanked.ok) entry = withText(entry, blanked.text)
    }
    this.entries = [...this.entries, entry]
    if (options.placeholder) this.#pristine.set(entry.path, entry.text)
    this.select(entry.path)
  }

  // --- writing ---

  /** The name of the draft: what the person made of it, or the one of the day, numbered if the name is used. */
  #nameForNew(login: string): string {
    const taken = (candidate: string) => this.submissions.some((c) => c.branch === submissionBranch(login, candidate) && c.state !== 'merged' && c.state !== 'closed')
    const wanted = this.#wanted.trim()
    if (wanted) return wanted
    const base = defaultName()
    let name = base
    for (let n = 2; taken(name); n++) name = `${base} (${n})`
    return name
  }

  /**
   * Writes what is not saved to the active submission as ONE commit (which makes the submission with its pull request if there is none
   * yet): the entries that are new or changed, and the ones that are gone. With `wait` it returns when that is done on the server and
   * says whether it worked. Without, it returns as soon as what was typed counts as saved here: the commit follows in the background,
   * and if it fails, that is taken back (the entries are unsaved again, `error` says why).
   */
  async sync({ wait = true }: { wait?: boolean } = {}): Promise<boolean> {
    if (wait) await this.#queue
    const job = this.#plan()
    if (job === 'refused') return false
    if (job === 'none') return true
    const run = this.#enqueue(job)
    return wait ? run : true
  }

  /** Puts a save into the queue: they are sent one after the other. */
  #enqueue(job: Job): Promise<boolean> {
    this.#pending++
    this.saving = true
    const run = this.#queue.then(() => this.#commit(job))
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** The submission a save goes to: the active one, or the one that is made with the save (which then is the active one). */
  #submissionRef(): SubmissionRef {
    if (this.active) return { branch: this.active.branch, name: this.active.name }
    // The branch was made by an earlier save, but GitHub has no pull request for it yet (it did not differ from the base).
    if (this.branch !== undefined) return { branch: this.branch, name: this.#named || this.#wanted.trim() || defaultName() }
    const name = this.#nameForNew(this.user!.login)
    this.#named = name
    return { branch: submissionBranch(this.user!.login, name), name }
  }

  /**
   * Makes a topic of the contents: its .folder.yaml (with the name shown on screen) is written to the active submission, which also lets
   * the topic exist while nothing is filed in it. It counts at once; the write follows in the background (and is taken back if it fails).
   * Returns the folder of the topic (`contents/<slug>`); throws what is wrong in words.
   */
  async createTopic(title: string): Promise<string> {
    if (!this.editable) throw new Error(this.readonlyReason)
    const name = title.replace(/\s+/g, ' ').trim()
    const slug = slugify(name)
    if (!slug) throw new Error('Der Name ergibt keinen gültigen Ordnernamen: mindestens ein Buchstabe oder eine Ziffer.')
    const folder = `contents/${slug}`
    if (this.folders[folder] !== undefined || this.entries.some((e) => e.path.startsWith(`${folder}/`)) || Object.values(this.folders).some((t) => t.toLowerCase() === name.toLowerCase())) throw new Error(`Ein Thema „${name}“ gibt es schon.`)
    const job: Job = {
      writes: [{ path: `${folder}/.folder.yaml`, text: `title: ${JSON.stringify(name)}\n` }],
      removals: [],
      ref: this.#submissionRef(),
      made: this.branch === undefined,
      message: `Add topic ${name}`,
      undo: () => {
        const { [folder]: _gone, ...rest } = this.folders
        this.folders = rest
      },
    }
    this.error = undefined
    this.branch = job.ref.branch
    this.folders = { ...this.folders, [folder]: name }
    void this.#enqueue(job)
    return folder
  }

  /** Takes a topic back: its .folder.yaml is removed from the active submission (only while nothing is filed in it). */
  #discardTopic(path: string): Promise<void> {
    const folder = path.slice(0, path.lastIndexOf('/'))
    if (this.entries.some((e) => e.path.startsWith(`${folder}/`))) {
      this.error = 'In dem Thema liegen noch Einträge.'
      return Promise.resolve()
    }
    const title = this.folders[folder]
    const { [folder]: _gone, ...rest } = this.folders
    this.folders = rest
    void this.#enqueue({
      writes: [],
      removals: [path],
      ref: this.#submissionRef(),
      made: false,
      message: `Remove topic ${folder}`,
      undo: () => {
        if (title !== undefined) this.folders = { ...this.folders, [folder]: title }
      },
    })
    return Promise.resolve()
  }

  /** What a save writes, and what the editor looks like once it counts as saved. 'none': nothing to write; 'refused': it cannot be written (`error` says why). */
  #plan(): Job | 'none' | 'refused' {
    if (!this.editable) return 'refused'
    const writes = this.entries.filter((e) => this.#saved.get(e.path) !== e.text)
    const removals = [...this.#saved.keys()].filter((p) => !this.entries.some((e) => e.path === p))
    if (writes.length === 0 && removals.length === 0) return 'none'
    const bad = writes.find((e) => !e.data)
    if (bad) {
      this.select(bad.path)
      this.error = `Das YAML von „${shownTitle(bad)}“ ist kaputt, so lässt es sich nicht speichern.`
      return 'refused'
    }
    const job: Job = { writes: writes.map((e) => ({ path: e.path, text: e.text })), removals, ref: this.#submissionRef(), made: this.branch === undefined, before: this.#saved }
    this.error = undefined
    this.refused = []
    this.branch = job.ref.branch
    this.#saved = texts(this.entries)
    this.entries = this.entries.map((e) => (e.unloaded ? e : { ...e, saved: e.text, sha: 'saved' }))
    this.#wanted = ''
    return job
  }

  /** Sends what `#plan` made to the server. If that fails, the entries are unsaved again. */
  async #commit(job: Job): Promise<boolean> {
    try {
      const result = await this.#api.commit(job.writes, job.removals, job.ref, job.message)
      if (result.commit) this.#own = [...this.#own, result.commit].slice(-20)
      this.#known.forget(job.ref.branch)
    } catch (error) {
      const before = job.before
      if (job.undo) job.undo()
      else if (before) {
        this.#saved = before
        this.entries = this.entries.map((e) => (e.unloaded ? e : before.has(e.path) ? { ...e, saved: before.get(e.path)! } : { ...e, sha: e.sha === 'saved' ? undefined : e.sha }))
      }
      if (error instanceof ApiError && error.issues.length > 0) this.refused = error.issues
      this.#fail(error)
      return false
    } finally {
      if (--this.#pending === 0) this.saving = false
    }
    await this.loadSubmissions()
    // The submission that the first save made is the one worked on: its details are the ones kept up to date.
    if (job.made && this.active) await this.review.select(this.active.number)
    await this.#closeIfEmpty()
    return true
  }

  /** A draft that does not differ from the base any more (everything was taken back) has no use: it is closed. */
  async #closeIfEmpty(): Promise<void> {
    const draft = this.draft
    if (!draft || this.changes.length > 0) return
    try {
      await this.#api.close(draft.number)
      this.#saved = new Map(this.#base)
      this.branch = undefined
      await this.loadSubmissions()
    } catch (error) {
      this.#fail(error)
    }
  }

  /**
   * The person is done with the open entry: the id and the file follow its name (see `renameOpen`), and what is typed is saved. Returns
   * whether that worked; if not, `error` says why.
   */
  async finish(confirm?: (moving: number) => boolean, options: { wait?: boolean } = {}): Promise<boolean> {
    if (this.editable && this.selected) {
      await this.#prepareRename(this.selected)
      const error = this.renameOpen(confirm)
      if (error) {
        this.error = error
        return false
      }
    }
    return this.sync(options)
  }

  /**
   * What the entry's name makes of its id and file. An entry that was saved keeps its id unless its name was changed (or a folder was
   * chosen): an id that never came from the name is not touched by a change of something else.
   */
  #planFor(entry: Entry): RenamePlan | undefined {
    const type = typeOf(entry)
    const saved = this.#saved.get(entry.path)
    if (type && saved !== undefined && !(entry.path in this.moveTo) && readValue(saved, nameFieldOf(type)) === entry.data?.[nameFieldOf(type)]) return undefined
    return planRename(entry, this.entries, (path) => this.entries.some((e) => e.path === path), this.moveTo[entry.path])
  }

  /** What a renaming rewrites must be read: the entries that move with the entry, and the ones that refer to any of them. */
  async #prepareRename(entry: Entry): Promise<void> {
    let plan: RenamePlan | undefined
    try {
      plan = this.#planFor(entry)
    } catch {
      return // renameOpen says what is wrong
    }
    if (plan) await this.ensure(plan.unread)
  }

  /** Where the open entry would go with its name as it is typed now (nothing is changed), or what is wrong with it. */
  previewRename(): { path?: string; error?: string } {
    const entry = this.selected
    if (!entry || !this.editable) return {}
    try {
      return { path: this.#planFor(entry)?.moves[0].after.path }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  /** Deletes the open entry (saved at once, unless it was never saved). */
  async remove(): Promise<boolean> {
    const entry = this.selected
    if (!entry || !this.editable) return false
    this.renames = this.renames.filter((g) => !g.moves.some((m) => m.to === entry.path))
    await this.ensure(this.#referrers(entry))
    // The references to it go with it (they are changes of their own, which show in the list).
    const cleaned = new Map(planRemoval(entry, this.entries).map((c) => [c.before.path, c.after]))
    this.entries = this.entries.filter((e) => e.path !== entry.path).map((e) => cleaned.get(e.path) ?? e)
    this.select(undefined)
    return this.sync({ wait: false })
  }

  /** How many other entries refer to an entry (deleting it takes the references out of them). */
  referencesTo(path: string): number {
    const entry = this.entries.find((e) => e.path === path)
    return entry ? this.#referrers(entry).length : 0
  }

  /** The paths of the other entries that refer to an entry (the index knows that without reading them). */
  #referrers(entry: Entry): string[] {
    const id = idOf(entry)
    return this.entries.filter((e) => e !== entry && refsIn(e).includes(id)).map((e) => e.path)
  }

  /** Takes a change back (and saves that): a new entry disappears, a changed one is as the base has it, a deleted one is there again. */
  async discard(path: string): Promise<void> {
    if (!this.editable) return
    if (FOLDER_PATH.test(path)) return this.#discardTopic(path)
    const group = this.renames.find((g) => g.moves.some((m) => m.to === path) || g.moves.some((m) => m.before.path === path))
    if (group) {
      // What the renaming touched is read, with the texts the base has of it.
      const paths = [...group.moves.map((m) => m.before.path), ...group.rewrites.map((r) => r.path)]
      await this.ensure(paths)
      await Promise.all(paths.map((p) => this.#readBase(p)))
      this.#undoRename(group, this.#base)
    } else if (!this.entries.some((e) => e.path === path)) {
      await this.#readBase(path)
      const text = this.#base.get(path)
      if (text !== undefined && !isMarker(text)) {
        const restored = makeEntry(path, text, 'base')
        // The references that were taken out with it come back too (where nothing else was changed in them since).
        const id = idOf(restored)
        const referring = [...this.#baseLines.values()].filter((l) => l.refs?.includes(id)).map((l) => l.path)
        await this.ensure(referring)
        await Promise.all(referring.map((p) => this.#readBase(p)))
        const others = referring.flatMap((p) => (isMarker(this.#base.get(p)) ? [] : [makeEntry(p, this.#base.get(p)!, 'base')]))
        const back = new Map(planRemoval(restored, others).map((c) => [c.before.path, c]))
        this.entries = [...this.entries, restored].map((e) => {
          const c = back.get(e.path)
          return c && c.after.text === e.text ? withText(e, c.before.text) : e
        })
      }
    } else if (!this.#base.has(path)) {
      this.entries = this.entries.filter((e) => e.path !== path)
      if (this.selectedPath === path) this.select(undefined)
    } else {
      await this.#readBase(path)
      const text = this.#base.get(path)
      if (text !== undefined && !isMarker(text)) this.entries = this.entries.map((e) => (e.path === path ? withText(e, text) : e))
    }
    this.refused = []
    await this.sync()
  }

  /** Takes back what is typed in the open entry and was not saved (a renaming that was not saved is taken back with it). */
  revert(): void {
    const path = this.selectedPath
    if (!path || !this.editable) return
    this.#clearMove(path)
    const group = this.renames.find((g) => g.moves.some((m) => m.to === path))
    const kept = this.#saved.get(path)
    if (group) this.#undoRename(group, this.#saved)
    else if (kept === undefined) {
      this.entries = this.entries.filter((e) => e.path !== path)
      this.select(undefined)
    } else if (!isMarker(kept)) this.entries = this.entries.map((e) => (e.path === path ? withText(e, kept) : e))
    this.refused = []
  }

  /**
   * The open entry follows its name: its id and file are made new from it, what lies below it moves with it, and the references to all of
   * these are rewritten. Called when the person is done (`finish`), not while typing. Returns what is wrong in words
   * (and then nothing is changed), or nothing. `confirm` is asked how many entries move if that is more than a few; false stops it.
   */
  renameOpen(confirm: (moving: number) => boolean = () => true): string | undefined {
    const entry = this.selected
    if (!entry || !this.editable) return undefined
    let plan: RenamePlan | undefined
    try {
      plan = this.#planFor(entry)
    } catch (error) {
      return (error as Error).message
    }
    if (!plan) {
      this.#clearMove(entry.path)
      return undefined
    }
    if (plan.unread.length > 0) return 'Es sind noch nicht alle betroffenen Einträge gelesen. Versuch es gleich noch einmal.'
    if (plan.moves.length > ASK_ABOVE && !confirm(plan.moves.length)) return 'Nicht umbenannt.'
    this.#applyRename(plan)
    this.#clearMove(entry.path)
    this.selectedPath = plan.moves[0].after.path
    this.refused = []
    return undefined
  }

  #clearMove(path: string): void {
    if (path in this.moveTo) {
      const { [path]: _gone, ...rest } = this.moveTo
      this.moveTo = rest
    }
  }

  /** The folder the open entry is to go to (done with `finish`; shown as the file name meanwhile). */
  setFolder(folder: string): void {
    const entry = this.selected
    if (!entry || !this.editable) return
    if (folder.trim() === folderOf(entry)) this.#clearMove(entry.path)
    else this.moveTo = { ...this.moveTo, [entry.path]: folder }
  }

  /** The folder the open entry is in, or the one it is to go to. */
  folderOpen = $derived(this.selected ? (this.moveTo[this.selected.path] ?? folderOf(this.selected)) : '')

  /** The folders there are for an entity type. */
  folderChoices(type: Parameters<typeof foldersOf>[0]): string[] {
    return foldersOf(type, this.entries)
  }

  /** Moves the entries and rewrites the references, and keeps track of it: one renaming per entry, however often it is renamed. */
  #applyRename(plan: RenamePlan): void {
    let entries = this.entries.filter((e) => !plan.moves.some((m) => m.before.path === e.path))
    for (const m of plan.moves) entries.push(m.after)
    for (const r of plan.rewrites) entries = entries.map((e) => (e.path === r.before.path ? withText(e, r.after.text) : e))
    this.entries = entries

    // The renaming this continues (the entry was renamed before), or a new one.
    const known = this.renames.find((g) => g.moves.some((m) => m.to === plan.moves[0].before.path))
    const group: Rename = known ?? { moves: [], rewrites: [] }
    for (const m of plan.moves) {
      const i = group.moves.findIndex((x) => x.to === m.before.path)
      if (i < 0) group.moves.push({ before: m.before, to: m.after.path })
      else if (group.moves[i].before.path === m.after.path) group.moves.splice(i, 1)
      else group.moves[i] = { before: group.moves[i].before, to: m.after.path }
    }
    for (const r of plan.rewrites) {
      const i = group.rewrites.findIndex((x) => x.path === r.before.path)
      if (i < 0) group.rewrites.push({ path: r.before.path, before: r.before.text, after: r.after.text })
      else if (group.rewrites[i].before === r.after.text) group.rewrites.splice(i, 1)
      else group.rewrites[i] = { ...group.rewrites[i], after: r.after.text }
    }
    // A renaming that is back where it started is none any more.
    this.renames = (known ? this.renames : [...this.renames, group]).filter((g) => g.moves.length > 0)
  }

  /** Takes a renaming back: the entries are where and as `source` (the saved texts, or the base) has them, the references as before. */
  #undoRename(group: Rename, source: ReadonlyMap<string, string>): void {
    const to = new Set(group.moves.map((m) => m.to))
    this.entries = this.entries.filter((e) => !to.has(e.path))
    for (const m of group.moves) {
      const text = source.get(m.before.path)
      if (text !== undefined) this.entries = [...this.entries, makeEntry(m.before.path, text, 'saved')]
      else if (m.before.sha === undefined) this.entries = [...this.entries, m.before]
    }
    for (const r of group.rewrites) this.entries = this.entries.map((e) => (e.path === r.path && e.text === r.after ? withText(e, source.get(r.path) ?? r.before) : e))
    this.renames = this.renames.filter((g) => g !== group)
    if (this.selectedPath && to.has(this.selectedPath)) this.selectedPath = group.moves[0].before.path
  }

  // --- the draft as a submission ---

  /** The name of the draft changed (the person left the field): the pull request gets it, or the draft will when it is made. */
  async rename(name: string): Promise<void> {
    const named = name.replace(/\s+/g, ' ').trim()
    if (!named) return
    const active = this.active
    if (!active || !isOpen(active)) {
      this.#wanted = named
      return
    }
    if (named === active.name) return
    try {
      await this.#api.rename(active.number, named)
      await this.loadSubmissions()
    } catch (error) {
      this.#fail(error)
    }
  }

  /** The submission is proposed: it is not a draft any more, and the team may accept it (what is typed is saved first). Returns whether it worked. */
  async submit(): Promise<boolean> {
    if (!(await this.sync())) return false
    const draft = this.draft
    if (!draft) return false
    try {
      await this.#api.submit(draft.number)
      await this.loadSubmissions()
      // It stays the one that is worked on (it is not a draft any more); its details are shown, so that it is clear what became of it.
      await this.review.select(draft.number)
      this.review.detailOpen = true
      return true
    } catch (error) {
      this.#fail(error)
      return false
    }
  }

  /** A submission was accepted (here or elsewhere): the base branch changed, and the changes shown are the difference to it. */
  async accepted(submission: Submission): Promise<void> {
    this.#known.forget(submission.branch)
    this.#baseKnown = false
    if (submission.branch === this.branch) await this.#backToBase()
    else await this.load({ quiet: true })
  }

  /** Works on a submission that is not finished (somebody else's too). Returns whether the switch was made (see `switchTo`). */
  work(submission: Submission): Promise<boolean> {
    return this.switchTo(submission.branch)
  }

  /** News from the server (or the clock): what changed is asked for again. Without details everything is. */
  async news(news?: News): Promise<void> {
    if (!this.user) return
    if (news?.head && this.#own.includes(news.head)) return // what this editor wrote itself: it knows
    if (news?.branch !== undefined) this.#known.forget(news.branch)
    // Heard of the base (or of everything): it is read again; what is known of the branches stays right (a branch does not change with the base).
    if (!news || news.type === 'push') this.#baseKnown = false
    await this.loadSubmissions()
    await this.review.news(news)
    // The base changed (somebody's submission was accepted), or the submission that is worked on did: its entries are asked for again.
    const base = !news || news.type === 'push'
    const mine = news?.type === 'pull' && (news.branch !== undefined ? news.branch === this.branch : news.number !== undefined && news.number === this.active?.number)
    if (base || mine) await this.load({ quiet: true, withBase: base })
    void this.#warm()
  }

  /** The person asked for everything again. */
  async reload(): Promise<void> {
    await Promise.all([this.loadSubmissions(), this.load(), this.review.news()])
  }

  /** Listens to the server, and asks it now and then while the connection is not there. */
  startLive(): void {
    if (this.#listener) return
    this.#listener = this.#api.listen(
      (news) => void this.news(news),
      (open) => (this.liveOpen = open),
    )
    this.#poll = setInterval(() => {
      if (!this.liveOpen && (typeof document === 'undefined' || document.visibilityState === 'visible')) void this.news()
    }, POLL_MS)
    if (typeof document !== 'undefined') {
      const back = () => {
        if (document.visibilityState === 'visible') {
          this.#listener?.nudge()
          void this.news()
        }
      }
      const online = () => this.#listener?.nudge()
      document.addEventListener('visibilitychange', back)
      window.addEventListener('online', online)
      this.#stopWatching = () => {
        document.removeEventListener('visibilitychange', back)
        window.removeEventListener('online', online)
      }
    }
  }

  stopLive(): void {
    this.#listener?.stop()
    this.#listener = undefined
    clearInterval(this.#poll)
    this.#stopWatching?.()
    this.#stopWatching = undefined
    this.liveOpen = false
  }

  async logout(): Promise<void> {
    this.stopLive()
    await this.#api.logout().catch(() => undefined)
    this.signedOut()
  }

  signedOut(): void {
    this.stopLive()
    clearTimeout(this.#saveTimer)
    this.#known.clear()
    this.#baseKnown = false
    this.#viewReady = false
    try {
      localStorage.removeItem(VIEW_KEY)
    } catch {
      // no storage
    }
    void this.#store.clear().catch(() => undefined)
    this.user = null
    this.entries = []
    this.renames = []
    this.#saved = new Map()
    this.#base = new Map()
    this.#baseLines = new Map()
    this.submissions = []
    this.branch = undefined
    this.switching = undefined
    this.#picked = false
    this.select(undefined)
  }

  // --- what is known ---

  /** The known state is kept in the store a moment after the last change (not at every one). */
  #persist(): void {
    if (!this.user) return
    clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => {
      if (this.user) void this.#store.save(this.#known.snapshot(this.user)).catch(() => undefined)
    }, 500)
  }

  /**
   * The open submissions that are not known (or not any more) are read in the background, two at a time, so that opening one needs
   * no waiting. What goes wrong here is not shown: it is read again when the submission is opened.
   */
  async #warm(): Promise<void> {
    if (this.#warming) {
      this.#warmAgain = true
      return
    }
    this.#warming = true
    try {
      do {
        this.#warmAgain = false
        if (!this.user || !this.#known.base) return
        const todo = this.submissions.filter((c) => isOpen(c) && c.branch !== this.branch && !this.#known.valid(c.branch, c.head))
        let next = 0
        const work = async () => {
          while (next < todo.length && this.user) {
            const c = todo[next++]
            try {
              const [result, comments] = await Promise.all([this.#api.index(c.branch), this.#api.comments(c.number)])
              if (!this.user) return
              if (result.exists) this.#known.setBranch(c.branch, result, c.head)
              this.#known.comments.set(c.number, comments)
              this.#persist()
            } catch {
              // read again when it is opened
            }
          }
        }
        await Promise.all([work(), work()])
      } while (this.#warmAgain)
    } finally {
      this.#warming = false
    }
  }

  /** What the active submission does to the entries, worked out here: the base against what the branch has (saved). */
  #activeItems = $derived.by<{ number: number; items: SubmissionItem[] } | undefined>(() => {
    const active = this.active
    if (!active || active.branch !== this.branch || this.loading || !this.#known.base) return undefined
    const base = this.#base
    const saved = this.#saved
    const items: SubmissionItem[] = []
    for (const path of [...new Set([...base.keys(), ...saved.keys()])].sort()) {
      const was = base.get(path)
      const is = saved.get(path)
      if (was === is) continue
      items.push({ path, kind: was === undefined ? 'added' : is === undefined ? 'removed' : 'modified', ...(was !== undefined ? { before: was } : {}), ...(is !== undefined ? { after: is } : {}) })
    }
    // An entry that was not read has no text to show: the review asks the server for those.
    if (items.some((i) => isMarker(i.before) || isMarker(i.after))) return undefined
    return { number: active.number, items }
  })

  /** For the review: the changes of a submission, if the workspace has its entries. */
  items(number: number): SubmissionItem[] | undefined {
    const found = this.#activeItems
    return found?.number === number ? found.items : undefined
  }

  kept(number: number): Comment[] | undefined {
    return this.#known.comments.get(number)
  }

  keep(number: number, comments: Comment[]): void {
    this.#known.comments.set(number, comments)
    this.#persist()
  }

  // --- the assistant ---

  /** The entities with their id and name: what the assistant sets references to. */
  #entityIndex(): IndexEntry[] {
    return this.entries.flatMap((e) => {
      const type = typeOf(e)
      return type && MODEL.types[type].class === 'entity' ? [{ id: idOf(e), type, name: titleOf(e) }] : []
    })
  }

  /** What is going on, as the assistant gets to know it. */
  #appState(): AppState {
    const own = this.active?.number
    return {
      viewing: this.active && this.active.author !== this.user?.login ? this.active.name : null,
      draft: this.active ? { name: this.active.name, state: this.active.state } : null,
      unsaved: this.dirty.map((e) => e.path),
      changes: this.changes.length,
      submissions: this.submissions
        .filter((c) => c.number !== own && (c.state === 'submitted' || c.state === 'draft'))
        .slice(0, 60)
        .map((c) => ({ number: c.number, name: c.name, author: c.author, state: c.state })),
    }
  }

  /** Replaces the text of an entry (the assistant's changes; like typing it). */
  setTextOf(path: string, text: string): void {
    this.entries = this.entries.map((e) => (e.path === path ? withText(e, text) : e))
    this.refused = []
  }

  /**
   * The person wrote to the assistant. It answers with calls, which are carried out (see chat.ts). If it only looked things up, it is
   * asked again with the answers, up to a few rounds. Changes to entries are unsaved ("Fertig" saves them); what is hard to take back
   * waits for the person's button.
   */
  async send(message: string): Promise<void> {
    const text = message.trim()
    if (!text || this.thinking) return
    const history = this.chat.filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant').slice(-20).map(({ role, text }) => ({ role, text }))
    this.chat.push({ role: 'user', text })
    if (!this.#agent) {
      this.chat.push({ role: 'status', text: 'Der Chat ist hier nicht eingerichtet.' })
      return
    }
    this.thinking = true
    const trail: TrailStep[] = []
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const open = this.selected
        const calls = await this.#agent.respond({
          message: text,
          entry: open ? { path: open.path, id: idOf(open), text: open.text } : null,
          index: this.#entityIndex(),
          app: this.#appState(),
          history,
          trail: [...trail],
        })
        const outcome = await carryOut(calls, open?.path, this)
        this.chat.push(...outcome.messages)
        if (outcome.show) this.openForm = outcome.show
        if (!outcome.more) return
        const ids = calls.map((c, i) => c.id ?? `call_${step}_${i}`)
        trail.push({
          calls: calls.map(({ id: _id, tool, ...input }, i) => ({ id: ids[i], tool, input })),
          results: outcome.results.map((result, i) => ({ id: ids[i], text: result })),
        })
      }
      this.chat.push({ role: 'status', text: 'Das war mir zu viel Hin und Her. Sag mir bitte genauer, was ich tun soll.' })
    } catch (error) {
      if (error instanceof SignedOut) this.#fail(error)
      this.chat.push({ role: 'status', text: `Das hat nicht geklappt: ${(error as Error).message}` })
    } finally {
      this.thinking = false
    }
  }

  /** The person pressed the button of a question in the chat. */
  async confirm(message: ChatMessage): Promise<void> {
    const pending = message.pending
    if (!pending || pending.state !== 'open') return
    pending.state = 'running'
    try {
      this.chat.push({ role: 'status', text: await pending.run() })
    } catch (error) {
      if (error instanceof SignedOut) this.#fail(error)
      this.chat.push({ role: 'status', text: `Das hat nicht geklappt: ${(error as Error).message}` })
    }
    pending.state = 'done'
  }

  /** The person does not want what a question in the chat asks. */
  dismiss(message: ChatMessage): void {
    if (message.pending?.state === 'open') message.pending.state = 'dismissed'
  }

  /** Starts the conversation afresh. */
  clearChat(): void {
    if (!this.thinking) this.chat = []
  }

  #fail(error: unknown): void {
    if (error instanceof SignedOut) {
      this.signedOut()
      this.error = error.message
    } else if (error instanceof ApiError && error.conflict) {
      this.error = error.message.includes('abgeschlossen')
        ? error.message
        : 'Der Eintrag wurde inzwischen anderswo geändert. Lade die Einträge neu (deine Änderungen bleiben erhalten) und speichere noch einmal.'
    } else this.error = (error as Error).message
  }
}
