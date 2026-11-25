// Where an entry lives and what its id looks like. The id of an entity is its path below the folder of its type, without
// .yaml (the folders below are free); the id of a content or an object is the file name without .yaml. Contents are filed
// by topic in folders of their own choosing, objects below the last two characters of the id (a ULID begins with the time).

import { MODEL, type EntryType } from './model.generated.js'
import type { Issue } from './types.js'

const SEGMENT = '[a-z0-9][a-z0-9-]*'

/**
 * An entry file: lower-case segments, ending in .yaml. A content lies in exactly one topic folder (contents/<topic>/<id>.yaml),
 * entities in the folder of their type, objects below the last two characters of their id.
 */
export const ENTRY_PATH = new RegExp(`^(?:entities(?:/${SEGMENT})+|contents/${SEGMENT}/${SEGMENT}|objects/${SEGMENT}/${SEGMENT})\\.yaml$`)

/** The file that describes a topic folder of the contents (its name on screen, later more). It is not an entry. */
export const FOLDER_PATH = new RegExp(`^contents/${SEGMENT}/\\.folder\\.yaml$`)

/** Whether the editor keeps a file of this path: an entry, or the description of a folder. */
export const isStoredPath = (path: string): boolean => ENTRY_PATH.test(path) || FOLDER_PATH.test(path)

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' }
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

const ASSOCIATION = /(?<![\p{L}\p{N}])e\.\s?v\.?(?![\p{L}\p{N}])/giu

/** A readable id from a title or a name: lower case, umlauts written out, everything else a single hyphen. The legal form "e.V." is left out. */
export function slugify(text: string): string {
  const bare = text.replace(ASSOCIATION, ' ')
  return (/[\p{L}\p{N}]/u.test(bare) ? bare : text)
    .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUTS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

/** The id of an object: a ULID in lower case (10 characters of time, 16 random ones), so that it is unique and sorts by creation. */
export function objectId(now: number = Date.now(), random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  let time = ''
  for (let rest = Math.floor(now), i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time
  return time + Array.from(random(new Uint8Array(16)), (b) => CROCKFORD[b % 32]).join('')
}

/** The folder and file name of an entry. Entities: the id is the path below the folder of the type. Contents: the folder is the topic (one level), as the author chose it. */
export function entryPath(type: EntryType, id: string, topic?: string): string {
  const t = MODEL.types[type]
  if (t.class === 'object') return `${t.dir}/${id.slice(-2)}/${id}.yaml`
  if (t.class === 'content') {
    if (!topic) throw new Error('A content belongs in a topic folder.')
    return `${t.dir}/${topic}/${id}.yaml`
  }
  return `${t.dir}/${id}.yaml`
}

/** Checks that an entry is where its type and id say it must be. */
export function checkPath(path: string, entry: { id?: unknown; type?: unknown }): Issue[] {
  const { id, type } = entry
  if (typeof id !== 'string' || typeof type !== 'string' || !(type in MODEL.types)) return []
  const t = MODEL.types[type as EntryType]
  const issues: Issue[] = []
  if (!path.endsWith('.yaml')) issues.push({ path: '/', message: 'the file must end in .yaml' })
  if (t.class === 'entity') {
    const expected = entryPath(type as EntryType, id)
    if (path !== expected) issues.push(path.startsWith(`${t.dir}/`) ? { path: '/id', message: `the id must be the path below ${t.dir}/ without .yaml (${path.slice(t.dir.length + 1).replace(/\.yaml$/, '')})` } : { path: '/', message: `this belongs in ${t.dir}/ (the folders below are free)` })
    return issues
  }
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.yaml$/, '')
  if (name !== id) issues.push({ path: '/id', message: `the id must be the file name (${name})` })
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  if (t.class === 'content') {
    if (!new RegExp(`^${t.dir}/${SEGMENT}$`).test(folder)) issues.push({ path: '/', message: `a content belongs in a topic folder: ${t.dir}/<topic>/ (one level)` })
  } else if (folder !== entryPath(type as EntryType, id).slice(0, entryPath(type as EntryType, id).lastIndexOf('/'))) {
    issues.push({ path: '/', message: `this belongs in ${entryPath(type as EntryType, id)}` })
  }
  return issues
}

// --- the object store: the same layout as the archive's ---
const HEX64 = /^[0-9a-f]{64}$/

export function assertSha256(sha256: string): void {
  if (!HEX64.test(sha256)) throw new Error('not a sha256: 64 lower-case hex digits')
}

/** The folder of a file in the object store: files/<sha[0,2]>/<sha[2,2]>/<sha>. */
export function fileDir(sha256: string): string {
  assertSha256(sha256)
  return `files/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`
}

export const originalPath = (sha256: string, ext: string) => `${fileDir(sha256)}/original.${ext}`

/** A derived file sits next to the original: <name>.<first 12 hex of its own sha256>.<ext>. */
export function variantPath(originalSha256: string, name: string, variantSha256: string, ext: string): string {
  assertSha256(variantSha256)
  return `${fileDir(originalSha256)}/${name}.${variantSha256.slice(0, 12)}.${ext}`
}
