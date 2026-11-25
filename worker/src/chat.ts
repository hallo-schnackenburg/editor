// The chat with the model: what we send, and how its answer becomes tool calls. The model never changes anything: it answers
// with calls, the app carries them out in the person's editor. Looking things up (search, read) takes several rounds: the app
// answers the model's calls and sends the whole trail again, so this Worker keeps nothing between requests.
// Everything but `handleChat` is free of the network, so it can be tested on its own.

import { ENTRY_TYPES, MODEL, TEXT_ROLES, type EntryType } from '@contents-editor/core'
import { MAX_BODY, json } from './common.js'

export interface ChatEnv {
  ANTHROPIC_API_KEY?: string
  /** The model; Haiku is enough for short texts and fields. */
  MODEL?: string
}

/** An entry of the index the model gets, so that it can set references without looking anything up. */
export interface IndexEntry {
  id: string
  type: string
  name: string
}

/** What is going on in the app, as far as it matters to the person's requests. */
export interface AppState {
  /** The name of the submission that is worked on when somebody else started it, or none. */
  viewing: string | null
  /** The submission that is worked on (the draft that changes are saved to), if there is one yet. */
  draft: { name: string; state: string } | null
  /** The paths of the entries that are changed and not saved yet. */
  unsaved: string[]
  /** How many entries the draft differs from the database in. */
  changes: number
  /** The submissions of the others that are waiting or being worked on. */
  submissions: { number: number; name: string; author: string; state: string }[]
}

/** One round of looking things up: what the model called, and what the app answered. */
export interface TrailStep {
  calls: { id: string; tool: string; input: Record<string, unknown> }[]
  results: { id: string; text: string }[]
}

/** What the browser sends. */
export interface ChatRequest {
  message: string
  /** The entry that is open (its text as it is in the editor now), or none. */
  entry: { path: string; id: string; text: string } | null
  /** All entities with their id and name. */
  index: IndexEntry[]
  app: AppState
  history: { role: 'user' | 'assistant'; text: string }[]
  /** The rounds of this answer so far. */
  trail: TrailStep[]
}

/**
 * What the model asks for. `id` is the model's own number of the call, which its answer has to refer to. `entry` is an id or a path.
 * Where an action is hard to take back or others see it, the app asks the person before it does it.
 */
export type ToolCall = { id?: string } & (
  | { tool: 'say'; text: string }
  // looking things up: the app answers, and the model goes on
  | { tool: 'search'; query: string; type?: EntryType }
  | { tool: 'read_entry'; entry: string }
  | { tool: 'list_changes' }
  | { tool: 'read_submission'; number: number }
  // moving around
  | { tool: 'open_entry'; entry: string }
  | { tool: 'open_submission'; number: number }
  | { tool: 'show_own_work' }
  // changes that stay unsaved until "Fertig"
  | { tool: 'patch'; field: string; value: unknown; old?: unknown }
  | { tool: 'set_text'; role: string; value: string }
  | { tool: 'create_entry'; type: EntryType; name: string; folder?: string; fields?: Record<string, unknown> }
  | { tool: 'rename_draft'; name: string }
  // asked about first
  | { tool: 'save' }
  | { tool: 'discard_unsaved' }
  | { tool: 'take_back'; entry: string }
  | { tool: 'delete_entry'; entry?: string }
  | { tool: 'rename_entry'; entry?: string; name: string }
  | { tool: 'move_entry'; entry?: string; folder: string }
  | { tool: 'submit_draft' }
  | { tool: 'accept_submission'; number: number }
  | { tool: 'close_submission'; number: number }
  | { tool: 'comment_submission'; number: number; text: string }
)

export class BadRequest extends Error {}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const text = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined)
const integer = (x: unknown): number | undefined => (Number.isInteger(x) ? (x as number) : undefined)

const MAX_INDEX = 1500
const MAX_STEPS = 10

