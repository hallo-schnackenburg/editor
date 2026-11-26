// What the hub tells about the team (worker/src/hub.ts, activity.ts): who is there and what they work on, and what the team did.

/** A person who has the editor open; `branch` and `path` say what they work on (the submission and the entry). */
export interface Present {
  login: string
  name: string
  avatar: string
  branch?: string
  path?: string
  /** The last time they did something (milliseconds, the clock of the server). */
  seen: number
}

export type ActivityKind = 'started' | 'submitted' | 'withdrawn' | 'merged' | 'closed' | 'reopened' | 'changes' | 'comment' | 'main'

/** A line of the activity stream. */
export interface ActivityEvent {
  id: number
  at: number
  updated: number
  actor: string
  kind: ActivityKind
  branch: string | null
  number: number | null
  count: number
}

export type TeamMessage = { type: 'presence'; now: number; users: Present[] } | { type: 'activity'; event: ActivityEvent }

/** What the browser says about what it works on. */
export interface Doing {
  branch?: string
  path?: string
}

/** The message of the hub if it is one for the team, else nothing (it is news then). */
export function teamOf(data: unknown): TeamMessage | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const raw = JSON.parse(data) as { type?: unknown; users?: unknown; event?: unknown; now?: unknown }
    if (raw.type === 'presence' && Array.isArray(raw.users)) return { type: 'presence', now: typeof raw.now === 'number' ? raw.now : Date.now(), users: raw.users as Present[] }
    if (raw.type === 'activity' && raw.event && typeof raw.event === 'object') return { type: 'activity', event: raw.event as ActivityEvent }
  } catch {
    // not for the team
  }
  return undefined
}

/** The lines the person has not read yet, not counting what they did themselves. */
export const unreadOf = (events: ActivityEvent[], seen: number, login: string) => events.filter((e) => e.id > seen && e.actor !== login)

/** The inbox: what concerns the person (their submissions and what is said to them), everything else is only in the whole log. */
export function inboxOf(events: ActivityEvent[], mine: (branch: string | null, number: number | null) => boolean, login: string): ActivityEvent[] {
  return events.filter((e) => e.actor !== login && (e.kind === 'main' ? false : mine(e.branch, e.number)))
}

/** The line as a German sentence (without the name of the person). */
export function describe(event: ActivityEvent): string {
  const of = event.number ? `Einreichung #${event.number}` : event.branch ? 'eine Einreichung' : 'eine Einreichung'
  switch (event.kind) {
    case 'started': return `hat ${of} begonnen`
    case 'submitted': return `hat ${of} eingereicht`
    case 'withdrawn': return `hat ${of} zurückgezogen`
    case 'merged': return `hat ${of} übernommen`
    case 'closed': return `hat ${of} geschlossen`
    case 'reopened': return `hat ${of} wieder geöffnet`
    case 'comment': return `hat ${of} kommentiert`
    case 'main': return event.count === 1 ? 'hat direkt eine Änderung übernommen' : `hat direkt ${event.count} Änderungen übernommen`
    case 'changes': return event.count === 1 ? `hat eine Änderung in ${of} gemacht` : `hat ${event.count} Änderungen in ${of} gemacht`
  }
}
