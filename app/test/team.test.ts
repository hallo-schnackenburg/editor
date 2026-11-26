import { describe, expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { Live, type Socket } from '../src/live.js'
import { describe as say, inboxOf, teamOf, unreadOf, type ActivityEvent } from '../src/team.js'
import { Workspace } from '../src/workspace.svelte.js'

const line = (id: number, actor: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ id, at: id, updated: id, actor, kind: 'changes', branch: 'submission/anna/fest', number: 4, count: 1, ...extra })

describe('the messages of the hub', () => {
  it('knows those for the team and leaves the news alone', () => {
    expect(teamOf(JSON.stringify({ type: 'presence', now: 5, users: [] }))).toEqual({ type: 'presence', now: 5, users: [] })
    expect(teamOf(JSON.stringify({ type: 'activity', event: line(1, 'a') }))?.type).toBe('activity')
    expect(teamOf(JSON.stringify({ type: 'push', head: 'x' }))).toBeUndefined()
    expect(teamOf('pong')).toBeUndefined()
    expect(teamOf('nonsense')).toBeUndefined()
  })

  it('does not pass them on as news, and says what the person works on when it connects', () => {
    class FakeSocket implements Socket {
      onopen: (() => void) | null = null
      onmessage: ((event: { data: unknown }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      sent: string[] = []
      send(data: string) { this.sent.push(data) }
      close() {}
    }
    const socket = new FakeSocket()
    const news: unknown[] = []
    const team: unknown[] = []
    const live = new Live('wss://x/live', (n) => news.push(n), () => {}, () => socket, (m) => team.push(m))
    live.say({ branch: 'b', path: 'p' })
    live.start()
    socket.onopen?.()
    expect(socket.sent).toEqual([JSON.stringify({ type: 'presence', branch: 'b', path: 'p' })])
    socket.onmessage?.({ data: JSON.stringify({ type: 'presence', now: 1, users: [] }) })
    socket.onmessage?.({ data: JSON.stringify({ type: 'push' }) })
    expect(team).toHaveLength(1)
    expect(news).toHaveLength(2) // once for the opening, once for the push
    live.say({ path: 'q' })
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'presence', path: 'q' }))
  })
})

describe('the stream', () => {
  it('counts what is unread without what the person did', () => {
    const events = [line(3, 'ben'), line(2, 'anna'), line(1, 'ben')]
    expect(unreadOf(events, 1, 'anna').map((e) => e.id)).toEqual([3])
  })

  it('has in the inbox what concerns the person, and not the changes of the base branch', () => {
    const events = [line(3, 'ben'), line(2, 'ben', { kind: 'main', branch: 'main', number: null }), line(1, 'ben', { branch: 'submission/ben/x', number: 9 })]
    expect(inboxOf(events, (branch) => branch === 'submission/anna/fest', 'anna').map((e) => e.id)).toEqual([3])
  })

  it('tells a line in German', () => {
    expect(say(line(1, 'a', { count: 3 }))).toBe('hat 3 Änderungen in Einreichung #4 gemacht')
    expect(say(line(1, 'a', { kind: 'merged' }))).toBe('hat Einreichung #4 übernommen')
  })
})

describe('the workspace and the team', () => {
  async function started() {
    const api = new FakeApi()
    const ws = new Workspace(api)
    await ws.start()
    return { api, ws }
  }

  it('takes the presence and the lines the hub tells, and a grown line replaces the old one', async () => {
    const { api, ws } = await started()
    api.team?.({ type: 'presence', now: 1, users: [{ login: 'ben', name: 'Ben', avatar: '', seen: 1 }] })
    expect(ws.present.map((p) => p.login)).toEqual(['ben'])
    api.team?.({ type: 'activity', event: line(1, 'ben', { at: 100 }) })
    api.team?.({ type: 'activity', event: line(2, 'ben', { at: 100, count: 2 }) })
    expect(ws.activity.map((e) => [e.id, e.count])).toEqual([[2, 2]])
    ws.stopLive()
  })

  it('says what the person works on, and reads the stream up to where it has been read', async () => {
    const { api, ws } = await started()
    ws.selectedPath = 'entities/people/x.yaml'
    ws.reportPresence()
    expect(api.doing?.path).toBe('entities/people/x.yaml')
    api.stream = [line(5, 'ben')]
    await ws.loadActivity()
    expect(ws.unread).toHaveLength(1)
    await ws.markActivitySeen()
    expect(ws.unread).toHaveLength(0)
    expect(api.readUpto).toBe(5)
    ws.stopLive()
  })
})

describe('comments of the person', () => {
  it('are changed and removed, the comments of others are not', async () => {
    const api = new FakeApi()
    const ws = new Workspace(api)
    await ws.start()
    ws.stopLive()
    await ws.review.select(1)
    await ws.review.comment('Erster Stand.')
    const mine = ws.review.comments[0]
    expect(await ws.review.editComment(mine.id, ' Neuer Stand. ')).toBe(true)
    expect(ws.review.comments.map((c) => c.body)).toEqual(['Neuer Stand.'])
    expect(await ws.review.removeComment(mine.id)).toBe(true)
    expect(ws.review.comments).toEqual([])
    expect(await ws.review.editComment(99, 'x')).toBe(false)
    expect(ws.review.error).toBe('Diesen Kommentar gibt es nicht.')
  })
})