/** Checks what the browser sends. Also keeps a request from becoming very expensive. */
export function parseChatRequest(data: unknown): ChatRequest {
  if (!isRecord(data)) throw new BadRequest('Body must be a JSON object.')
  const { message, entry, index, history, app, trail } = data
  if (typeof message !== 'string' || message.length === 0 || message.length > 4000) throw new BadRequest('message: text of 1 to 4000 characters expected.')
  if (!Array.isArray(index) || index.length > MAX_INDEX) throw new BadRequest(`index: list of at most ${MAX_INDEX} expected.`)
  if (!Array.isArray(history) || history.length > 30) throw new BadRequest('history: list of at most 30 expected.')
  if (entry !== null && !(isRecord(entry) && typeof entry.path === 'string' && typeof entry.id === 'string' && typeof entry.text === 'string' && entry.text.length <= 30000)) {
    throw new BadRequest('entry: {path, id, text} or null expected.')
  }
  if (!isRecord(app) || (app.viewing !== null && typeof app.viewing !== 'string') || !Array.isArray(app.unsaved) || !Array.isArray(app.submissions) || typeof app.changes !== 'number') {
    throw new BadRequest('app: {viewing, draft, unsaved, changes, submissions} expected.')
  }
  if (app.submissions.length > 60 || app.unsaved.length > 200) throw new BadRequest('app: too many submissions or entries.')
  if (!Array.isArray(trail) || trail.length > MAX_STEPS) throw new BadRequest(`trail: list of at most ${MAX_STEPS} expected.`)

  return {
    message,
    entry: entry === null ? null : { path: (entry as { path: string }).path.slice(0, 300), id: (entry as { id: string }).id.slice(0, 200), text: (entry as { text: string }).text },
    index: index.map((e) => {
      if (!isRecord(e) || typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.name !== 'string') throw new BadRequest('index: {id, type, name} expected.')
      return { id: e.id.slice(0, 200), type: e.type.slice(0, 40), name: e.name.slice(0, 100) }
    }),
    app: {
      viewing: app.viewing === null ? null : String(app.viewing).slice(0, 120),
      draft: isRecord(app.draft) && typeof app.draft.name === 'string' && typeof app.draft.state === 'string' ? { name: app.draft.name.slice(0, 120), state: app.draft.state.slice(0, 20) } : null,
      unsaved: app.unsaved.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 300)),
      changes: app.changes,
      submissions: app.submissions.map((s) => {
        if (!isRecord(s) || typeof s.number !== 'number' || typeof s.name !== 'string' || typeof s.author !== 'string' || typeof s.state !== 'string') throw new BadRequest('app.submissions: {number, name, author, state} expected.')
        return { number: s.number, name: s.name.slice(0, 120), author: s.author.slice(0, 60), state: s.state.slice(0, 20) }
      }),
    },
    history: history.map((h) => {
      if (!isRecord(h) || (h.role !== 'user' && h.role !== 'assistant') || typeof h.text !== 'string') throw new BadRequest('history: {role, text} expected.')
      return { role: h.role, text: h.text.slice(0, 2000) }
    }),
    trail: trail.map((step) => {
      if (!isRecord(step) || !Array.isArray(step.calls) || !Array.isArray(step.results) || step.calls.length > 20 || step.results.length > 20) throw new BadRequest('trail: {calls, results} expected.')
      const calls = step.calls.map((c) => {
        if (!isRecord(c) || typeof c.id !== 'string' || !/^[\w-]{1,80}$/.test(c.id) || typeof c.tool !== 'string' || !TOOL_NAMES.includes(c.tool) || !isRecord(c.input) || JSON.stringify(c.input).length > 30000) {
          throw new BadRequest('trail.calls: {id, tool, input} expected.')
        }
        return { id: c.id, tool: c.tool, input: c.input }
      })
      const results = step.results.map((r) => {
        if (!isRecord(r) || typeof r.id !== 'string' || typeof r.text !== 'string') throw new BadRequest('trail.results: {id, text} expected.')
        return { id: r.id, text: r.text.slice(0, 12000) }
      })
      return { calls, results }
    }),
  }
}

// The chat makes no objects (they need files, which the browser handles).
const CHAT_TYPES = ENTRY_TYPES.filter((type) => MODEL.types[type].class !== 'object')

