// Everything the app asks of the server goes through this interface: the Worker (HttpApi), or, for trying things
// out without GitHub, a copy of the examples in memory (fake.ts).

import type { IndexEntry, Issue } from '@contents-editor/core'
import { Live, liveUrl, type News } from './live.js'

export type { News } from './live.js'

export interface User {
  login: string
  name: string
  avatar: string
  role: string
}

/** An entry as the server has it: where it is, the version it is at (sha), and its text. */
export interface RemoteEntry {
  path: string
  sha: string
  text: string
}

export interface EntriesResult {
  base: string
  /** The branch asked for; null for the base branch. */
  branch: string | null
  /** True once the submission has a branch; before that, and for the base branch, the entries are the ones of the base. */
  exists: boolean
  entries: RemoteEntry[]
}

/** The index of the entries (one line each, see core's index-build): the base branch, or the base branch with the changes of a submission. */
export interface IndexResult {
  base: string
  branch: string | null
  exists: boolean
  /** The commit of the base branch the entries are as of. */
  commit: string
  /** The commit of the submission's branch (the base commit if there is none). */
  head: string
  entries: IndexEntry[]
}

/** A submission is a branch with a pull request: draft (being worked on), submitted (waits for somebody to accept it), merged (accepted) or closed. */
export type SubmissionState = 'draft' | 'submitted' | 'merged' | 'closed'

export interface Submission {
  number: number
  name: string
  branch: string
  /** The login of the person who started it. */
  author: string
  state: SubmissionState
  url: string
  updated: string
  /** The newest commit of its branch: what was read of the branch at this commit is still right. */
  head: string
}

/** What a submission does to one entry. `before` is missing for an added entry, `after` for a removed one. */
export interface SubmissionItem {
  path: string
  kind: 'added' | 'modified' | 'removed'
  before?: string
  after?: string
}

/** How the automatic checks of a submission stand. */
export type Checks = 'none' | 'pending' | 'success' | 'failure'

export interface SubmissionDetail {
  submission: Submission
  items: SubmissionItem[]
  /** There were more entries than are shown. */
  truncated: boolean
  checks: Checks
}

export interface Comment {
  id: number
  author: string
  avatar: string
  body: string
  created: string
}

/** The submission a save belongs to: its branch, and its name (the title of the pull request, made with the first save). */
export interface SubmissionRef {
  branch: string
  name: string
}

/** A connection for news; `nudge` tries to open it again at once (the page came to the front, the network is back). */
export interface Listener {
  stop(): void
  nudge(): void
}

export interface Api {
  /** Null if nobody is signed in. */
  me(): Promise<User | null>
  /** The entries of a submission's branch (of the base branch without one, or while the submission has no branch yet). */
  entries(branch?: string): Promise<EntriesResult>
  /** The index of a submission (of the base branch without one, or while the submission has no branch yet). */
  index(branch?: string): Promise<IndexResult>
  /** One entry, from the submission's branch if it has the file there, else from the base branch. Null if there is none. */
  entry(path: string, branch?: string): Promise<RemoteEntry | null>
  /** `sha` is the version the submission is based on; missing for a new entry. Returns the new version, and the pull request if there is one now. */
  save(path: string, text: string, sha: string | undefined, submission: SubmissionRef): Promise<{ sha: string; pull?: number }>
  remove(path: string, sha: string, submission: SubmissionRef): Promise<void>
  /** Several entries in ONE commit (a renaming: files move, references are rewritten). Returns the pull request if there is one now. */
  commit(writes: { path: string; text: string }[], removals: string[], submission: SubmissionRef, message?: string): Promise<{ pull?: number; commit?: string }>
  submissions(): Promise<Submission[]>
  submission(number: number): Promise<SubmissionDetail>
  /** The draft is ready for review. */
  submit(number: number): Promise<void>
  /** Accept the submission: it is squashed into the base branch. */
  merge(number: number): Promise<void>
  close(number: number): Promise<void>
  /** The name of a submission that is not finished (the title of its pull request). */
  rename(number: number, name: string): Promise<void>
  comments(number: number): Promise<Comment[]>
  comment(number: number, body: string): Promise<Comment>
  /** Tells about news (see live.ts); `onOpen` says whether the connection is there. */
  listen(onNews: (news?: News) => void, onOpen: (open: boolean) => void): Listener
  logout(): Promise<void>
}

