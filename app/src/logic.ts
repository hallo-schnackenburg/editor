// What the editor does with entries, without any screen: reading one, finding its problems, changing a field,
// making a new one. The texts stay YAML texts all along, so that comments and the author's formatting survive.

import type { FileEntry } from './prepare.js'
import { MODEL, checkEvent, checkGroups, occurrences, checkParent, checkPath, checkRefs, refsOf, entryPath, objectId, readObject, replaceIds, setField, setId, setText, slugify, validateEntryYaml, type EntryType, type IndexEntry as Line, type Issue, type Lookup } from '@editor/core'

export type Data = Record<string, unknown>

/** An entry in the editor: where it lies, the version the server has (none for a new one), and the text now and as saved. */
export interface Entry {
  path: string
  sha?: string
  saved: string
  text: string
  /** The text, parsed (undefined while it is not valid YAML). */
  data?: Data
  /** Only the line of the index is known (see `makeStub`): the text is a marker, the data is what the index has. */
  unloaded?: true
}

/** What stands for the text of an entry whose file is not read: the version it would have (YAML never starts with an @). */
export const marker = (sha: string): string => `@${sha}`
export const isMarker = (text: string | undefined): boolean => text !== undefined && text.startsWith('@')

/** An entry as far as the index tells: enough for the tree, the search, the references and the checks of the others; the file is read when it is opened. */
export function makeStub(line: Line): Entry {
  const data: Data = { id: line.id ?? line.path, type: line.type, [line.type in MODEL.types ? nameFieldOf(line.type as EntryType) : 'name']: line.title }
  for (const key of ['kind', 'subtype', 'parent', 'parents', 'date', 'refs'] as const) if (line[key] !== undefined) data[key] = line[key]
  if (line.stub) data.stub = true
  if (line.recurring) data.recurring = true
  if (line.hint) data[line.type === 'content' ? 'published' : 'address'] = line.hint
  const text = marker(line.sha)
  return { path: line.path, sha: line.sha, saved: text, text, data, unloaded: true }
}

/** The ids an entry refers to: from its fields, or (an entry that is not read) from the index. */
export const refsIn = (entry: Entry): string[] => (entry.unloaded ? ((entry.data?.refs as string[] | undefined) ?? []) : entry.data ? refsOf(entry.data) : [])

export const makeEntry = (path: string, text: string, sha?: string, saved = text): Entry => ({ path, sha, saved, text, data: readObject(text) })

export function withText(entry: Entry, text: string): Entry {
  const { unloaded: _read, ...rest } = entry
  return { ...rest, text, data: readObject(text) }
}

export const isDirty = (entry: Entry) => entry.text !== entry.saved

/** The id: as the entry says, else from where it lies (an entity: the path below the folder of its type; others: the file name). */
export const idOf = (entry: Entry): string => {
  if (typeof entry.data?.id === 'string') return entry.data.id
  const path = entry.path.replace(/\.yaml$/, '')
  return path.startsWith('entities/') ? path.split('/').slice(2).join('/') : (path.split('/').pop() ?? '')
}
export const typeOf = (entry: Entry): EntryType | undefined => (typeof entry.data?.type === 'string' && entry.data.type in MODEL.types ? (entry.data.type as EntryType) : undefined)

/** What a person calls it: the name, the title, or at last the id. */
export function titleOf(entry: Entry): string {
  const d = entry.data
  for (const key of ['name', 'title']) if (typeof d?.[key] === 'string' && d[key]) return d[key] as string
  return idOf(entry)
}

/** Every problem of an entry: the shape, where it lies, and where its references lead. */
export function issuesOf(entry: Entry, all: Entry[]): Issue[] {
  const own = validateEntryYaml(entry.text)
  if (own.length > 0 || !entry.data) return own
  const index = new Map<string, { type: string; data?: Data }>()
  for (const e of all) {
    const type = typeOf(e)
    if (type) index.set(idOf(e), { type, data: e.data })
  }
  const lookup: Lookup = (id) => index.get(id)
  return [...checkPath(entry.path, entry.data), ...checkRefs(entry.data, lookup), ...checkParent(entry.data, (id) => index.get(id)), ...checkGroups(entry.data, (id) => index.get(id)), ...checkEvent(entry.data)]
}

