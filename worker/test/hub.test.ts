import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { Hub, TELL_EVERY_MS, type HubSocket } from '../src/hub.js'

beforeAll(() => {
  // The runtime has this; node does not.
  ;(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {}
})

class FakeSocket implements HubSocket {
  sent: any[] = []
  #attachment: unknown = null
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
  serializeAttachment(value: unknown) {
    this.#attachment = value
  }
  deserializeAttachment() {
    return this.#attachment
  }
  last(type: string) {
    return [...this.sent].reverse().find((m) => m.type === type)
  }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  const sockets: FakeSocket[] = []
  let now = 1_000_000
  const hub = new Hub(
    {
      acceptWebSocket: () => {},
      getWebSockets: () => sockets,
      setWebSocketAutoResponse: () => {},
      storage: {
        sql: {
          exec: <T>(query: string, ...bindings: unknown[]) => {
            const statement = db.prepare(query)
            if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...(bindings as never[])) as T[] }
            statement.run(...(bindings as never[]))
            return { toArray: () => [] as T[] }
          },
        },
      },
    },
    undefined,
    () => now,
  )
  const connect = (login: string) => {
    const socket = new FakeSocket()
    sockets.push(socket)
    hub.join(socket, { login, name: login.toUpperCase(), avatar: '' })
    return socket
  }
  return { hub, sockets, connect, tick: (ms: number) => (now += ms), remove: (socket: FakeSocket) => sockets.splice(sockets.indexOf(socket), 1) }
}
const say = (hub: Hub, socket: FakeSocket, data: object) => hub.webSocketMessage(socket, JSON.stringify({ type: 'presence', ...data }))

describe('presence', () => {
  it('tells everybody who is there, when somebody comes', () => {
    const { connect } = setup()
    const anna = connect('anna')
    const ben = connect('ben')
    expect(ben.last('presence').users.map((u: any) => u.login)).toEqual(['anna', 'ben'])
    expect(anna.last('presence').users.map((u: any) => u.login)).toEqual(['anna', 'ben'])
  })

  it('tells what somebody works on, when it changes, and keeps quiet while nothing does', () => {
    const { hub, connect, tick } = setup()
    const anna = connect('anna')
    const ben = connect('ben')
    ben.sent.length = 0
    tick(1000)
    say(hub, anna, { branch: 'submission/anna/fest', path: 'entities/places/a.yaml' })
    expect(ben.last('presence').users.find((u: any) => u.login === 'anna')).toMatchObject({ branch: 'submission/anna/fest', path: 'entities/places/a.yaml' })
    ben.sent.length = 0
    tick(1000)
    say(hub, anna, { branch: 'submission/anna/fest', path: 'entities/places/a.yaml' })
    expect(ben.sent).toEqual([])
    tick(TELL_EVERY_MS)
    say(hub, anna, { branch: 'submission/anna/fest', path: 'entities/places/a.yaml' })
    expect(ben.sent).toHaveLength(1) // so that nobody counts as away who is not
  })

  it('has a person on two devices once, with what they did last', () => {
    const { hub, connect, tick } = setup()
    const laptop = connect('anna')
    const phone = connect('anna')
    tick(500)
    say(hub, phone, { path: 'x.yaml' })
    const users = hub.presence().users
    expect(users).toHaveLength(1)
    expect(users[0].path).toBe('x.yaml')
    expect(laptop.last('presence').users).toHaveLength(1)
  })

  it('tells that somebody is gone, also with one more device still there', () => {
    const { hub, connect, remove } = setup()
    const anna = connect('anna')
    const ben = connect('ben')
    anna.sent.length = 0
    hub.webSocketClose(ben, 1000)
    expect(anna.last('presence').users.map((u: any) => u.login)).toEqual(['anna'])
    remove(ben)
  })

  it('ignores what is not a presence message, or too long', () => {
    const { hub, connect } = setup()
    const anna = connect('anna')
    anna.sent.length = 0
    hub.webSocketMessage(anna, 'nonsense')
    hub.webSocketMessage(anna, JSON.stringify({ type: 'other' }))
    hub.webSocketMessage(anna, 'x'.repeat(5000))
    expect(anna.sent).toEqual([])
  })
})

describe('the activity stream', () => {
  const post = (hub: Hub, body: object) => hub.fetch(new Request('http://hub/activity', { method: 'POST', body: JSON.stringify(body) }))

  it('writes a line down and tells the browsers', async () => {
    const { hub, connect } = setup()
    const anna = connect('anna')
    const response = await post(hub, { kind: 'merged', actor: 'ben', number: 4 })
    expect(response.status).toBe(200)
    expect(anna.last('activity').event).toMatchObject({ kind: 'merged', actor: 'ben', number: 4 })
  })

  it('answers with the lines and how far the person has read, and takes what they have read', async () => {
    const { hub } = setup()
    await post(hub, { kind: 'started', actor: 'ben', number: 4, branch: 'submission/ben/x' })
    const second = await (await post(hub, { kind: 'comment', actor: 'ben', number: 4 })).json() as { id: number }
    const read = async () => (await (await hub.fetch(new Request('http://hub/activity?login=anna'))).json()) as { events: { id: number }[]; seen: number }
    expect(await read()).toMatchObject({ seen: 0, events: [{ id: second.id }, {}] })
    await hub.fetch(new Request(`http://hub/activity?login=anna&seen=${second.id}`, { method: 'POST' }))
    expect((await read()).seen).toBe(second.id)
  })

  it('refuses a line that is none, and a read without a person', async () => {
    const { hub } = setup()
    expect((await post(hub, { nonsense: true })).status).toBe(400)
    expect((await hub.fetch(new Request('http://hub/activity'))).status).toBe(400)
  })
})