interface FieldDef {
  label: string
  kind: string
  options?: Record<string, string>
  ref?: readonly string[]
  single?: boolean
  multiline?: boolean
  description?: string
}
const fieldsOf = (type: EntryType): Record<string, FieldDef> => MODEL.types[type].fields as unknown as Record<string, FieldDef>

/** The name field of a type: the one the person names the entry with, and the id follows. The chat does not change it with patch. */
export const nameFieldOf = (type: EntryType): string => ('name' in fieldsOf(type) ? 'name' : 'title')

function describeField(name: string, field: FieldDef): string {
  const detail =
    field.kind === 'choice' && field.options
      ? `one of: ${Object.entries(field.options).map(([key, label]) => `${key} (${label})`).join(', ')}`
      : field.kind === 'ref'
        ? `${field.single ? 'one id' : 'a list of ids'} of ${(field.ref ?? []).join(' or ')}`
        : field.kind === 'links'
          ? 'a list of {label, url}'
          : field.kind === 'location'
            ? '{lat, lon}'
            : field.kind === 'dates'
              ? 'a list of {start, end?, note?, cancelled?}'
              : field.kind === 'rule'
                ? '{rrule, start}'
            : field.kind === 'boolean'
              ? 'true or false'
              : field.kind === 'date'
                ? 'a date as text (YYYY, YYYY-MM or YYYY-MM-DD)'
                : field.kind
  return `${name} (${field.label}: ${detail}${field.description ? `. ${field.description}` : ''})`
}

/** The types and their fields, as the prompt names them; made from the model, so that a new field is known at once. */
function describeTypes(): string {
  return CHAT_TYPES.map((type) => {
    const t = MODEL.types[type]
    const fields = Object.entries(fieldsOf(type))
      .filter(([, f]) => !['files', 'text'].includes(f.kind))
      .map(([name, f]) => `  - ${describeField(name, f)}`)
      .join('\n')
    const subtypes = Object.keys(t.subtypes).length > 0 ? ` Subtypes: ${Object.keys(t.subtypes).join(', ')}.` : ''
    return `${type} (${t.label}, ${t.class}):${subtypes}\n${fields}${'text' in fieldsOf(type) ? '\n  - text: one text per role, set with set_text' : ''}`
  }).join('\n')
}

function describeRoles(): string {
  return TEXT_ROLES.map((role) => {
    const r = MODEL.textRoles[role] as { label: string; max?: number; description?: string }
    return `  - ${role} (${r.label})${r.max ? `, at most ${r.max} characters` : ''}${r.description ? `: ${r.description}` : ''}`
  }).join('\n')
}