/** The field an issue belongs to: "/about/1" is about, "/text/teaser" is text. "/" belongs to none. */
/** What an issue says, in words for the person: "Name fehlt". */
const WORDS: [RegExp, string][] = [
  [/^not a subtype of /, 'Das ist kein Untertyp dieses Typs'],
  [/^does not apply to /, 'Gilt nicht für diesen Typ'],
  [/^a file of .* has the role /, 'Diese Datei hat nicht die Rolle, die dieser Typ verlangt'],
  [/^the pages are numbered \(num\)$/, 'Die Seiten sind nummeriert (num)'],
  [/ has at most \d+ files?$/, 'Dieser Typ hat nicht so viele Dateien'],
  [/ has no files of its own$/, 'Eine Gruppe hat keine eigenen Dateien'],
  [/^storage is external: say where/, 'Anderswo abgelegt: bitte die Fundstelle angeben'],
  [/^external only goes with storage: external$/, 'Eine Fundstelle gehört nur zu „Anderswo“'],
  [/ is not a group$/, 'Das ist keine Gruppe'],
  [/^an object cannot be in itself/, 'Ein Objekt kann nicht in sich selbst liegen'],
  [/^not a valid id: a ULID/, 'Keine gültige ID (ULID in Kleinbuchstaben, 26 Zeichen)'],
  [/^a one-off event needs a date$/, 'Ein einmaliges Ereignis braucht mindestens einen Termin'],
  [/^not a date$/, 'Kein gültiges Datum'],
  [/^the end is before the start$/, 'Das Ende liegt vor dem Beginn'],
  [/^the start of the rule is no date$/, 'Der Beginn der Regel ist kein Datum'],
  [/^the rule is not an RRULE$/, 'Das ist keine RRULE'],
  [/^the rule needs FREQ/, 'FREQ fehlt (DAILY, WEEKLY, MONTHLY oder YEARLY)'],
  [/^BYEASTER and BYADVENT cannot be used together$/, 'BYEASTER und BYADVENT gehen nicht zusammen'],
  [/^(BYEASTER|BYADVENT) needs numbers of days/, 'BYEASTER und BYADVENT brauchen ganze Zahlen (Tage), zum Beispiel BYEASTER=-1'],
  [/^(BYEASTER|BYADVENT) goes with FREQ=YEARLY$/, 'BYEASTER und BYADVENT gehören zu FREQ=YEARLY'],
  [/^(BYEASTER|BYADVENT) cannot be combined with (\w+)$/, 'BYEASTER und BYADVENT gehen nur mit FREQ, INTERVAL, COUNT und UNTIL'],
  [/^(INTERVAL|COUNT) needs a number$/, 'INTERVAL und COUNT brauchen eine ganze Zahl'],
  [/^UNTIL needs a date/, 'UNTIL braucht ein Datum, zum Beispiel 20301231'],
  [/^the rule is not valid/, 'Keine gültige RRULE'],
]

/** What an issue of the model says, in German where the editor knows it (else as it is). */
export function issueText(message: string): string {
  return WORDS.find(([pattern]) => pattern.test(message))?.[1] ?? message
}

export function describeIssue(entry: Entry, issue: Issue): string {
  const type = typeOf(entry)
  const fields = (type ? MODEL.types[type].fields : {}) as Record<string, { label: string }>
  const missing = /^missing field "(.+)"$/.exec(issue.message)
  if (missing) return `${fields[missing[1]]?.label ?? missing[1]} fehlt`
  if (/cannot lie in itself/.test(issue.message)) return 'Ein Ort kann nicht in sich selbst liegen'
  const label = fields[fieldOfIssue(issue) ?? '']?.label
  return label ? `${label}: ${issueText(issue.message)}` : issueText(issue.message)
}

/** What an entry is called in a list: its name, or for a new one without a name "Neu: Ereignis". */
export function shownTitle(entry: Entry): string {
  const type = typeOf(entry)
  const name = type ? entry.data?.[nameFieldOf(type)] : undefined
  return type && !name ? `Neu: ${MODEL.types[type].label}` : titleOf(entry)
}