export class SignedOut extends Error {
  constructor() {
    super('Du bist nicht mehr angemeldet.')
  }
}

/** The server refused: `issues` are the problems the checks found (a 422), `conflict` that somebody changed the entry. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issue[] = [],
  ) {
    super(message)
  }
  get conflict() {
    return this.status === 409
  }
}

export class HttpApi implements Api {
  constructor(private base = '/api') {}

  private async call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, init)
    } catch {
      throw new Error('Der Server ist nicht erreichbar. Läuft der Worker (npm run dev:worker)?')
    }
  }

  private async json<T>(response: Response): Promise<T> {
    const data = (await response.json().catch(() => ({}))) as T & { error?: string; issues?: Issue[] }
    if (response.status === 401) throw new SignedOut()
    if (!response.ok) throw new ApiError(data.error ?? `Der Server antwortete mit ${response.status}.`, response.status, data.issues)
    return data
  }

  private send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }).then((r) => this.json<T>(r))
  }

  async me(): Promise<User | null> {
    const response = await this.call('/auth/me')
    return response.status === 401 ? null : this.json<User>(response)
  }

  entries(branch?: string): Promise<EntriesResult> {
    return this.call(`/repo/entries${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`).then((r) => this.json<EntriesResult>(r))
  }

  index(branch?: string): Promise<IndexResult> {
    return this.call(`/repo/index${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`).then((r) => this.json<IndexResult>(r))
  }

  async entry(path: string, branch?: string): Promise<RemoteEntry | null> {
    const response = await this.call(`/repo/entry?path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`)
    return response.status === 404 ? null : this.json<RemoteEntry>(response)
  }

  save(path: string, text: string, sha: string | undefined, submission: SubmissionRef): Promise<{ sha: string; pull?: number }> {
    return this.send('PUT', '/repo/entry', { path, text, sha, branch: submission.branch, name: submission.name })
  }

  async remove(path: string, sha: string, submission: SubmissionRef): Promise<void> {
    await this.send('DELETE', '/repo/entry', { path, sha, branch: submission.branch, name: submission.name })
  }

  commit(writes: { path: string; text: string }[], removals: string[], submission: SubmissionRef, message?: string): Promise<{ pull?: number; commit?: string }> {
    return this.send('POST', '/repo/commit', { writes, removals, message, branch: submission.branch, name: submission.name })
  }

  async submissions(): Promise<Submission[]> {
    return (await this.send<{ submissions: Submission[] }>('GET', '/repo/submissions')).submissions
  }

  submission(number: number): Promise<SubmissionDetail> {
    return this.send('GET', `/repo/submissions/${number}`)
  }

  async submit(number: number): Promise<void> {
    await this.send('POST', `/repo/submissions/${number}/submit`)
  }

  async merge(number: number): Promise<void> {
    await this.send('POST', `/repo/submissions/${number}/merge`)
  }

  async close(number: number): Promise<void> {
    await this.send('POST', `/repo/submissions/${number}/close`)
  }

  async rename(number: number, name: string): Promise<void> {
    await this.send('POST', `/repo/submissions/${number}/rename`, { name })
  }

  async comments(number: number): Promise<Comment[]> {
    return (await this.send<{ comments: Comment[] }>('GET', `/repo/submissions/${number}/comments`)).comments
  }

  comment(number: number, body: string): Promise<Comment> {
    return this.send('POST', `/repo/submissions/${number}/comments`, { body })
  }

  listen(onNews: (news?: News) => void, onOpen: (open: boolean) => void): Listener {
    const live = new Live(liveUrl(this.base, window.location.href), onNews, onOpen)
    live.start()
    return { stop: () => live.stop(), nudge: () => live.nudge() }
  }

  async logout(): Promise<void> {
    await this.call('/auth/logout', { method: 'POST' })
  }
}
