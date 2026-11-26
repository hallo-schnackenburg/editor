// The activity stream: what the people of the team did, kept for a year (in the hub's SQLite). The webhook of GitHub tells what happened
// (activityOf); the log writes it down, with what one person does in a row in one submission put together (their changes count up
// instead of making a line each). Who has read how far is kept per person, so that the inbox is the same on every device.
// The inbox and the log of the whole team are two views of this one stream (the app filters).

export type ActivityKind = 'started' | 'submitted' | 'withdrawn' | 'merged' | 'closed' | 'reopened' | 'changes' | 'comment' | 'main'

/** What happened, as the webhook knows it. */
export interface ActivityInput {
  kind: ActivityKind
  /** The login of the person who did it. */
  actor: string
  /** The branch of the submission (or the base branch for `main`). */
  branch?: string
  /** The pull request, if it is known. */
  number?: number
  /** For `changes` and `main`: how many commits. */
  count?: number
}

/** A line of the stream. A line that grows (more changes) is moved to the end, so that it counts as new again. */
export interface ActivityEvent {
  id: number
  /** When it began / when it last grew (milliseconds). */
  at: number
  updated: number
  actor: string
  kind: ActivityKind
  branch: string | null
  number: number | null
  count: number
}

/** The parts of the payload of GitHub that are looked at. */
export interface HookPayload {
  action?: unknown
  ref?: unknown
  after?: unknown
  deleted?: unknown
  number?: unknown
  commits?: unknown
  sender?: { login?: unknown; type?: unknown }
  repository?: { full_name?: unknown }
  pull_request?: { head?: { ref?: unknown; sha?: unknown }; number?: unknown; draft?: unknown; merged?: unknown }
  issue?: { number?: unknown; pull_request?: unknown }
  check_suite?: { head_branch?: unknown }
  check_run?: { check_suite?: { head_branch?: unknown } }
  branches?: { name?: unknown }[]
}

const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined)

/** What an event of GitHub means for the stream, or nothing (checks, renamings, bots, branches that are none of ours). */
export function activityOf(event: string, payload: HookPayload, { branchPrefix, base }: { branchPrefix: string; base: string }): ActivityInput | undefined {
  const actor = typeof payload.sender?.login === 'string' && payload.sender.type !== 'Bot' ? payload.sender.login : undefined
  if (!actor) return undefined
  const ours = (ref: unknown): ref is string => typeof ref === 'string' && ref.startsWith(branchPrefix)

  if (event === 'push' && typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/') && payload.deleted !== true) {
    const branch = payload.ref.slice('refs/heads/'.length)
    const count = Array.isArray(payload.commits) ? payload.commits.length : 0
    if (count === 0) return undefined
    if (branch === base) return { kind: 'main', actor, branch, count }
    if (ours(branch)) return { kind: 'changes', actor, branch, count }
    return undefined
  }
  if (event === 'pull_request') {
    const head = payload.pull_request?.head?.ref
    if (!ours(head)) return undefined
    const common = { actor, branch: head, number: positive(payload.pull_request?.number) ?? positive(payload.number) }
    switch (payload.action) {
      case 'opened':
        return { kind: payload.pull_request?.draft === true ? 'started' : 'submitted', ...common }
      case 'ready_for_review':
        return { kind: 'submitted', ...common }
      case 'converted_to_draft':
        return { kind: 'withdrawn', ...common }
      case 'closed':
        return { kind: payload.pull_request?.merged === true ? 'merged' : 'closed', ...common }
      case 'reopened':
        return { kind: 'reopened', ...common }
      default:
        return undefined
    }
  }
  if (event === 'issue_comment' && payload.action === 'created' && payload.issue?.pull_request) return { kind: 'comment', actor, number: positive(payload.issue.number) }
  if (event === 'pull_request_review_comment' && payload.action === 'created') {
    const head = payload.pull_request?.head?.ref
    return { kind: 'comment', actor, number: positive(payload.pull_request?.number), ...(ours(head) ? { branch: head } : {}) }
  }
  return undefined
}

/** The part of the SQLite of a Durable Object that is used (a stand-in is used in tests). */
export interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] }
}

/** A person's changes within this time of their last ones in the same submission are one line. */
export const TOGETHER_MS = 30 * 60 * 1000
/** What is older than this is forgotten. */
export const KEEP_MS = 365 * 24 * 3600 * 1000

export class ActivityLog {
  #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
    sql.exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, updated INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, branch TEXT, number INTEGER, count INTEGER NOT NULL DEFAULT 1)')
    sql.exec('CREATE TABLE IF NOT EXISTS seen (login TEXT PRIMARY KEY, upto INTEGER NOT NULL)')
  }

  /** Writes it down; returns the line it is now (a grown one has a new id). */
  add(input: ActivityInput, now: number): ActivityEvent {
    const count = input.count ?? 1
    const branch = input.branch ?? null
    const number = input.number ?? null
    let at = now
    let total = count
    if (input.kind === 'changes' || input.kind === 'main') {
      // Only the newest line of the submission can grow: if somebody else did something since, this is a new line.
      const last = this.#sql.exec<ActivityEvent>('SELECT * FROM events WHERE branch IS ? ORDER BY id DESC LIMIT 1', branch).toArray()[0]
      if (last && last.kind === input.kind && last.actor === input.actor && now - last.updated <= TOGETHER_MS) {
        this.#sql.exec('DELETE FROM events WHERE id = ?', last.id)
        at = last.at
        total = last.count + count
      }
    }
    this.#sql.exec('INSERT INTO events (at, updated, actor, kind, branch, number, count) VALUES (?, ?, ?, ?, ?, ?, ?)', at, now, input.actor, input.kind, branch, number, total)
    const [added] = this.#sql.exec<ActivityEvent>('SELECT * FROM events ORDER BY id DESC LIMIT 1').toArray()
    this.#sql.exec('DELETE FROM events WHERE updated < ?', now - KEEP_MS)
    return added
  }

  /** The newest lines first; `before` goes further back from the line with this id. */
  list(limit = 50, before?: number): ActivityEvent[] {
    const max = Math.min(Math.max(1, Math.floor(limit)), 200)
    return before === undefined
      ? this.#sql.exec<ActivityEvent>('SELECT * FROM events ORDER BY id DESC LIMIT ?', max).toArray()
      : this.#sql.exec<ActivityEvent>('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?', before, max).toArray()
  }

  /** The id up to which this person has read (0 if they never did). */
  seen(login: string): number {
    return this.#sql.exec<{ upto: number }>('SELECT upto FROM seen WHERE login = ?', login).toArray()[0]?.upto ?? 0
  }

  /** Never moves back. */
  markSeen(login: string, upto: number): number {
    this.#sql.exec('INSERT INTO seen (login, upto) VALUES (?, ?) ON CONFLICT(login) DO UPDATE SET upto = MAX(upto, excluded.upto)', login, upto)
    return this.seen(login)
  }
}