/** The ids a reference field must not offer: the entry itself, and for the place it lies in also the places that lie in it (a circle). */
export function excludedTargets(entry: Entry, field: string, all: Entry[]): string[] {
  const out = new Set([idOf(entry)])
  if (field === 'parent') {
    for (let grew = true; grew; ) {
      grew = false
      for (const e of all) {
        const parent = e.data?.parent
        if (!out.has(idOf(e)) && typeof parent === 'string' && out.has(parent)) {
          out.add(idOf(e))
          grew = true
        }
      }
    }
  }
  if (field === 'parents') {
    // Only groups hold objects, and a group cannot be put into one that lies in it (a circle).
    for (let grew = true; grew; ) {
      grew = false
      for (const e of all) {
        const parents = Array.isArray(e.data?.parents) ? e.data.parents : []
        if (!out.has(idOf(e)) && parents.some((p: unknown) => typeof p === 'string' && out.has(p))) {
          out.add(idOf(e))
          grew = true
        }
      }
    }
    for (const e of all) if (typeOf(e) === 'object' && e.data?.kind !== 'group') out.add(idOf(e))
  }
  return [...out]
}

export const fieldOfIssue = (issue: Issue): string | undefined => issue.path.split('/')[1] || undefined

/** The entries by type, in the order of the model, each group sorted by what people call the entries. */
export function groups(entries: Entry[], filter = ''): { type: EntryType; label: string; entries: Entry[] }[] {
  const needle = filter.trim().toLowerCase()
  const match = (e: Entry) => !needle || titleOf(e).toLowerCase().includes(needle) || idOf(e).includes(needle)
  return (Object.keys(MODEL.types) as EntryType[])
    .map((type) => ({ type, label: MODEL.types[type].label, entries: entries.filter((e) => typeOf(e) === type && match(e)).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'de')) }))
    .filter((g) => g.entries.length > 0)
}

export type FieldKind = 'string' | 'choice' | 'boolean' | 'date' | 'ref' | 'links' | 'location' | 'dates' | 'rule' | 'text' | 'files' | 'group' | 'other'

/** Sets one field. An empty value takes the field out of the entry. The text is the one thing it is based on, so nothing can clash. */
export function setValue(entry: Entry, field: string, kind: FieldKind, value: unknown): string {
  let v: unknown = value
  if (kind === 'links') v = (value as { label: string; url: string }[]).filter((l) => l.label.trim() && l.url.trim())
  if (kind === 'dates') v = (value as { start: string }[]).filter((d) => d.start)
  if (kind === 'rule') {
    const { rrule, start } = value as { rrule: string; start: string }
    v = rrule.trim() && start ? { rrule: rrule.trim(), start } : undefined
  }
  if (kind === 'location') {
    const { lat, lon } = value as { lat: number | null; lon: number | null }
    v = typeof lat === 'number' && typeof lon === 'number' && !Number.isNaN(lat) && !Number.isNaN(lon) ? { lat, lon } : undefined
  }
  if (kind === 'boolean' && value === false) v = undefined
  if (kind === 'files' && (value as unknown[]).length === 0) v = undefined
  if (kind === 'group') {
    // The parts that are empty go; without any part the field goes.
    const parts = Object.entries(value as Record<string, unknown>).filter(([, part]) => (Array.isArray(part) ? part.length > 0 : typeof part === 'string' ? part.trim() !== '' : part !== undefined && part !== null))
    v = parts.length > 0 ? Object.fromEntries(parts) : undefined
  }
  const result = setField(entry.text, field, v, entry.data?.[field])
  if (!result.ok) throw new Error(`The field "${field}" has changed in the meantime.`)
  return result.text
}

/**
 * The list of files of an object with one more file: the role it has follows from the kind of the object (the first role of the kind; a file of
 * what is kept elsewhere is a thumbnail), pages are numbered on, and an object that has room for one file takes the new one in place of the old.
 */
export function withFile(existing: FileEntry[], file: FileEntry, kind: string, external: boolean): { files: FileEntry[] } | { problem: string } {
  const rule = ((MODEL.types.object as unknown as { kinds: Record<string, { files?: { roles?: readonly string[]; numbered?: boolean; max?: number } }> }).kinds[kind]?.files ?? {}) as { roles?: readonly string[]; numbered?: boolean; max?: number }
  if (existing.some((f) => f.sha256 === file.sha256)) return { problem: 'Diese Datei gehört schon dazu.' }
  if (!external && rule.max === 0) return { problem: 'Dieses Objekt hat keine eigenen Dateien.' }
  const entry: FileEntry = { ...file, role: external ? 'thumbnail' : (rule.roles?.[0] ?? 'main') }
  if (!external && rule.max === 1) return { files: [entry] }
  if (!external && rule.max !== undefined && existing.length >= rule.max) return { problem: `Hier sind höchstens ${rule.max} Dateien vorgesehen.` }
  if (rule.numbered && !external) entry.num = Math.max(0, ...existing.map((f) => (typeof f.num === 'number' ? f.num : 0))) + 1
  return { files: [...existing, entry] }
}

