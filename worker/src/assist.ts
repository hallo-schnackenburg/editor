// The helper that fills in a form while the person types: `POST /assist`. The browser sends what the form holds and which fields the
// helper may fill (empty ones the person has not touched); the answer holds only what is safe to enter. The model never changes anything
// by itself and never supplies coordinates: those come from a search in OpenStreetMap (second stage). What the model says is checked
// field by field here (a choice is one of its options, a reference leads to an entry of the index), the rest is dropped.
// Everything but `handleAssist` is free of the network, so it can be tested on its own.

import { MODEL, type EntryType } from '@editor/core'
import { CHAT_TYPES, describeTypes, type ChatEnv, type IndexEntry } from './chat.js'
import { MAX_BODY, json } from './common.js'
import type { Auth } from './session.js'

export class BadAssist extends Error {}

/** `fields`: the type and the fields from what the form holds. `location`: the coordinates of the place or organization, from a map search. */
export type Stage = 'fields' | 'location'

export interface AssistRequest {
  stage: Stage
  /** The type of the entry, if the person has chosen it or it is known. */
  type: EntryType | null
  /** What the form holds now (the field values). */
  data: Record<string, unknown>
  /** The fields the helper may fill: empty, and not touched by the person. */
  open: string[]
  /** Entities with their id, type and name, so that references can be set without looking anything up. */
  index: IndexEntry[]
}

