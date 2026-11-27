// Finds the persons, organizations, places, events and things the contents talk about, makes entities of them (a name only, tagged
// `_stub`) and sets them as `about` of the content.
//
//   npm run extract-entities -- <data repository> [--write] [--limit=N] [--only=slug,slug]
//
// Without `--write` nothing is changed: the run says what it would do. The model's answers are kept in a cache (`.tmp/extract-cache`),
// so that `--write` after a trial run, or a second run, costs nothing. The key is in the environment: ANTHROPIC_API_KEY.
//
// What the model says is checked here, not believed: a mention counts only if it quotes the text word for word and every word of the
// name is in the text (or the name is that of an entity we have). Nothing is made up about an entity: no description, no address, no
// contact data (a phone number or an e-mail address in a name is thrown away). Where the entity is a place, a locality it lies in is
// taken only if the model named one and it is one we know.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { MODEL, slugify } from '../src/index.js'

export type EntityType = 'person' | 'organization' | 'place' | 'event' | 'thing'
export const TYPES: readonly EntityType[] = ['person', 'organization', 'place', 'event', 'thing']
export const KINDS = Object.keys(MODEL.types.place.fields.kind.options as Record<string, string>)

export interface Mention {
  name: string
  type: EntityType
  kind?: string
  /** The locality a place lies in, as the text names it. */
  in?: string
  /** A passage of the text that says it, word for word. */
  evidence: string
}
export interface Planned {
  id: string
  type: EntityType
  name: string
  kind?: string
  parent?: string
  /** Already in the repository (nothing to write). */
  existing: boolean
}
export type Ask = (system: string, user: string) => Promise<unknown>

export const PROMPT_VERSION = 1
export const SYSTEM = `You read a short German text of a municipal website (Schnackenburg an der Elbe) and list the named things in it that deserve an entry in a knowledge base.

Types: person (a named individual, written as "Vorname Nachname", without title or role, never a contact detail), organization (a named club, association, authority, church parish, company, museum), place (a named locality, street, square, building, lookout, bathing spot, river harbor...; kind: locality, street, square, building or other), event (a named event or tradition, e.g. a festival), thing (a named single object, e.g. a ferry or a monument).

Rules:
- Only what the text names. No guessing, no general knowledge, nothing the text only implies. Leave out generic words (the mayor, the church, the village) and countries, states, districts and cities far away that play no part.
- name: the full proper name as the text gives it (the longest form it uses; without "e.V." and without a person's title). If the text means one of the known entities, take its exact name.
- evidence: a passage of the text, 3 to 12 words, copied exactly, that contains the name or says what it is.
- in: for a place that is not a locality, the name of the locality (village or town) it lies in, only if the text says so; else leave it out.
- Never put a phone number, an e-mail address, a street address or a date in a name.
- At most 40 mentions. The title of the text is often the main subject: include it if it is a named entity.`

const SCHEMA = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: [...TYPES] },
          kind: { type: 'string', enum: KINDS },
          in: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['name', 'type', 'evidence'],
      },
    },
  },
  required: ['mentions'],
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
const STOP = new Set(['und', 'der', 'die', 'das', 'von', 'vom', 'zum', 'zur', 'den', 'dem', 'des', 'am', 'im', 'an', 'in'])
/** The words that make a name (slug pieces of at least three letters, without small words). */
const wordsOf = (name: string): string[] => slugify(name).split('-').filter((w) => w.length >= 3 && !STOP.has(w))

/** The mentions the model gave, as far as they have the right shape. */
export function shape(raw: unknown): Mention[] {
  const list = isRecord(raw) && Array.isArray(raw.mentions) ? raw.mentions : []
  const out: Mention[] = []
  for (const m of list) {
    if (!isRecord(m) || typeof m.name !== 'string' || typeof m.evidence !== 'string') continue
    const name = m.name.replace(/\s+/g, ' ').trim()
    const type = TYPES.find((t) => t === m.type)
    if (!type || name.length < 2 || name.length > 120) continue
    if (/\d{4,}|@|\+\d|https?:/.test(name)) continue // contact data is no name
    const mention: Mention = { name, type, evidence: m.evidence.trim() }
    if (type === 'place' && typeof m.kind === 'string' && KINDS.includes(m.kind)) mention.kind = m.kind
    if (type === 'place' && typeof m.in === 'string' && m.in.trim()) mention.in = m.in.trim()
    out.push(mention)
  }
  return out
}