/** The files with the numbers (of the pages) following the order of the list again: after a file moved or was removed. */
export const renumbered = (files: FileEntry[]): FileEntry[] => files.map((file, i) => ({ ...file, num: i + 1 }))

/** The list with the file `by` places further (negative: earlier); the same list when it cannot move. Numbered files get their numbers anew. */
export function movedFile(files: FileEntry[], sha: string, by: number, numbered: boolean): FileEntry[] {
  const from = files.findIndex((f) => f.sha256 === sha)
  const to = from + by
  if (from < 0 || to < 0 || to >= files.length) return files
  const next = [...files]
  next.splice(to, 0, ...next.splice(from, 1))
  return numbered ? renumbered(next) : next
}

export const setRole = (entry: Entry, role: string, value: string): string => setText(entry.text, role, value)

/** Where a new entry is to be made, as a place in the tree suggests it: the type (if the place decides it), the folder, the parent and the kind of a place. */
export interface NewContext {
  type?: EntryType
  /** Entities: the folder below the folder of the type ("gummern", "schnackenburg/elbstrasse"). Contents: the topic. */
  folder: string
  parent?: string
  kind?: string
}

export interface NewOptions {
  /** The place a new place lies in. */
  parent?: string
  kind?: string
  /** Whether an id is in use: if so, a number is put at the end of the name part (erika-mueller-2). */
  taken?: (id: string) => boolean
}

/** The folders of a path typed by a person: slugs between slashes, empty parts dropped. */
export const folderSegments = (folder: string): string[] => folder.split('/').map(slugify).filter(Boolean)

/**
 * A new entry of this type with the name (or title) given. An entity lies in a folder of its type, free below that, and its
 * id is the path ("gummern/3"). A content needs the topic: the one folder it is filed in. An object has no folder to choose (its id is a ULID).
 */
export function newEntry(type: EntryType, label: string, folder = '', random?: (bytes: Uint8Array) => Uint8Array, options: NewOptions = {}): Entry {
  const t = MODEL.types[type]
  const slug = t.class === 'object' ? objectId(undefined, random) : slugify(label)
  if (!slug) throw new Error('Der Name ergibt keine gültige ID: mindestens ein Buchstabe oder eine Ziffer.')
  const field = 'name' in t.fields ? 'name' : 'title'
  const quoted = JSON.stringify(label.trim())
  const topic = slugify(folder)
  if (t.class === 'content' && !topic) throw new Error('Ein Inhalt gehört in ein Thema (Ordner): bitte eines angeben.')
  const folders = t.class === 'entity' ? folderSegments(folder) : []
  const idFor = (name: string) => [...folders, name].join('/')
  let id = idFor(slug)
  for (let n = 2; options.taken?.(id); n++) id = idFor(`${slug}-${n}`)
  const path = entryPath(type, id, t.class === 'content' ? topic : undefined)
  const extra = `${options.kind && 'kind' in t.fields ? `kind: ${options.kind}\n` : ''}${options.parent && 'parent' in t.fields ? `parent: ${options.parent}\n` : ''}`
  return makeEntry(path, `id: ${id}\ntype: ${type}\n${field}: ${quoted}\n${extra}`, undefined, '')
}

const typeAt = (dir: string): EntryType | undefined => (Object.keys(MODEL.types) as EntryType[]).find((t) => MODEL.types[t].class === 'entity' && MODEL.types[t].dir === dir)

/** A place that other places lie in: a locality, a street or a square. */
export const holds = (e?: Entry): e is Entry => !!e && typeOf(e) === 'place' && ['locality', 'street', 'square'].includes(String(e.data?.kind))

/** What a new place in a street or on a square is: a building; in a folder "sonstige": another place. */
const kindIn = (parent: Entry | undefined, folder: string) => (['street', 'square'].includes(String(parent?.data?.kind)) ? 'building' : folder.split('/').pop() === 'sonstige' ? 'other' : undefined)

/**
 * What a new entry in the folder at `path` is like. `own`: the entry beside the folder (gummern.yaml beside gummern/), `holder`: the
 * nearest place above that others lie in. A new place gets as its parent the folder's own place, else the holder.
 */
