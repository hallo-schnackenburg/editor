// A stand-in for the server: the example entries of core's tests, kept in memory (gone on reload). With `npm run dev:fake`
// the editor can be tried without GitHub, the Worker and a sign-in. It works as the Worker does: a submission is a branch and
// a pull request, saving checks what it saves, a draft is submitted, accepted (squashed into main) or closed.
// Somebody else (bernd) has a submission waiting, so there is something to look at in the list of submissions.

import { FOLDER_PATH, authorOf, indexEntry, checkPath, isSubmissionBranch, readObject, validateEntryYaml, validateFolderYaml } from '@contents-editor/core'
import { ApiError, type Api, type Submission, type SubmissionDetail, type SubmissionItem, type SubmissionRef, type Comment, type EntriesResult, type IndexResult, type RemoteEntry, type Listener, type News, type User } from './api.js'

const SEED = import.meta.glob('../../core/test/fixtures/examples/**/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const sha = (text: string) => `fake-${text.length}-${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`

type Files = Map<string, string>

interface Pull {
  submission: Submission
  /** What main was when the submission was started: what "before" means. */
  start: Files
  comments: Comment[]
}

export class FakeApi implements Api {
  private main: Files
  private branches = new Map<string, Files>()
  private pulls: Pull[] = []
  private listeners = new Set<(news?: News) => void>()
  /** What accepted submissions looked like at the end (their branch is gone). */
  private merged = new Map<number, Files>()

  /** `seed` is path (below the repository root) to text; without it the examples of core's tests. */
  constructor(seed?: Record<string, string>) {
    this.main = new Map(seed ? Object.entries(seed) : Object.entries(SEED).map(([path, text]) => [path.replace(/^.*\/examples\//, ''), text]))
    const branch = 'submission/bernd/feuerwehr-texte'
    const files = new Map(this.main)
    const path = files.has('entities/organizations/feuerwehr-schnackenburg.yaml') ? 'entities/organizations/feuerwehr-schnackenburg.yaml' : [...files.keys()].find((p) => p.startsWith('entities/organizations/'))!
    files.set(path, files.get(path)!.replace(/^name: (.*?)(?: e\. V\.)?$/m, 'name: $1 e. V.'))
    this.branches.set(branch, files)
    this.pulls.push({ submission: { number: 1, name: 'Feuerwehr Texte', branch, author: 'bernd', state: 'submitted', url: 'https://github.com/example/contents/pull/1', updated: new Date().toISOString(), head: '' }, start: new Map(this.main), comments: [] })
  }

  private tell(news?: News): void {
    for (const listener of this.listeners) listener(news)
  }

  /** The head of a branch is what its files add up to (a branch that is gone: the last one it had). */
  private withHead(submission: Submission): Submission {
    const files = this.branches.get(submission.branch) ?? this.merged.get(submission.number)
    return { ...submission, head: files ? sha([...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => `${p}\n${t}`).join('\n')) : submission.head }
  }

  private pull(number: number): Pull {
    const found = this.pulls.find((p) => p.submission.number === number)
    if (!found) throw new ApiError('Diese Einreichung gibt es nicht.', 404)
    return found
  }

  async me(): Promise<User> {
    return { login: 'anna', name: 'Anna Beispiel', avatar: '', role: 'write' }
  }

  async entries(branch?: string): Promise<EntriesResult> {
    const own = branch ? this.branches.get(branch) : undefined
    const files = own ?? this.main
    return { base: 'main', branch: branch ?? null, exists: !!own, entries: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => ({ path, text, sha: sha(text) })) }
  }

  async index(branch?: string): Promise<IndexResult> {
    const own = branch ? this.branches.get(branch) : undefined
    const files = own ?? this.main
    const headOf = (f: Files) => sha([...f].sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => `${p}\n${t}`).join('\n'))
    const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).flatMap(([path, text]) => indexEntry({ path, text }, sha(text)) ?? [])
    return { base: 'main', branch: branch ?? null, exists: !!own, commit: headOf(this.main), head: headOf(files), entries }
  }

  async entry(path: string, branch?: string): Promise<RemoteEntry | null> {
    const text = (branch ? this.branches.get(branch)?.get(path) : undefined) ?? this.main.get(path)
    return text === undefined ? null : { path, text, sha: sha(text) }
  }

  /** The branch to commit to, made from main if there is none; refuses a submission that is finished. */
  private target(submission: SubmissionRef): { files: Files; pull?: Pull } {
    if (!isSubmissionBranch(submission.branch)) throw new ApiError('Keine Einreichung.', 400)
    let files = this.branches.get(submission.branch)
    const pull = files ? this.pulls.filter((p) => p.submission.branch === submission.branch).at(-1) : undefined
    if (pull && ['merged', 'closed'].includes(pull.submission.state)) throw new ApiError('Diese Einreichung ist schon abgeschlossen. Lege eine neue an.', 409)
    if (!files) this.branches.set(submission.branch, (files = new Map(this.main)))
    return { files, pull }
  }

  private afterCommit(submission: SubmissionRef, files: Files, pull?: Pull): number | undefined {
    if (pull) return pull.submission.number
    const differs = files.size !== this.main.size || [...files].some(([p, t]) => this.main.get(p) !== t)
    if (!differs) return undefined
    const number = Math.max(0, ...this.pulls.map((p) => p.submission.number)) + 1
    this.pulls.push({ submission: { number, name: submission.name, branch: submission.branch, author: authorOf(submission.branch), state: 'draft', url: `https://github.com/example/contents/pull/${number}`, updated: new Date().toISOString(), head: '' }, start: new Map(this.main), comments: [] })
    return number
  }

  async save(path: string, text: string, based: string | undefined, submission: SubmissionRef): Promise<{ sha: string; pull?: number }> {
    const issues = [...validateEntryYaml(text), ...checkPath(path, readObject(text) ?? {})]
    if (issues.length > 0) throw new ApiError('Der Eintrag ist nicht gültig.', 422, issues)
    const { files, pull } = this.target(submission)
    const before = files.get(path)
    if (before !== undefined && based !== sha(before)) throw new ApiError('Der Eintrag wurde inzwischen geändert.', 409)
    files.set(path, text)
    const number = this.afterCommit(submission, files, pull)
    this.tell({ type: 'pull', number })
    return { sha: sha(text), pull: number }
  }

  async remove(path: string, _sha: string, submission: SubmissionRef): Promise<void> {
    const { files, pull } = this.target(submission)
    files.delete(path)
    this.tell({ type: 'pull', number: this.afterCommit(submission, files, pull) })
  }

  async commit(writes: { path: string; text: string }[], removals: string[], submission: SubmissionRef): Promise<{ pull?: number }> {
    for (const w of writes) {
      const object = readObject(w.text)
      // Like the Worker: unfinished entries are taken; text that is no YAML, and a file that is not where its id says, are not.
      const issues = FOLDER_PATH.test(w.path) ? validateFolderYaml(w.text) : object ? checkPath(w.path, object) : validateEntryYaml(w.text)
      if (issues.length > 0) throw new ApiError(`${w.path} ist nicht gültig.`, 422, issues)
    }
    const { files, pull } = this.target(submission)
    for (const path of removals) files.delete(path)
    for (const w of writes) files.set(w.path, w.text)
    const number = this.afterCommit(submission, files, pull)
    this.tell({ type: 'pull', number })
    return { pull: number }
  }

  async submissions(): Promise<Submission[]> {
    return this.pulls.map((p) => this.withHead(p.submission)).sort((a, b) => b.updated.localeCompare(a.updated))
  }

  async submission(number: number): Promise<SubmissionDetail> {
    const p = this.pull(number)
    const after = this.branches.get(p.submission.branch) ?? this.merged.get(number) ?? new Map<string, string>()
    const items: SubmissionItem[] = []
    for (const path of [...new Set([...p.start.keys(), ...after.keys()])].sort()) {
      const was = p.start.get(path)
      const is = after.get(path)
      if (was === is) continue
      items.push({ path, kind: was === undefined ? 'added' : is === undefined ? 'removed' : 'modified', ...(was !== undefined ? { before: was } : {}), ...(is !== undefined ? { after: is } : {}) })
    }
    return { submission: this.withHead(p.submission), items, truncated: false, checks: items.every((i) => !i.after || validateEntryYaml(i.after).length === 0) ? 'success' : 'failure' }
  }

  private touch(p: Pull, state: Submission['state']): void {
    p.submission = { ...p.submission, state, updated: new Date().toISOString() }
    this.tell({ type: state === 'merged' ? 'push' : 'pull', number: p.submission.number })
    if (state === 'merged') this.tell({ type: 'pull', number: p.submission.number })
  }

  async submit(number: number): Promise<void> {
    const p = this.pull(number)
    if (p.submission.state !== 'draft') throw new ApiError('Die Einreichung ist kein Entwurf.', 409)
    this.touch(p, 'submitted')
  }

  async merge(number: number): Promise<void> {
    const p = this.pull(number)
    if (p.submission.state === 'draft') throw new ApiError('Die Einreichung ist noch ein Entwurf: erst einreichen.', 409)
    if (p.submission.state !== 'submitted') throw new ApiError('Diese Einreichung ist schon abgeschlossen.', 409)
    this.main = new Map(this.branches.get(p.submission.branch))
    // The branch is gone, but what the submission did stays to be looked at.
    this.merged.set(number, this.branches.get(p.submission.branch)!)
    this.branches.delete(p.submission.branch)
    this.touch(p, 'merged')
  }

  async rename(number: number, name: string): Promise<void> {
    const p = this.pull(number)
    if (['merged', 'closed'].includes(p.submission.state)) throw new ApiError('Diese Einreichung ist schon abgeschlossen.', 409)
    const title = name.replace(/\s+/g, ' ').trim()
    if (!title) throw new ApiError('Der Name fehlt.', 400)
    p.submission = { ...p.submission, name: title, updated: new Date().toISOString() }
    this.tell({ type: 'pull', number })
  }

  async close(number: number): Promise<void> {
    const p = this.pull(number)
    if (['merged', 'closed'].includes(p.submission.state)) throw new ApiError('Diese Einreichung ist schon abgeschlossen.', 409)
    // Like the Worker: the branch goes, what the submission did stays to be looked at.
    const files = this.branches.get(p.submission.branch)
    if (files) this.merged.set(number, files)
    this.branches.delete(p.submission.branch)
    this.touch(p, 'closed')
  }

  async comments(number: number): Promise<Comment[]> {
    return [...this.pull(number).comments]
  }

  async comment(number: number, body: string): Promise<Comment> {
    const p = this.pull(number)
    const comment = { id: p.comments.length + 1, author: 'anna', avatar: '', body: body.trim(), created: new Date().toISOString() }
    p.comments = [...p.comments, comment]
    this.tell({ type: 'comment', number })
    return comment
  }

  listen(onNews: (news?: News) => void, onOpen: (open: boolean) => void): Listener {
    this.listeners.add(onNews)
    onOpen(true)
    return { stop: () => this.listeners.delete(onNews), nudge: () => undefined }
  }

  async logout(): Promise<void> {}
}
