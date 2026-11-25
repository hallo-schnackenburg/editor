// What a change does to an entry, in a form to read: field by field (what an editor wants to see), or line by line (the YAML).

import { MODEL, readObject, type EntryType } from '@editor/core'

export interface FieldChange {
  /** The field as it is written in the entry ("text.teaser" for a role of the text). */
  field: string
  /** What the person reads. */
  label: string
  before?: string
  after?: string
  /** A list of plain values (ids, names) as lines: what stayed, what was taken out, what was put in. */
  list?: Line[]
}

const scalar = (value: unknown): string => (typeof value === 'string' ? value.trimEnd() : typeof value === 'object' && value !== null ? show(value) : String(value))

/** A value as text: a list as lines, a map as `key: value`. */
function show(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v !== null ? Object.values(v).map(scalar).join(' · ') : scalar(v))).join('\n')
  if (typeof value === 'object' && value !== null) return Object.entries(value).map(([k, v]) => `${k}: ${scalar(v)}`).join(', ')
  return scalar(value)
}

/** The fields of an entry as `field → text`; the roles of `text` are fields of their own. */
function flatten(object: Record<string, unknown> | undefined): Map<string, string> {
  const fields = new Map<string, string>()
  for (const [key, value] of Object.entries(object ?? {})) {
    if (key === 'text' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [role, text] of Object.entries(value)) fields.set(`text.${role}`, scalar(text))
    } else fields.set(key, show(value))
  }
  return fields
}

function labelOf(type: string | undefined, field: string): string {
  const fields = type && type in MODEL.types ? (MODEL.types[type as EntryType].fields as Record<string, { label: string }>) : {}
  if (field.startsWith('text.')) {
    const role = field.slice(5)
    const roles = MODEL.textRoles as Record<string, { label: string }>
    return `${fields.text?.label ?? 'Text'}: ${roles[role]?.label ?? role}`
  }
  return fields[field]?.label ?? field
}

const isPlainList = (value: unknown): value is unknown[] => Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)

/** The difference of two lists of plain values (one of them may be missing), or nothing if a field is not such a list. */
function listDiff(before: unknown, after: unknown): Line[] | undefined {
  if (!(Array.isArray(before) || Array.isArray(after))) return undefined
  if ((before !== undefined && !isPlainList(before)) || (after !== undefined && !isPlainList(after))) return undefined
  return lineDiff(before === undefined ? undefined : (before as unknown[]).map(String).join('\n'), after === undefined ? undefined : (after as unknown[]).map(String).join('\n'))
}

/** The fields that differ between the two versions of an entry (either may be missing: added, removed), in the order of the entry. */
export function fieldChanges(before: string | undefined, after: string | undefined): FieldChange[] {
  const was = before === undefined ? undefined : readObject(before)
  const is = after === undefined ? undefined : readObject(after)
  const type = (is?.type ?? was?.type) as string | undefined
  const a = flatten(was)
  const b = flatten(is)
  const changes: FieldChange[] = []
  for (const field of new Set([...b.keys(), ...a.keys()])) {
    if (a.get(field) === b.get(field)) continue
    const list = listDiff(was?.[field], is?.[field])
    changes.push({ field, label: labelOf(type, field), ...(list ? { list } : { ...(a.has(field) ? { before: a.get(field) } : {}), ...(b.has(field) ? { after: b.get(field) } : {}) }) })
  }
  return changes
}

export interface Line {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** The lines of two versions of a text, with what was taken out and put in (the longest common sequence; entries are small). */
export function lineDiff(before: string | undefined, after: string | undefined): Line[] {
  const a = before === undefined ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === undefined ? [] : after.replace(/\n$/, '').split('\n')
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const lines: Line[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) lines.push({ kind: 'same', text: a[i++] }) && j++
    else if (table[i + 1][j] >= table[i][j + 1]) lines.push({ kind: 'del', text: a[i++] })
    else lines.push({ kind: 'add', text: b[j++] })
  }
  while (i < a.length) lines.push({ kind: 'del', text: a[i++] })
  while (j < b.length) lines.push({ kind: 'add', text: b[j++] })
  return lines
}