export const SYSTEM_PROMPT = `You are the chat of the editor for the contents of the town of Schnackenburg an der Elbe (a database of places, people, organizations, things, events and texts). You can do everything in the editor that the person can do with the mouse.
For every message you answer ONLY by calling tools. The app carries them out; you never change anything yourself.

How the editor works: the person's changes first stand in the editor, unsaved. "Fertig" (save) writes them to the submission that is worked on, a pull request on GitHub that anybody in the team may change; with none yet, the first save makes a new one, as a draft. "Vorschlagen" (propose) takes the draft status away; somebody in the team accepts a proposed submission, which makes it part of the database. The person can switch to any submission that is not finished and work in it, and can accept or close submissions.

Context you get with each message: today's date, the state of the app, the entry that is open (its YAML as it is in the editor now, or "(none)"), and a list of all entities (type, id, name) that references can point to.

Tools that look something up. The app answers, and then you go on; use them as often as needed, then answer with the tools below:
- search: finds entries by words in their name, title, id or text (any type, also contents and objects).
- read_entry: reads an entry's YAML (the entry is its id or its path).
- list_changes: lists what the person's draft has saved.
- read_submission: what a submission does (the entries it adds, changes, removes), its checks and its comments.
- find_coordinates: looks a place up in OpenStreetMap and returns its coordinates (by default near Schnackenburg). The only source of coordinates besides the person: write them as the value of "location" ({lat, lon}) with patch. If there are several matches, ask which one is meant; if there is none, say so.
- web_search: searches the web and returns what the sources say, with their addresses. Use it for facts the person asks you to look up (opening hours, dates, history, addresses); say where it comes from, and write nothing into an entry that the sources do not say.

Tools that move around: open_entry (opens it in the form), open_submission, show_own_work (back from a submission that is looked at).

Tools that change entries, as unsaved changes the person looks at and finishes with "Fertig":
- patch: change one field of the OPEN entry. Pass the value you saw as "old", so that nothing the person typed in the meantime is overwritten. A field that is empty or missing has no old value: leave "old" out then. A list (links, references) is always sent whole, with the old list as "old". An empty value removes the field.
- set_text: set one text role of the open entry (see the roles below). The whole text of that role is sent.
- create_entry: make a new entry: type, name (the entry is filed under it; its id follows the name), folder (entities: the folder below their type, e.g. "gummern"; contents: the topic) and fields (the other fields, as far as the person said them). It becomes the open entry.
- rename_draft: give the person's draft another name.

Tools the app asks the person about first (with a button), because they are hard to take back or others see them. Call them when the person asks for it; never say you did it, the app tells them:
- save (like "Fertig": writes everything unsaved to the draft), discard_unsaved (throws away what is unsaved in the open entry), take_back (undoes a saved change of an entry), delete_entry, rename_entry (the id and file follow the name, what lies below moves along, references are rewritten), move_entry (to another folder, entities only), submit_draft, accept_submission, close_submission, comment_submission.
Without an entry given they concern the open entry.

Do what you can at once. Never announce ("dann trage ich ... ein") that you will do something after an answer: call the tools now with everything you know, and use say only to ask for what is really missing or to answer. If something is unclear (several entries fit), ask with say instead of guessing.

Types and their fields (YAML keys, in English):
${describeTypes()}

Text roles (below "text"; at least one is needed, and a missing one is derived from another where possible):
${describeRoles()}

Rules:
- The name or title, the id and the type of an entry are not changed with patch: use rename_entry (the person confirms).
- References hold ids from the list of entities (exactly as written there). Never invent an id. If the thing is not in the list, search first (it may be there under another name); if one entry could be meant, ask which. If there is none, offer to make it from the name and the type only (create_entry): the app marks such an entry as incomplete ("Unvollständig") so that it is completed later. Do not make up more than the person said.
- Do not invent facts: no guessed dates, names, addresses or coordinates. Write only what the person said, what is in the entry already, and what find_coordinates or web_search returned. When you write a text for the person (a description, a teaser, a post for social media), base it on the entry and what the person told you, and keep to the length of the role.
- Never write a placeholder such as "unbekannt", "<UNKNOWN>" or "?" into a field. If you do not know a value, leave the field out.
- Write names and places as the person gave them.
- Always answer in German, short and friendly, addressing the person with "du". Be soft: suggest and ask ("Magst du ...?"), never demand.`

const VALUE = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } },
  ],
}

const ENTRY = { type: 'string', description: 'The id or the path of an entry, as in the list or a search result.' }
const OPEN_ENTRY = { type: 'string', description: 'The id or the path of an entry. Without it: the open entry.' }
const NUMBER = { type: 'integer', description: 'The number of the submission.' }

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  name,
  description,
  input_schema: { type: 'object', properties, required },
})