/** Whether the text really says it: the passage is in it word for word, and every word of the name is (as a beginning of a word). */
export function grounded(m: Mention, text: string, known: readonly Known[]): boolean {
  if (!squash(text).includes(squash(m.evidence)) || m.evidence.length < 3) return false
  if (known.some((k) => k.type === m.type && slugify(k.name) === slugify(m.name))) return true
  const tokens = slugify(text).split('-')
  return wordsOf(m.name).every((w) => tokens.some((t) => t.startsWith(w)))
}

export interface Known {
  id: string
  type: EntityType
  name: string
}

export class Plan {
  /** key (type + slug) → entity */
  readonly entities = new Map<string, Planned>()
  /** The ids of the entities (there and planned). */
  readonly taken: Set<string>
  /** The ids of the contents. An id is one of an entity or of a content, never of both: a content gives way (`osterfeuer` → `osterfeuer-text`). */
  readonly contents: Set<string>
  /** content id → the id it gets instead */
  readonly renames = new Map<string, string>()
  constructor(known: Known[], contentIds: string[]) {
    this.taken = new Set(known.map((k) => k.id))
    this.contents = new Set(contentIds)
    for (const k of known) this.entities.set(`${k.type}:${slugify(k.name)}`, { ...k, existing: true })
  }

  get known(): Known[] {
    return [...this.entities.values()].map(({ id, type, name }) => ({ id, type, name }))
  }

  /** Takes the mentions of one text; returns the ids it is about (the new and the ones that were there). */
  add(mentions: Mention[], text: string): string[] {
    const ids: string[] = []
    // localities first: a place that lies in one needs it
    const sorted = [...mentions].sort((a, b) => Number(b.kind === 'locality') - Number(a.kind === 'locality'))
    for (const m of sorted) {
      if (!grounded(m, text, this.known)) continue
      const key = `${m.type}:${slugify(m.name)}`
      const found = this.entities.get(key)
      if (found) {
        ids.push(found.id)
        continue
      }
      const planned = this.make(m)
      this.entities.set(key, planned)
      ids.push(planned.id)
    }
    return [...new Set(ids)]
  }

  private make(m: Mention): Planned {
    const slug = slugify(m.name) || 'unbenannt'
    let folder = ''
    let parent: string | undefined
    if (m.type === 'place') {
      const holder = m.in ? this.entities.get(`place:${slugify(m.in)}`) : undefined
      if (holder && holder.kind === 'locality' && m.kind !== 'locality') parent = holder.id
      if (m.kind === 'locality') folder = ''
      else if (parent) folder = m.kind === 'other' || !m.kind ? `${parent}/sonstige/` : `${parent}/`
      else folder = 'sonstige/'
    }
    let id = `${folder}${slug}`
    if (this.contents.has(id) && !this.taken.has(id)) {
      let to = `${id}-text`
      for (let n = 2; this.contents.has(to) || this.taken.has(to); n++) to = `${id}-text-${n}`
      this.renames.set(id, to)
      this.contents.delete(id)
      this.contents.add(to)
    }
    for (let n = 2; this.taken.has(id) || this.contents.has(id); n++) id = `${folder}${slug}-${n}`
    this.taken.add(id)
    return { id, type: m.type, name: m.name, ...(m.type === 'place' && m.kind ? { kind: m.kind } : {}), ...(parent ? { parent } : {}), existing: false }
  }
}

export const entityYaml = (e: Planned): string =>
  YAML.stringify({ id: e.id, type: e.type, name: e.name, ...(e.kind ? { kind: e.kind } : {}), ...(e.parent ? { parent: e.parent } : {}), tags: ['_stub'] }, { lineWidth: 0 })

