// The hub: one Durable Object that knows every browser that has the app open (as WebSockets) and passes a
// message on to all of them. The GitHub webhook tells it that main moved or a submission did (webhook.ts); the browsers then
// bring their copy up to date. It also keeps
//   - who is there and what they work on (presence): what the browsers say about themselves, kept with the socket, never stored;
//   - the activity stream (activity.ts): what the team did, in the SQLite of the object, and who has read how far.
//
// The sockets use the hibernation API: while nothing is sent, the object is not running (and not billed).
// The browsers send "ping" now and then; the runtime answers "pong" without waking the object.

import { ActivityLog, type ActivityEvent, type ActivityInput, type Sql } from './activity.js'

/** The parts of the runtime that are used here (the project has no type package for Workers). */
interface HubState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): HubSocket[]
  setWebSocketAutoResponse(pair: unknown): void
  storage?: { sql: Sql }
}
/** A WebSocket of the runtime: what is attached to it lives as long as the connection, also while the object sleeps. */
export interface HubSocket {
  send(data: string): void
  close(code?: number): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket }
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown

/** What the Worker needs of the namespace the hub is bound to. */
export interface HubNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** There is one hub; every request goes to the same object. */
export const hubOf = (namespace: HubNamespace) => namespace.get(namespace.idFromName('hub'))

/** Who is connected, as the browser of that person says it. */
export interface Who {
  login: string
  name: string
  avatar: string
}

interface Attached extends Who {
  /** What the person works on: the submission (its branch) and the entry (its path). */
  branch?: string
  path?: string
  /** The last time they did something, and the last time everybody was told about them (milliseconds). */
  seen: number
  told: number
}

/** A person as the others see them. */
export interface Present extends Who {
  branch?: string
  path?: string
  seen: number
}

/** Everybody is told again about a person at least this often (so that nobody counts as away while they are not). */
export const TELL_EVERY_MS = 60_000

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined)

export class Hub {
  #state: HubState
  #log: ActivityLog | undefined
  #now: () => number

  constructor(state: HubState, _env?: unknown, now: () => number = Date.now) {
    this.#state = state
    this.#now = now
    this.#log = state.storage?.sql ? new ActivityLog(state.storage.sql) : undefined
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  #broadcast(message: string): void {
    for (const socket of this.#state.getWebSockets()) {
      try {
        socket.send(message)
      } catch {
        // a connection that is gone: the others still get it
      }
    }
  }

  /** Everybody who is connected (a person on several devices once, with what they did last); `except` is a connection that is closing. */
  presence(except?: HubSocket): { type: 'presence'; now: number; users: Present[] } {
    const byLogin = new Map<string, Present>()
    for (const socket of this.#state.getWebSockets()) {
      if (socket === except) continue
      const a = socket.deserializeAttachment() as Attached | null
      if (!a?.login) continue
      const known = byLogin.get(a.login)
      if (!known || a.seen > known.seen) byLogin.set(a.login, { login: a.login, name: a.name, avatar: a.avatar, branch: a.branch, path: a.path, seen: a.seen })
    }
    return { type: 'presence', now: this.#now(), users: [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login)) }
  }

  #tellPresence(except?: HubSocket): void {
    this.#broadcast(JSON.stringify(this.presence(except)))
  }

  /** A browser is connected: it hears who is there, and the others hear about it. */
  join(socket: HubSocket, who: Who): void {
    const now = this.#now()
    socket.serializeAttachment({ ...who, seen: now, told: now } satisfies Attached)
    this.#tellPresence()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/notify') {
      this.#broadcast(await request.text())
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/activity') return this.#activity(request, url)
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 })
    // The Worker says who it is (from the session); what a browser sends along itself is not trusted.
    const login = text(request.headers.get('x-login'), 100)
    if (!login) return new Response('Who are you?', { status: 400 })
    const pair = new WebSocketPair()
    this.#state.acceptWebSocket(pair[1])
    this.join(pair[1] as unknown as HubSocket, { login, name: text(request.headers.get('x-name'), 200) ?? login, avatar: text(request.headers.get('x-avatar'), 500) ?? '' })
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }

  /** POST /activity (a line: from the webhook), GET /activity?login=&before=&limit= (the lines and how far that person has read), POST /activity?login=&seen=<id>. */
  async #activity(request: Request, url: URL): Promise<Response> {
    const log = this.#log
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (!log) return json({ error: 'There is no storage.' }, 503)
    if (request.method === 'POST' && !url.searchParams.has('seen')) {
      const input = (await request.json().catch(() => undefined)) as ActivityInput | undefined
      if (!input || typeof input.kind !== 'string' || typeof input.actor !== 'string') return json({ error: 'Not a line.' }, 400)
      const event = log.add(input, this.#now())
      this.#broadcast(JSON.stringify({ type: 'activity', event }))
      return json(event)
    }
    const login = url.searchParams.get('login')
    if (!login) return json({ error: 'Who?' }, 400)
    if (request.method === 'POST') {
      const upto = Number(url.searchParams.get('seen'))
      if (!Number.isInteger(upto) || upto < 0) return json({ error: 'Not an id.' }, 400)
      return json({ seen: log.markSeen(login, upto) })
    }
    const before = url.searchParams.get('before')
    const events: ActivityEvent[] = log.list(Number(url.searchParams.get('limit') ?? 50) || 50, before === null ? undefined : Number(before))
    return json({ events, seen: log.seen(login) })
  }

  /** What a browser says about itself: "presence" with the submission and the entry it works on (nothing: it is only active). */
  webSocketMessage(socket: HubSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || message.length > 1000) return
    let data: { type?: unknown; branch?: unknown; path?: unknown }
    try {
      data = JSON.parse(message)
    } catch {
      return
    }
    if (data.type !== 'presence') return
    const before = socket.deserializeAttachment() as Attached | null
    if (!before?.login) return
    const now = this.#now()
    const branch = text(data.branch, 300)
    const path = text(data.path, 500)
    const away = now - before.seen > 120_000
    const changed = branch !== before.branch || path !== before.path || away
    const tell = changed || now - before.told >= TELL_EVERY_MS
    socket.serializeAttachment({ ...before, branch, path, seen: now, told: tell ? now : before.told } satisfies Attached)
    if (tell) this.#tellPresence()
  }

  webSocketClose(socket: HubSocket, code: number): void {
    try {
      socket.close(code === 1005 ? 1000 : code)
    } catch {
      // already closed
    }
    // The socket that closes may still be in the list: tell the others without it.
    this.#tellPresence(socket)
  }
}