export const TOOLS = [
  tool('search', 'Find entries by words in their name, title, id or text.', { query: { type: 'string' }, type: { type: 'string', enum: [...ENTRY_TYPES], description: 'Only this type.' } }, ['query']),
  tool('read_entry', 'Read the YAML of an entry.', { entry: ENTRY }, ['entry']),
  tool('list_changes', 'List what the draft has saved: new, changed, renamed and deleted entries.'),
  tool('read_submission', 'What a submission does, its checks and its comments.', { number: NUMBER }, ['number']),
  tool('find_coordinates', 'Look a place up in OpenStreetMap: its coordinates (lat, lon), name and kind. Near Schnackenburg unless "anywhere" is set.', { query: { type: 'string', description: 'What is looked for, e.g. "Aussichtsturm Schnackenburg".' }, anywhere: { type: 'boolean', description: 'Do not limit the search to the surroundings of Schnackenburg.' } }, ['query']),
  tool('web_search', 'Search the web; returns what the sources say, with their addresses.', { query: { type: 'string' } }, ['query']),
  tool('open_entry', 'Open an entry in the form.', { entry: ENTRY }, ['entry']),
  tool('open_submission', 'Look at a submission.', { number: NUMBER }, ['number']),
  tool('show_own_work', 'Go back from a submission that is looked at to the own work.'),
  tool('patch', 'Change one field of the open entry.', {
    field: { type: 'string', description: 'The YAML key, e.g. "description".' },
    value: { ...VALUE, description: 'The new value; empty removes the field.' },
    old: { ...VALUE, description: 'The current value, if the field had one.' },
  }, ['field', 'value']),
  tool('set_text', 'Set one text role of the open entry (a content).', { role: { type: 'string', enum: [...TEXT_ROLES] }, value: { type: 'string', description: 'The whole text of that role, Markdown.' } }, ['role', 'value']),
  tool('create_entry', 'Make a new entry. It becomes the open entry.', {
    type: { type: 'string', enum: CHAT_TYPES },
    name: { type: 'string', description: 'The name (a content: the title).' },
    folder: { type: 'string', description: 'Entities: the folder below their type. Contents: the topic.' },
    fields: { type: 'object', additionalProperties: true, description: 'Other fields as far as known, e.g. {"description": "..."}.' },
  }, ['type', 'name']),
  tool('rename_draft', 'Give the draft another name.', { name: { type: 'string' } }, ['name']),
  tool('save', 'Save everything that is unsaved to the draft ("Fertig"). The person is asked first.'),
  tool('discard_unsaved', 'Throw away what is unsaved in the open entry. The person is asked first.'),
  tool('take_back', 'Undo a saved change of an entry (a new one disappears, a changed one is as in the database, a deleted one is back). The person is asked first.', { entry: ENTRY }, ['entry']),
  tool('delete_entry', 'Delete an entry. The person is asked first.', { entry: OPEN_ENTRY }),
  tool('rename_entry', 'Rename an entry: its id and file follow, what lies below it moves along, references are rewritten. The person is asked first.', { entry: OPEN_ENTRY, name: { type: 'string' } }, ['name']),
  tool('move_entry', 'Move an entity to another folder below its type ("gummern/sonstige"); references are rewritten. The person is asked first.', { entry: OPEN_ENTRY, folder: { type: 'string' } }, ['folder']),
  tool('submit_draft', 'Propose the submission that is a draft (it stops being a draft, and the team may accept it). The person is asked first.'),
  tool('accept_submission', 'Accept a submission, which makes it part of the database. The person is asked first.', { number: NUMBER }, ['number']),
  tool('close_submission', 'Close a submission without accepting it. The person is asked first.', { number: NUMBER }, ['number']),
  tool('comment_submission', 'Write a comment under a submission. The person is asked first.', { number: NUMBER, text: { type: 'string' } }, ['number', 'text']),
  tool('say', 'Answer or ask the person something.', { text: { type: 'string' } }, ['text']),
]

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name)

type Turn = { role: 'user' | 'assistant'; content: string }
type Block = { type: string; [key: string]: unknown }
type Message = { role: 'user' | 'assistant'; content: string | Block[] }

/** A value the model made up for something it does not know: it must not end up in the YAML. */
const isPlaceholder = (value: unknown): boolean => typeof value === 'string' && /^\s*(<[^>]*>|\[[^\]]*\]|unknown|unbekannt|\?)\s*$/i.test(value)

/** The model wants alternating turns that start with the user; merge neighbours with the same role. */
function addTurn(turns: Turn[], role: Turn['role'], content: string) {
  const last = turns[turns.length - 1]
  if (last && last.role === role) last.content += `\n\n${content}`
  else if (last || role === 'user') turns.push({ role, content })
  // an assistant turn at the very start is dropped
}

