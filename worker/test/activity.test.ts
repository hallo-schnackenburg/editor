import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ActivityLog, KEEP_MS, TOGETHER_MS, activityOf, type Sql } from '../src/activity.js'

/** The SQLite of a Durable Object, made of the one of node. */
function sqlite(): Sql {
  const db = new DatabaseSync(':memory:')
  return {
    exec: <T>(query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query)
      if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...(bindings as never[])) as T[] }
      statement.run(...(bindings as never[]))
      return { toArray: () => [] as T[] }
    },
  }
}

const context = { branchPrefix: 'submission/', base: 'main' }
const sender = { login: 'anna', type: 'User' }
const at = (event: string, payload: object) => activityOf(event, { sender, ...payload }, context)

describe('what the events of GitHub mean for the stream', () => {
  it('is a change of the base branch, or of a submission, counted in commits', () => {
    expect(at('push', { ref: 'refs/heads/main', commits: [{}, {}] })).toEqual({ kind: 'main', actor: 'anna', branch: 'main', count: 2 })
    expect(at('push', { ref: 'refs/heads/submission/anna/fest', commits: [{}] })).toEqual({ kind: 'changes', actor: 'anna', branch: 'submission/anna/fest', count: 1 })
  })

  it('is nothing for other branches, empty or deleted pushes, and bots', () => {
    expect(at('push', { ref: 'refs/heads/index', commits: [{}] })).toBeUndefined()
    expect(at('push', { ref: 'refs/heads/main', commits: [] })).toBeUndefined()
    expect(at('push', { ref: 'refs/heads/submission/anna/fest', deleted: true, commits: [] })).toBeUndefined()
    expect(activityOf('push', { sender: { login: 'actions', type: 'Bot' }, ref: 'refs/heads/main', commits: [{}] }, context)).toBeUndefined()
    expect(activityOf('push', { ref: 'refs/heads/main', commits: [{}] }, context)).toBeUndefined()
  })

  it('tells what happens to a submission: started, submitted, withdrawn, merged, closed, reopened', () => {
    const pr = (action: string, extra: object = {}) => at('pull_request', { action, pull_request: { number: 4, head: { ref: 'submission/anna/fest' }, ...extra } })
    expect(pr('opened', { draft: true })).toEqual({ kind: 'started', actor: 'anna', branch: 'submission/anna/fest', number: 4 })
    expect(pr('opened', { draft: false })?.kind).toBe('submitted')
    expect(pr('ready_for_review')?.kind).toBe('submitted')
    expect(pr('converted_to_draft')?.kind).toBe('withdrawn')
    expect(pr('closed', { merged: true })?.kind).toBe('merged')
    expect(pr('closed', { merged: false })?.kind).toBe('closed')
    expect(pr('reopened')?.kind).toBe('reopened')
    expect(pr('edited')).toBeUndefined()
    expect(pr('synchronize')).toBeUndefined()
    expect(at('pull_request', { action: 'opened', pull_request: { number: 5, head: { ref: 'feature/x' } } })).toBeUndefined()
  })

  it('is a comment, when it is made (not when it is changed), and nothing else of the many events', () => {
    expect(at('issue_comment', { action: 'created', issue: { number: 4, pull_request: {} } })).toEqual({ kind: 'comment', actor: 'anna', number: 4 })
    expect(at('issue_comment', { action: 'edited', issue: { number: 4, pull_request: {} } })).toBeUndefined()
    expect(at('issue_comment', { action: 'created', issue: { number: 4 } })).toBeUndefined()
    expect(at('pull_request_review_comment', { action: 'created', pull_request: { number: 4, head: { ref: 'submission/anna/fest' } } })).toMatchObject({ kind: 'comment', number: 4, branch: 'submission/anna/fest' })
    expect(at('check_run', {})).toBeUndefined()
  })
})

describe('the log', () => {
  const changes = (actor: string, branch = 'submission/anna/fest', count = 1) => ({ kind: 'changes' as const, actor, branch, count })

  it('writes the lines down, the newest first', () => {
    const log = new ActivityLog(sqlite())
    log.add({ kind: 'started', actor: 'anna', branch: 'submission/anna/fest', number: 4 }, 1000)
    log.add({ kind: 'comment', actor: 'ben', number: 4 }, 2000)
    expect(log.list().map((e) => [e.kind, e.actor])).toEqual([['comment', 'ben'], ['started', 'anna']])
    expect(log.list(1, log.list()[0].id).map((e) => e.kind)).toEqual(['started'])
  })

  it('makes what one person does in a row in one submission one line that counts up, and moves it to the end', () => {
    const log = new ActivityLog(sqlite())
    const first = log.add(changes('anna'), 1000)
    const second = log.add(changes('anna', 'submission/anna/fest', 3), 2000)
    expect(log.list()).toHaveLength(1)
    expect(second).toMatchObject({ count: 4, at: 1000, updated: 2000 })
    expect(second.id).toBeGreaterThan(first.id)
  })

  it('starts a new line when somebody else did something since, for another person, another submission or after a pause', () => {
    const log = new ActivityLog(sqlite())
    log.add(changes('anna'), 1000)
    log.add({ kind: 'comment', actor: 'ben', number: 4, branch: 'submission/anna/fest' }, 2000)
    log.add(changes('anna'), 3000)
    expect(log.list()).toHaveLength(3)
    log.add(changes('ben', 'submission/ben/x'), 4000) // another submission: a line of its own
    expect(log.list()).toHaveLength(4)
    log.add(changes('anna', 'submission/anna/fest'), 5000) // what happens elsewhere does not break the row of this submission
    expect(log.list()).toHaveLength(4)
    log.add(changes('anna', 'submission/anna/fest'), 5000 + TOGETHER_MS + 1) // after a pause
    expect(log.list()).toHaveLength(5)
  })

  it('keeps for each person how far they read, and never moves that back', () => {
    const log = new ActivityLog(sqlite())
    expect(log.seen('anna')).toBe(0)
    expect(log.markSeen('anna', 5)).toBe(5)
    expect(log.markSeen('anna', 3)).toBe(5)
    expect(log.seen('ben')).toBe(0)
  })

  it('forgets what is older than a year', () => {
    const log = new ActivityLog(sqlite())
    log.add({ kind: 'merged', actor: 'anna', number: 1 }, 1000)
    log.add({ kind: 'merged', actor: 'anna', number: 2 }, 1000 + KEEP_MS + 10)
    expect(log.list().map((e) => e.number)).toEqual([2])
  })
})