export function newContextFor(path: string, own?: Entry, holder?: Entry): NewContext | undefined {
  const [top, second, ...rest] = path.split('/')
  if (top === 'entities' && second === undefined) return undefined // the types below it have a plus each
  if (top === 'contents') return { type: 'content', folder: second ?? '' }
  if (top === 'objects') return second === undefined ? { type: 'object', folder: '' } : undefined // the folders below are made by the app
  const type = typeAt(`${top}/${second}`)
  if (!type) return undefined
  const folder = rest.join('/')
  if (type === 'place' && folder === '') return { type, folder, kind: 'locality' } // directly under "Orte" lie the localities (towns, villages); everything else goes into one
  const parent = type === 'place' ? (holds(own) ? own : holder) : undefined
  return { type, folder, ...(parent ? { parent: idOf(parent), kind: kindIn(parent, folder) } : {}) }
}

/** A place that has no folder yet but could hold others (a street without houses): a new place goes into the folder of its name. */
export function newContextBelow(e: Entry): NewContext | undefined {
  return holds(e) ? { type: 'place', folder: idOf(e), parent: idOf(e), kind: kindIn(e, idOf(e)) } : undefined
}

/** The name of an entry under the entry its folder is named after: "Am Markt 3" under "Am Markt" is "Nr. 3". */
export function shortName(name: string, parentName?: string): string {
  if (parentName && name.length > parentName.length + 1 && name.startsWith(`${parentName} `)) {
    const rest = name.slice(parentName.length + 1)
    return /^\d/.test(rest) ? `Nr. ${rest}` : rest
  }
  return name
}

/** What renaming an entry does: the entries that move (with a new id and path), and the ones that stay and only get new references. */
export interface RenamePlan {
  /** The entry that is renamed first, then the ones below it (their folder is named after it). */
  moves: { before: Entry; after: Entry }[]
  rewrites: { before: Entry; after: Entry }[]
  /** Paths of entries the plan needs but that are known from the index only: they are read first, else the plan is not carried out. */
  unread: string[]
}

/** The field that names an entry: `name`, else `title`. */
export const nameFieldOf = (type: EntryType): 'name' | 'title' => ('name' in MODEL.types[type].fields ? 'name' : 'title')

/**
 * The id and the file follow the name (and, if a `folder` is given, the folder): an entity keeps its folders and takes the slug of the name as the last part, a content keeps its
 * topic and takes the slug as its id. What lies below the entity (its folder, `gummern/3` below `gummern`) moves with it, and every
 * reference to anything that moved is rewritten. Objects are not renamed (their ids are made once, a ULID).
 * Returns nothing if there is nothing to do; throws (with words for the person) if the new id is not possible or in use
 * (`taken` tells whether a path is in use), so that nothing is changed.
 */