/** Today's date in Schnackenburg's time zone, as "2026-11-09". */
export function todayIn(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function describeApp(app: AppState): string {
  const lines = [
    app.viewing === null ? 'Working in: the own draft.' : `Working in: the submission "${app.viewing}", which somebody else started.`,
    app.draft ? `Submission worked on: "${app.draft.name}" (${app.draft.state}); ${app.changes} entries differ from the database in it.` : 'Submission worked on: none yet (it is made with the first save).',
    app.unsaved.length > 0 ? `Unsaved: ${app.unsaved.join(', ')}.` : 'Unsaved: nothing.',
    app.submissions.length > 0
      ? `Submissions of others:\n${app.submissions.map((s) => `  #${s.number} "${s.name}" by ${s.author}, ${s.state}`).join('\n')}`
      : 'Submissions of others: none.',
  ]
  return lines.join('\n')
}

function describeContext(request: ChatRequest, now: Date): string {
  const entry = request.entry ? `Open entry (${request.entry.path}):\n\`\`\`yaml\n${request.entry.text.trim()}\n\`\`\`` : 'Open entry: (none)'
  const index = request.index.map((e) => `- ${e.type}: ${e.id} — ${e.name}`).join('\n')
  return [`Today is ${todayIn(now)}.`, `State of the app:\n${describeApp(request.app)}`, entry, `Entities (type: id — name):\n${index || '(none)'}`, `Message from the person:\n${request.message}`].join('\n\n')
}

export function buildModelRequest(request: ChatRequest, model: string, now: Date = new Date()) {
  const turns: Turn[] = []
  for (const entry of request.history) addTurn(turns, entry.role, entry.text)
  addTurn(turns, 'user', describeContext(request, now))
  const messages: Message[] = turns
  // The rounds of this answer so far: what the model called, and what the app answered to each call.
  for (const step of request.trail) {
    messages.push({ role: 'assistant', content: step.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.tool, input: c.input })) })
    messages.push({ role: 'user', content: step.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) })
  }
  return {
    model,
    // A text for social media can be long; the rest is short.
    max_tokens: 2048,
    // No temperature, top_p or top_k: Haiku 5.5 rejects them.
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    tool_choice: { type: 'any' }, // always answer with a tool call
    messages,
  }
}

type Parsed = Record<string, unknown>
/** What each tool takes: the call if the input makes sense, else nothing. */
const PARSERS: Record<string, (input: Parsed) => ToolCall | undefined> = {
  say: (i) => (text(i.text) ? { tool: 'say', text: text(i.text)! } : undefined),
  search: (i) => (text(i.query) ? { tool: 'search', query: text(i.query)!, type: typeof i.type === 'string' && (ENTRY_TYPES as readonly string[]).includes(i.type) ? (i.type as EntryType) : undefined } : undefined),
  read_entry: (i) => (text(i.entry) ? { tool: 'read_entry', entry: text(i.entry)! } : undefined),
  list_changes: () => ({ tool: 'list_changes' }),
  read_submission: (i) => (integer(i.number) !== undefined ? { tool: 'read_submission', number: integer(i.number)! } : undefined),
  open_entry: (i) => (text(i.entry) ? { tool: 'open_entry', entry: text(i.entry)! } : undefined),
  open_submission: (i) => (integer(i.number) !== undefined ? { tool: 'open_submission', number: integer(i.number)! } : undefined),
  show_own_work: () => ({ tool: 'show_own_work' }),
  patch: (i) => (text(i.field) && 'value' in i && !isPlaceholder(i.value) ? { tool: 'patch', field: text(i.field)!, value: i.value, old: i.old } : undefined),
  set_text: (i) => (typeof i.role === 'string' && (TEXT_ROLES as readonly string[]).includes(i.role) && typeof i.value === 'string' && !isPlaceholder(i.value) ? { tool: 'set_text', role: i.role, value: i.value } : undefined),
  create_entry: (i) =>
    typeof i.type === 'string' && (CHAT_TYPES as readonly string[]).includes(i.type) && text(i.name) && !isPlaceholder(i.name)
      ? {
          tool: 'create_entry',
          type: i.type as EntryType,
          name: text(i.name)!,
          folder: text(i.folder),
          fields: isRecord(i.fields) ? Object.fromEntries(Object.entries(i.fields).filter(([, value]) => !isPlaceholder(value))) : undefined,
        }
      : undefined,
  rename_draft: (i) => (text(i.name) ? { tool: 'rename_draft', name: text(i.name)! } : undefined),
  save: () => ({ tool: 'save' }),
  discard_unsaved: () => ({ tool: 'discard_unsaved' }),
  take_back: (i) => (text(i.entry) ? { tool: 'take_back', entry: text(i.entry)! } : undefined),
  delete_entry: (i) => ({ tool: 'delete_entry', entry: text(i.entry) }),
  rename_entry: (i) => (text(i.name) && !isPlaceholder(i.name) ? { tool: 'rename_entry', entry: text(i.entry), name: text(i.name)! } : undefined),
  move_entry: (i) => (typeof i.folder === 'string' ? { tool: 'move_entry', entry: text(i.entry), folder: i.folder.trim() } : undefined),
  submit_draft: () => ({ tool: 'submit_draft' }),
  accept_submission: (i) => (integer(i.number) !== undefined ? { tool: 'accept_submission', number: integer(i.number)! } : undefined),
  close_submission: (i) => (integer(i.number) !== undefined ? { tool: 'close_submission', number: integer(i.number)! } : undefined),
  comment_submission: (i) => (integer(i.number) !== undefined && text(i.text) ? { tool: 'comment_submission', number: integer(i.number)!, text: text(i.text)! } : undefined),
}

