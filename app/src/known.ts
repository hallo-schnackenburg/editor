// What the editor has read of the repository, kept so that nothing has to be waited for: the base branch as a whole, and of each
// submission only how it differs from the base (a branch is the whole database again, with a few changes). A branch is right as long
// as its head (the newest commit) is the one it was read at. Kept in the browser too, so that it is there after the page was loaded again.

import type { IndexEntry } from '@editor/core'
import type { Comment, Submission, User } from './api.js'

/** What is kept of an entry: where it is and the version it is at (the sha of its file). */
export interface Versioned {
  path: string
  sha: string
}

/** The entries of a branch (of the base branch if it is null) as the server listed them. */
export interface Listed<T extends Versioned = IndexEntry> {
  base: string
  branch: string | null
  exists: boolean
  entries: T[]
}

/** How many texts of entries are held in memory (by version): the ones that were used last. The rest is in the store of texts (texts.ts). */
const MAX_TEXTS = 2000

/** A branch as it differs from the base. */
export interface BranchRecord {
  /** The head of the branch when it was read (empty if that is not known: then it is never right). */
  head: string
  exists: boolean
  /** The entries that are new or different. */
  changed: IndexEntry[]
  /** The paths of the base that the branch does not have. */
  removed: string[]
}

/** Where the person was: shown again when the page is loaded again. */
export interface View {
  /** The submission that was worked on (null: the base branch). */
  branch: string | null
  /** The details of the submission were shown in the middle. */
  detailOpen: boolean
  /** The entry that was open. */
  path?: string
}

export interface Snapshot {
  login: string
  /** Who it was: the page is shown for them at once, before GitHub has said that they are still signed in. */
  user?: User
  view?: View
  submissions: Submission[]
  base?: Listed
  branches: Record<string, BranchRecord>
  comments: Record<number, Comment[]>
}

/** Where the snapshot is kept between two visits. */
export interface Store {
  load(): Promise<Snapshot | undefined>
  save(snapshot: Snapshot): Promise<void>
  clear(): Promise<void>
}

export function deltaOf(base: Listed, result: Listed, head: string): BranchRecord {
  const was = new Map(base.entries.map((e) => [e.path, e.sha]))
  const has = new Set(result.entries.map((e) => e.path))
  return {
    head,
    exists: result.exists,
    changed: result.entries.filter((e) => was.get(e.path) !== e.sha),
    removed: base.entries.filter((e) => !has.has(e.path)).map((e) => e.path),
  }
}

export function applyDelta(base: Listed, record: BranchRecord, branch: string): Listed {
  const gone = new Set(record.removed)
  const changed = new Map(record.changed.map((e) => [e.path, e]))
  const entries = [...base.entries.filter((e) => !gone.has(e.path) && !changed.has(e.path)), ...record.changed].sort((a, b) => a.path.localeCompare(b.path))
  return { base: base.base, branch, exists: record.exists, entries }
}

export class Known {
  base: Listed | undefined
  readonly branches = new Map<string, BranchRecord>()
  readonly comments = new Map<number, Comment[]>()
  /** The texts of the entries that were opened, by version (the sha tells what is in it, so they never go out of date). */
  readonly texts = new Map<string, string>()
  submissions: Submission[] = []
  view: View | undefined

  /** A new base: the branches keep what they have (they are expressed against the new one). */
  setBase(base: Listed): void {
    const old = this.base
    if (old) {
      for (const [branch, record] of this.branches) this.branches.set(branch, deltaOf(base, applyDelta(old, record, branch), record.head))
    }
    this.base = base
  }

  /** What was read of a branch. */
  setBranch(branch: string, result: Listed, head: string | undefined): void {
    if (this.base) this.branches.set(branch, deltaOf(this.base, result, head ?? ''))
  }

  /** What is known of a branch (undefined: the base branch). */
  recall(branch: string | undefined): Listed | undefined {
    if (branch === undefined) return this.base
    const record = this.branches.get(branch)
    return this.base && record ? applyDelta(this.base, record, branch) : undefined
  }

  /** Whether what is known of the branch is the state at this head. */
  valid(branch: string, head: string | undefined): boolean {
    const record = this.branches.get(branch)
    return !!record && !!head && record.head === head
  }

  /** The text of a version that was read, or undefined. */
  text(sha: string): string | undefined {
    return this.texts.get(sha)
  }

  /** Keeps the text of a version (the oldest ones go when there are many). */
  keepText(sha: string, text: string): void {
    this.texts.delete(sha)
    this.texts.set(sha, text)
    for (const old of this.texts.keys()) {
      if (this.texts.size <= MAX_TEXTS) break
      this.texts.delete(old)
    }
  }

  forget(branch: string): void {
    this.branches.delete(branch)
  }

  clear(): void {
    this.base = undefined
    this.branches.clear()
    this.comments.clear()
    this.texts.clear()
    this.submissions = []
    this.view = undefined
  }

  snapshot(user: User): Snapshot {
    return { login: user.login, user, view: this.view, submissions: this.submissions, base: this.base, branches: Object.fromEntries(this.branches), comments: Object.fromEntries(this.comments) }
  }

  restore(snapshot: Snapshot): void {
    this.clear()
    this.base = snapshot.base
    this.view = snapshot.view
    this.submissions = snapshot.submissions
    for (const [branch, record] of Object.entries(snapshot.branches)) this.branches.set(branch, record)
    for (const [number, comments] of Object.entries(snapshot.comments)) this.comments.set(Number(number), comments)
  }
}

export class MemoryStore implements Store {
  #text: string | undefined

  async load(): Promise<Snapshot | undefined> {
    return this.#text === undefined ? undefined : (JSON.parse(this.#text) as Snapshot)
  }

  async save(snapshot: Snapshot): Promise<void> {
    this.#text = JSON.stringify(snapshot)
  }

  async clear(): Promise<void> {
    this.#text = undefined
  }
}

const DB = 'editor'
const KEY = 'snapshot'

/** The snapshot in the browser's IndexedDB (as one piece of text; what is $state in the app cannot be cloned). */
export class BrowserStore implements Store {
  #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('kv')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  async #run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = work(db.transaction('kv', mode).objectStore('kv'))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }

  async load(): Promise<Snapshot | undefined> {
    const text = await this.#run<unknown>('readonly', (s) => s.get(KEY))
    return typeof text === 'string' ? (JSON.parse(text) as Snapshot) : undefined
  }

  async save(snapshot: Snapshot): Promise<void> {
    await this.#run('readwrite', (s) => s.put(JSON.stringify(snapshot), KEY))
  }

  async clear(): Promise<void> {
    await this.#run('readwrite', (s) => s.delete(KEY))
  }
}

/** The store of the browser if it has one, else one that forgets with the page. */
export const defaultStore = (): Store => (typeof indexedDB === 'undefined' ? new MemoryStore() : new BrowserStore())