export function planRename(entry: Entry, all: Entry[], taken: (path: string) => boolean, folder?: string): RenamePlan | undefined {
  const type = typeOf(entry)
  if (!type || !entry.data) return undefined
  const t = MODEL.types[type]
  if (t.class === 'object') return undefined
  const name = entry.data[nameFieldOf(type)]
  if (typeof name !== 'string' || !name.trim()) return undefined
  const slug = slugify(name)
  if (!slug) throw new Error('Der Name ergibt keine gültige ID: mindestens ein Buchstabe oder eine Ziffer.')

  const oldId = idOf(entry)
  // An entity can also be moved: with a `folder` (the part of the id before the last one) it goes there, otherwise it keeps its own.
  const target = t.class === 'entity' && folder !== undefined ? folderSegments(folder).join('/') : oldId.split('/').slice(0, -1).join('/')
  if (t.class === 'entity' && (target === oldId || target.startsWith(`${oldId}/`))) throw new Error('Ein Eintrag kann nicht in sich selbst oder in etwas darunter verschoben werden.')
  const newId = t.class === 'entity' ? [target, slug].filter(Boolean).join('/') : slug
  if (newId === oldId) return undefined

  const topic = t.class === 'content' ? entry.path.split('/')[1] : undefined
  const pathFor = (id: string) => entryPath(type, id, topic)
  const below = t.class === 'entity' ? all.filter((e) => e.path.startsWith(`${t.dir}/${oldId}/`)) : []

  const moving = [entry, ...below]
  const ids = new Map<string, string>()
  const moves = moving.map((before) => {
    const id = before === entry ? newId : `${newId}${idOf(before).slice(oldId.length)}`
    ids.set(idOf(before), id)
    return { before, id, path: pathFor(id) }
  })
  for (const m of moves) {
    if (taken(m.path) && !moving.some((e) => e.path === m.path)) throw new Error(`Es gibt schon einen Eintrag mit der ID „${m.id}“.`)
  }

  // References to anything that moved, in every entry (the ones that move get theirs in the text they take along).
  const rewrite = (text: string, data: Data | undefined, own: EntryType | undefined): string => {
    if (!own || !data) return text
    let result = text
    for (const [field, spec] of Object.entries(MODEL.types[own].fields) as [string, { ref?: readonly string[] }][]) {
      if (!spec.ref?.includes(type)) continue
      result = replaceIds(result, field, ids)
    }
    return result
  }

  const plan: RenamePlan = { moves: [], rewrites: [], unread: [] }
  for (const m of moves) {
    if (m.before.unloaded) {
      // Known from the index only: its path and id are worked out, its text is for later (`unread`).
      plan.unread.push(m.before.path)
      plan.moves.push({ before: m.before, after: { ...m.before, path: m.path, sha: undefined, data: { ...m.before.data, id: m.id } } })
      continue
    }
    const text = rewrite(setId(m.before.text, m.id), m.before.data, typeOf(m.before))
    plan.moves.push({ before: m.before, after: makeEntry(m.path, text, undefined, '') })
  }
  for (const e of all) {
    if (moving.includes(e)) continue
    if (e.unloaded) {
      if (refsIn(e).some((id) => ids.has(id))) plan.unread.push(e.path)
      continue
    }
    const text = rewrite(e.text, e.data, typeOf(e))
    if (text !== e.text) plan.rewrites.push({ before: e, after: withText(e, text) })
  }
  return plan
}

/**
 * What deleting an entry does to the others: the references to it are taken out of their texts (an id out of a list, a single
 * reference removed), and nothing else changes. Returns the entries that change, each as it is and as it becomes.
 */
export function planRemoval(entry: Entry, all: Entry[]): { before: Entry; after: Entry }[] {
  const type = typeOf(entry)
  if (!type) return []
  const id = idOf(entry)
  const changes: { before: Entry; after: Entry }[] = []
  for (const other of all) {
    const own = typeOf(other)
    if (other === entry || !own || !other.data) continue
    let text = other.text
    for (const [field, spec] of Object.entries(MODEL.types[own].fields) as [string, { ref?: readonly string[] }][]) {
      if (!spec.ref?.includes(type)) continue
      const value = other.data[field]
      const has = Array.isArray(value) ? value.includes(id) : value === id
      if (!has) continue
      const next = Array.isArray(value) ? value.filter((v) => v !== id) : undefined
      const result = setField(text, field, next, value)
      if (result.ok) text = result.text
    }
    if (text !== other.text) changes.push({ before: other, after: withText(other, text) })
  }
  return changes
}

/** The folders an entity type has (the part of the ids before the last one, and every part of it above), for choosing where to move to. */
export function foldersOf(type: EntryType, entries: Entry[]): string[] {
  const found = new Set<string>()
  for (const e of entries) {
    if (typeOf(e) !== type) continue
    const parts = idOf(e).split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) found.add(parts.slice(0, i).join('/'))
  }
  return [...found].sort()
}

/** The folder of an entity (its id without the last part), or none. */
export const folderOf = (entry: Entry): string => idOf(entry).split('/').slice(0, -1).join('/')

/** A date (or date with a time) the way people read it: "Sa., 04.04.2026, 20:00 Uhr". What is no date is shown as it is. */
export function whenText(when: unknown): string {
  if (typeof when !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(when)) return String(when ?? '')
  const day = new Date(`${when.slice(0, 10)}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
  return when.length > 10 ? `${day}, ${when.slice(11, 16)} Uhr` : day
}

/** The upcoming dates of a rule (from today on); none if the rule is not right. */
export function nextDates(rule: { rrule: string; start: string }, count = 3): string[] {
  try {
    const from = new Date().toISOString().slice(0, 10)
    return occurrences({ rule }, from, `${Number(from.slice(0, 4)) + 15}-12-31`).slice(0, count).map((o) => o.start)
  } catch {
    return []
  }
}