/** Turns the model's answer into tool calls (with the model's ids, so that the next round can answer them). Calls that do not make sense are dropped. */
export function toToolCalls(response: unknown): ToolCall[] {
  const content = isRecord(response) && Array.isArray(response.content) ? response.content : []
  const calls: ToolCall[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      calls.push({ tool: 'say', text: block.text.trim() })
    } else if (block.type === 'tool_use' && isRecord(block.input) && typeof block.name === 'string') {
      const call = PARSERS[block.name]?.(block.input)
      if (call) calls.push(typeof block.id === 'string' ? { ...call, id: block.id } : call)
    }
  }
  return calls.length > 0 ? calls : [{ tool: 'say', text: 'Das habe ich nicht verstanden. Magst du es anders sagen?' }]
}

/** The tools the Worker carries out itself (the app never sees them). */
const OWN_TOOLS = ['find_coordinates', 'web_search']
/** How often the model may look something up in one answer. */
const MAX_LOOKUPS = 4

/** Schnackenburg; places are looked for within about 30 km of it. */
const HOME = { lat: 52.99, lon: 11.57, dLat: 0.27, dLon: 0.45 }

/** Places from OpenStreetMap: name, kind and coordinates, as text for the model. */
export async function findCoordinates(query: string, anywhere: boolean, fetchFn: typeof fetch): Promise<string> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': 'de' })
  if (!anywhere) {
    params.set('viewbox', `${HOME.lon - HOME.dLon},${HOME.lat + HOME.dLat},${HOME.lon + HOME.dLon},${HOME.lat - HOME.dLat}`)
    params.set('bounded', '1')
  }
  try {
    const response = await fetchFn(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'user-agent': 'contents-editor (schnackenburg.de)', accept: 'application/json' } })
    if (!response.ok) return 'The place search is not available right now.'
    const found = (await response.json()) as { display_name?: string; category?: string; type?: string; lat?: string; lon?: string }[]
    const lines = found.filter((f) => f.lat && f.lon).map((f) => `- ${f.display_name ?? query} (${f.category ?? '?'}/${f.type ?? '?'}): lat ${Number(f.lat)}, lon ${Number(f.lon)}`)
    return lines.length > 0 ? lines.join('\n') : `Nothing found for "${query}"${anywhere ? '' : ' near Schnackenburg (try with anywhere, or other words)'}.`
  } catch {
    return 'The place search is not available right now.'
  }
}