/** The text of a content file with `about` set to these ids (the ones it has stay, in front). Changes nothing else. */
export function withAbout(text: string, ids: string[]): string {
  const doc = YAML.parseDocument(text)
  if (!YAML.isMap(doc.contents)) return text
  const map = doc.contents as YAML.YAMLMap<unknown, unknown>
  const had = map.get('about')
  const old = YAML.isSeq(had) ? had.items.map((i) => String(YAML.isScalar(i) ? i.value : i)) : []
  const all = [...new Set([...old, ...ids])]
  if (all.length === old.length) return text
  const node = doc.createNode(all) as YAML.YAMLSeq
  node.flow = true
  if (had) map.set('about', node)
  else {
    const at = map.items.findIndex((p) => YAML.isScalar(p.key) && p.key.value === 'text')
    map.items.splice(at < 0 ? map.items.length : at, 0, doc.createPair('about', node))
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
}

/** The text of a content file with another id. */
export function withId(text: string, id: string): string {
  const doc = YAML.parseDocument(text)
  doc.set('id', id)
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
}

/** What is said to the model about one content. Pictures and links are left out; a very long text is cut for the model only. */
export function userMessage(title: string, body: string, known: readonly Known[]): string {
  const plainBody = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 14000)
  const names = known.slice(-400).map((k) => `- ${k.type}: ${k.name}`).join('\n')
  return `Known entities (use the exact name when the text means the same):\n${names || '(none yet)'}\n\nTitle: ${title}\n\nText:\n${plainBody}`
}