export interface AssistAnswer {
  type?: EntryType
  fields: Record<string, unknown>
  /** Where a value comes from, by field, if it is not the helper's own reading of the name (e.g. the map). */
  source?: Record<string, string>
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const MAX_INDEX = 1500

type FieldDef = { kind: string; options?: Record<string, string>; ref?: readonly string[]; single?: boolean; max?: number }
const fieldsOf = (type: EntryType): Record<string, FieldDef> => MODEL.types[type].fields as unknown as Record<string, FieldDef>

/** What the helper may fill at all: texts, choices, references, tags. Never files, texts by role, dates, rules, links or coordinates (those have their own way). */
const FILLABLE = new Set(['string', 'choice', 'ref', 'tags'])

export function parseAssistRequest(data: unknown): AssistRequest {
  if (!isRecord(data)) throw new BadAssist('Body must be an object.')
  const stage: Stage = data.stage === 'location' ? 'location' : 'fields'
  const type = typeof data.type === 'string' && (CHAT_TYPES as readonly string[]).includes(data.type) ? (data.type as EntryType) : null
  if (!isRecord(data.data)) throw new BadAssist('data must be an object.')
  const open = Array.isArray(data.open) ? data.open.filter((n): n is string => typeof n === 'string').slice(0, 40) : []
  const index = Array.isArray(data.index) ? data.index : []
  if (index.length > MAX_INDEX) throw new BadAssist('Too many entries in the index.')
  return {
    stage,
    type,
    data: data.data,
    open,
    index: index.flatMap((i) => (isRecord(i) && typeof i.id === 'string' && typeof i.type === 'string' && typeof i.name === 'string' ? [{ id: i.id, type: i.type, name: i.name }] : [])),
  }
}

export const ASSIST_PROMPT = `You help a person fill in a form of the editor for the contents of the town of Schnackenburg an der Elbe (places, people, organizations, events, things; a Stadtarchiv). The person is typing; you add what is plain from what they typed, so that they have less to do.

Rules:
- Fill only fields that are listed in "open", and only when you are sure from the name and the other fields. Leaving a field out is always right when in doubt.
- If the type is not known, say which type it is (the "type" of the answer).
- Never make up facts: no coordinates, dates, phone numbers, street addresses or descriptions that the person did not type.
- References: use ids from the index only, never an id that is not in it. A place that lies in another place has that place as its parent.
- Names of the town and places are German; "Freiwillige Feuerwehr Schnackenburg" is an organization in the place Schnackenburg.
- A place has a kind: locality (town, village, quarter), street, square, building, or other.
- Answer by calling fill. Put the fields in "fields", keyed by their names.

The types and their fields:
`

/** The request to the model: the fixed part (rules and types) and the index come first, so that they can be cached between calls. */
export function buildAssistModelRequest(request: AssistRequest, model: string) {
  const index = request.index.map((e) => `${e.id}|${e.type}|${e.name}`).join('\n')
  return {
    model,
    max_tokens: 700,
    system: [
      { type: 'text', text: ASSIST_PROMPT + describeTypes(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `The index (id|type|name):\n${index}`, cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      {
        name: 'fill',
        description: 'Say the type (if not known) and the fields to fill in.',
        input_schema: {
          type: 'object',
          properties: { type: { type: 'string', enum: CHAT_TYPES }, fields: { type: 'object', description: 'Field names with their values.' } },
          required: ['fields'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'fill' },
    messages: [{ role: 'user', content: JSON.stringify({ type: request.type, data: request.data, open: request.open }) }],
  }
}

/** What of the model's answer is safe to enter: known fields in `open`, with values the field accepts. */
export function sanitizeFill(raw: unknown, request: AssistRequest): AssistAnswer {
  const answer: AssistAnswer = { fields: {} }
  if (!isRecord(raw)) return answer
  const type = request.type ?? (typeof raw.type === 'string' && (CHAT_TYPES as readonly string[]).includes(raw.type) ? (raw.type as EntryType) : undefined)
  if (!request.type && type) answer.type = type
  if (!type || !isRecord(raw.fields)) return answer
  const defs = fieldsOf(type)
  const byId = new Map(request.index.map((e) => [e.id, e]))
  const open = new Set(request.open)
  for (const [name, value] of Object.entries(raw.fields)) {
    const def = defs[name]
    if (!def || !FILLABLE.has(def.kind) || !open.has(name)) continue
    const ok = clean(def, value, byId)
    if (ok !== undefined) answer.fields[name] = ok
  }
  return answer
}

function clean(def: FieldDef, value: unknown, byId: Map<string, IndexEntry>): unknown {
  if (def.kind === 'string') return typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : undefined
  if (def.kind === 'choice') return typeof value === 'string' && def.options && value in def.options ? value : undefined
  if (def.kind === 'tags') {
    const tags = Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string' && /^[^\s_][^\n]{0,39}$/.test(t.trim())).map((t) => t.trim()) : []
    return tags.length > 0 ? tags.slice(0, 8) : undefined
  }
  if (def.kind === 'ref') {
    const ids = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && !!byId.get(v) && (def.ref ?? []).includes(byId.get(v)!.type))
    if (ids.length === 0) return undefined
    return def.single ? ids[0] : ids.slice(0, def.max ?? 10)
  }
  return undefined
}

/** The model's answer: the arguments of its `fill` call. */
export function fillOf(response: unknown): unknown {
  const content = isRecord(response) && Array.isArray(response.content) ? response.content : []
  const call = content.find((b) => isRecord(b) && b.type === 'tool_use' && b.name === 'fill')
  return isRecord(call) ? call.input : undefined
}

/** Schnackenburg; places are looked for within about 30 km of it. */
const HOME = { lat: 53.037, lon: 11.568, dLat: 0.27, dLon: 0.45 }

/** One clear place from OpenStreetMap: nothing if there is none, or if the hits are not the same spot (then it is not clear which is meant). */
export async function locate(query: string, fetchFn: typeof fetch): Promise<{ lat: number; lon: number; name: string } | undefined> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': 'de', viewbox: `${HOME.lon - HOME.dLon},${HOME.lat + HOME.dLat},${HOME.lon + HOME.dLon},${HOME.lat - HOME.dLat}`, bounded: '1' })
  try {
    const response = await fetchFn(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'user-agent': 'contents-editor (schnackenburg.de)', accept: 'application/json' } })
    if (!response.ok) return undefined
    const found = ((await response.json()) as { display_name?: string; lat?: string; lon?: string }[]).filter((f) => f.lat && f.lon)
    if (found.length === 0) return undefined
    const [first] = found
    const near = found.every((f) => Math.abs(Number(f.lat) - Number(first.lat)) < 0.003 && Math.abs(Number(f.lon) - Number(first.lon)) < 0.005)
    if (!near) return undefined
    return { lat: Math.round(Number(first.lat) * 1e5) / 1e5, lon: Math.round(Number(first.lon) * 1e5) / 1e5, name: first.display_name ?? query }
  } catch {
    return undefined
  }
}

/** What to look for on the map: the address of a place if it has one, else its name with the place it lies in. */
export function locationQuery(request: AssistRequest): string | undefined {
  const d = request.data
  const name = typeof d.name === 'string' ? d.name.trim() : typeof d.title === 'string' ? d.title.trim() : ''
  if (!name) return undefined
  if (typeof d.address === 'string' && d.address.trim()) return d.address.trim()
  const parent = typeof d.parent === 'string' ? request.index.find((e) => e.id === d.parent)?.name : undefined
  return parent && !name.includes(parent) ? `${name}, ${parent}` : name
}

/** The least time between two calls of one person: a person typing is one call a while, a loop is stopped. */
const MIN_GAP_MS = 600
const lastCall = new Map<string, number>()

/** `POST /assist`. Only for signed-in people (the caller checks); the key never reaches the browser. */
export async function handleAssist(request: Request, route: string, session: Auth, env: ChatEnv, fetchFn: typeof fetch, now: () => number = Date.now): Promise<Response | undefined> {
  if (route !== '/assist') return undefined
  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404)
  const asked = lastCall.get(session.login) ?? 0
  if (now() - asked < MIN_GAP_MS) return json({ error: 'Zu viele Anfragen.' }, 429)
  lastCall.set(session.login, now())

  let assist: AssistRequest
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY) throw new BadAssist('Request too large.')
    assist = parseAssistRequest(JSON.parse(raw))
  } catch (error) {
    return json({ error: error instanceof BadAssist ? error.message : 'Body must be valid JSON.' }, 400)
  }

  if (assist.stage === 'location') {
    if (!assist.open.includes('location') || !assist.type || !('location' in fieldsOf(assist.type))) return json({ fields: {} })
    const query = locationQuery(assist)
    const found = query ? await locate(query, fetchFn) : undefined
    return json(found ? { fields: { location: { lat: found.lat, lon: found.lon } }, source: { location: `OpenStreetMap: ${found.name}` } } : { fields: {} })
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Der Server hat keinen Anthropic-Schlüssel (worker/.secrets).' }, 500)
  let answer: Response
  try {
    answer = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildAssistModelRequest(assist, env.MODEL ?? 'claude-haiku-5-5')),
    })
  } catch {
    return json({ error: 'Das Modell ist nicht erreichbar.' }, 502)
  }
  if (!answer.ok) {
    console.error('Anthropic API error (assist)', answer.status, await answer.text().catch(() => ''))
    return json({ error: `Das Modell hat mit einem Fehler geantwortet (${answer.status}).` }, 502)
  }
  return json(sanitizeFill(fillOf(await answer.json()), assist))
}