/** A search of the web: the model is asked once more, with Anthropic's search tool, and answers with what the sources say. */
export async function searchWeb(query: string, env: ChatEnv, fetchFn: typeof fetch): Promise<string> {
  try {
    const response = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: env.MODEL ?? 'claude-haiku-5-5',
        max_tokens: 1024,
        system: 'Search the web for what is asked and answer briefly and factually with what the sources say; say if they disagree or if you found nothing. Name the sources (title and address). Do not add anything the sources do not say.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'DE', region: 'Niedersachsen', timezone: 'Europe/Berlin' } }],
        messages: [{ role: 'user', content: query }],
      }),
    })
    if (!response.ok) {
      console.error('Web search error', response.status, await response.text().catch(() => ''))
      return 'The web search is not available right now.'
    }
    const data = (await response.json()) as { content?: Block[] }
    const blocks = data.content ?? []
    const answer = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => String(b.text)).join('').trim()
    const sources = new Set<string>()
    for (const b of blocks) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content as { url?: string; title?: string }[]) if (r.url) sources.add(`${r.title ?? r.url} — ${r.url}`)
      }
    }
    const text = `${answer || 'Nothing found.'}${sources.size > 0 ? `\n\nSources:\n${[...sources].slice(0, 6).map((x) => `- ${x}`).join('\n')}` : ''}`
    return text.slice(0, 5000)
  } catch {
    return 'The web search is not available right now.'
  }
}

async function runLookup(block: Block, env: ChatEnv, fetchFn: typeof fetch): Promise<string> {
  const input = isRecord(block.input) ? block.input : {}
  const query = text(input.query)
  if (!query) return 'The query is missing.'
  return block.name === 'find_coordinates' ? findCoordinates(query, input.anywhere === true, fetchFn) : searchWeb(query, env, fetchFn)
}

/** `POST /chat`: asks the model and returns the calls. Only for signed-in people (the caller checks); the key never reaches the browser. */
export async function handleChat(request: Request, route: string, env: ChatEnv, fetchFn: typeof fetch): Promise<Response | undefined> {
  if (route !== '/chat') return undefined
  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404)
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Der Server hat keinen Anthropic-Schlüssel (worker/.secrets).' }, 500)

  let chat: ChatRequest
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY) throw new BadRequest('Request too large.')
    chat = parseChatRequest(JSON.parse(raw))
  } catch (error) {
    return json({ error: error instanceof BadRequest ? error.message : 'Body must be valid JSON.' }, 400)
  }

  const body = buildModelRequest(chat, env.MODEL ?? 'claude-haiku-5-5')
  for (let lookups = 0; ; lookups++) {
    let answer: Response
    try {
      answer = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      })
    } catch {
      return json({ error: 'Das Modell ist nicht erreichbar.' }, 502)
    }

    if (!answer.ok) {
      // The model's own explanation helps to find a mistake and holds no secrets.
      const detail = await answer.text().catch(() => '')
      console.error('Anthropic API error', answer.status, detail)
      let reason = ''
      try {
        reason = String(JSON.parse(detail)?.error?.message ?? '').slice(0, 300)
      } catch {
        // not JSON; keep only the status
      }
      return json({ error: `Das Modell hat mit einem Fehler geantwortet (${answer.status})${reason ? `: ${reason}` : ''}` }, 502)
    }
    const data = await answer.json()
    // What the Worker looks up itself (coordinates, the web) is answered here, and the model goes on; the rest goes to the app.
    const own = (isRecord(data) && Array.isArray(data.content) ? data.content : []).filter((b): b is Block => isRecord(b) && b.type === 'tool_use' && typeof b.name === 'string' && OWN_TOOLS.includes(b.name))
    if (own.length === 0 || lookups >= MAX_LOOKUPS) return json({ calls: toToolCalls(data) })
    const results = await Promise.all(own.map(async (b) => ({ type: 'tool_result', tool_use_id: b.id, content: await runLookup(b, env, fetchFn) })))
    body.messages.push({ role: 'assistant', content: own }, { role: 'user', content: results })
  }
}