/** The call to the model: one forced tool, so the answer is the list. */
export function anthropic(key: string, model = process.env.EXTRACT_MODEL ?? 'claude-haiku-5-5', fetchFn: typeof fetch = fetch): Ask {
  return async (system, user) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system,
          tools: [{ name: 'extract', description: 'The named things in the text.', input_schema: SCHEMA }],
          tool_choice: { type: 'tool', name: 'extract' },
          messages: [{ role: 'user', content: user }],
        }),
      })
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
        continue
      }
      if (!res.ok) throw new Error(`The model answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const body = (await res.json()) as { content?: { type: string; input?: unknown }[] }
      return body.content?.find((c) => c.type === 'tool_use')?.input
    }
  }
}

const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])) : [])

export interface RunOptions {
  root: string
  ask: Ask
  write?: boolean
  limit?: number
  only?: string[]
  cache?: string
  log?: (line: string) => void
}

/** Pairs of new entities of one type that may be one: one name is part of the other, or most words are shared. */
export function likelyTheSame(entities: Planned[]): [Planned, Planned][] {
  const pairs: [Planned, Planned][] = []
  for (let i = 0; i < entities.length; i++)
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i]
      const b = entities[j]
      if (a.type !== b.type) continue
      const wa = new Set(wordsOf(a.name))
      const wb = new Set(wordsOf(b.name))
      const shared = [...wa].filter((w) => wb.has(w)).length
      if (shared > 0 && shared / Math.min(wa.size, wb.size) >= 0.99 && wa.size !== wb.size) pairs.push([a, b])
      else if (shared >= 2 && shared / Math.max(wa.size, wb.size) >= 0.6) pairs.push([a, b])
    }
  return pairs
}

export async function run({ root, ask, write = false, limit, only, cache, log = console.log }: RunOptions): Promise<{ planned: Planned[]; changed: number; renamed: number }> {
  const entityFiles = walk(join(root, 'entities')).filter((p) => p.endsWith('.yaml'))
  const known: Known[] = []
  for (const p of entityFiles) {
    const d = YAML.parse(readFileSync(p, 'utf8')) as Record<string, unknown> | null
    if (d && typeof d.id === 'string' && typeof d.name === 'string' && TYPES.includes(d.type as EntityType)) known.push({ id: d.id, type: d.type as EntityType, name: d.name })
  }
  const contentFiles = walk(join(root, 'contents')).filter((p) => p.endsWith('.yaml') && !p.endsWith('/.folder.yaml'))
  const contents = contentFiles.map((path) => {
    const text = readFileSync(path, 'utf8')
    const d = (YAML.parse(text) ?? {}) as { id?: string; title?: string; text?: Record<string, string> }
    return { path, text, id: d.id ?? '', title: d.title ?? '', body: d.text?.body ?? Object.values(d.text ?? {})[0] ?? '' }
  })
  const plan = new Plan(known, contents.map((c) => c.id))
  const chosen = contents.filter((c) => !only?.length || only.includes(c.id)).slice(0, limit)
  const edits: { path: string; text: string }[] = []
  if (cache) mkdirSync(cache, { recursive: true })
  for (const c of chosen) {
    if (!c.body) continue
    const user = userMessage(c.title, c.body, plan.known)
    const file = cache ? join(cache, `${c.id}.json`) : undefined
    const key = createHash('sha1').update(`${PROMPT_VERSION}\n${SYSTEM}\n${c.title}\n${c.body}`).digest('hex')
    let raw: unknown
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { key: string; raw: unknown }
      if (saved.key === key) raw = saved.raw
    }
    if (raw === undefined) {
      raw = await ask(SYSTEM, user)
      if (file) writeFileSync(file, JSON.stringify({ key, raw }, null, 1))
    }
    const mentions = shape(raw)
    const before = plan.entities.size
    const ids = plan.add(mentions, `${c.title}\n${c.body}`)
    log(`${c.id}: ${ids.length ? ids.join(', ') : '-'}${plan.entities.size > before ? `  (+${plan.entities.size - before} new)` : ''}`)
    if (ids.length) edits.push({ path: c.path, text: withAbout(c.text, ids) })
  }
  // a content whose id an entity takes gives way: new id, new file name (nothing refers to a content)
  const renamed = new Map<string, string>()
  for (const [from, to] of plan.renames) {
    const c = contents.find((x) => x.id === from)
    if (c) renamed.set(c.path, to)
  }

  const planned = [...plan.entities.values()].filter((e) => !e.existing)
  const count = (t: EntityType) => planned.filter((e) => e.type === t).length
  log(`\n${planned.length} new entities: ${TYPES.map((t) => `${count(t)} ${t}`).join(', ')}`)
  const same = likelyTheSame(planned)
  if (same.length) log(`\nMaybe the same (look at these):\n${same.map(([a, b]) => `  ${a.type}: "${a.name}" / "${b.name}"`).join('\n')}`)
  const changed = edits.filter((e) => e.text !== readFileSync(e.path, 'utf8'))
  if (write) {
    for (const e of planned) {
      const path = join(root, MODEL.types[e.type].dir, `${e.id}.yaml`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, entityYaml(e))
    }
    for (const e of changed) {
      writeFileSync(e.path, e.text)
    }
    for (const [path, to] of renamed) {
      writeFileSync(join(dirname(path), `${to}.yaml`), withId(readFileSync(path, 'utf8'), to))
      unlinkSync(path)
    }
    log(`\nWritten: ${planned.length} entities, ${changed.length} contents changed, ${renamed.size} renamed (${relative(process.cwd(), root) || root}).`)
  } else log(`\nNothing written (without --write). ${changed.length} contents would get \`about\`, ${renamed.size} would get another id.`)
  return { planned, changed: changed.length, renamed: renamed.size }
}

async function main(argv: string[]) {
  const root = argv.find((a) => !a.startsWith('--'))
  const opt = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const key = process.env.ANTHROPIC_API_KEY
  if (!root || !key) {
    console.error('usage: ANTHROPIC_API_KEY=… extract-entities.ts <data repository> [--write] [--limit=N] [--only=slug,slug]')
    process.exit(2)
  }
  const limit = opt('limit') ? Number(opt('limit')) : undefined
  await run({ root, ask: anthropic(key), write: argv.includes('--write'), limit, only: opt('only')?.split(',').filter(Boolean), cache: join(process.cwd(), '..', '.tmp', 'extract-cache') })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
