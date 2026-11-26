// The index of a data repository: one small line per file instead of the whole file. The editor lists, searches and checks
// references on the index and loads an entry only when it is opened. CI builds it on every push to the base branch
// (core/scripts/build-index.ts, templates/validate.yml); the Worker completes it with what is newer than `commit`.

import { refsOf } from './consistency.js'
import { FOLDER_PATH, isStoredPath } from './paths.js'
import { folderTitle } from './folder.js'
import { readObject } from './yaml/read.js'
import type { RepoFile } from './repo.js'

export interface IndexEntry {
  path: string
  /** The git blob sha of the file: tells whether the file is still the one the line was made from. */
  sha: string
  /** Only for entries; a folder has none. */
  id?: string
  /** An entry type, or `folder` for the .folder.yaml of a topic. */
  type: string
  title: string
  /** For objects: the kind (image, document, …) and its subtype. */
  kind?: string
  subtype?: string
  /** A place lies in one parent, an object in several groups. */
  parent?: string
  parents?: string[]
  date?: string
  /** What tells entries of one type apart in a list: the day a content was published, the address of a place. */
  hint?: string
  /** A place: its postal code (the places below it take it from the nearest above that has one). */
  postal?: string
  /** An event that repeats by a rule. */
  recurring?: true
  /** The ids the entry refers to: who refers to an entry is found here, without reading the files. */
  refs?: string[]
  /** The tags of the entry (those that start with an underscore are internal). */
  tags?: string[]
}

export interface RepoIndex {
  version: 1
  /** The commit of the base branch the index was made from. */
  commit: string
  entries: IndexEntry[]
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** The line of one file, with the sha git has for it; undefined for a file that is not stored by the editor or whose YAML is not an object. */
export function indexEntry(file: RepoFile, sha: string): IndexEntry | undefined {
  if (!isStoredPath(file.path)) return undefined
  if (FOLDER_PATH.test(file.path)) return { path: file.path, sha, type: 'folder', title: folderTitle(file.text) ?? file.path.split('/')[1] }
  const data = readObject(file.text)
  if (!data) return undefined
  const id = text(data.id) ?? file.path.replace(/\.yaml$/, '')
  const parents = Array.isArray(data.parents) ? data.parents.filter((p): p is string => typeof p === 'string') : []
  const entry: IndexEntry = { path: file.path, sha, id, type: text(data.type) ?? '', title: text(data.name) ?? text(data.title) ?? id }
  for (const key of ['kind', 'subtype', 'parent', 'date'] as const) {
    const value = text(data[key])
    if (value) entry[key] = value
  }
  if (parents.length > 0) entry.parents = parents
  const hint = text(data.type === 'content' ? data.published : data.type === 'place' ? data.address : undefined)
  if (hint) entry.hint = hint
  if (data.type === 'place' && typeof data.postal_code === 'string' && data.postal_code) entry.postal = data.postal_code
  if (data.recurring === true) entry.recurring = true
  const refs = refsOf(data)
  if (refs.length > 0) entry.refs = refs
  if (Array.isArray(data.tags)) {
    const tags = data.tags.filter((t): t is string => typeof t === 'string')
    if (tags.length > 0) entry.tags = tags
  }
  return entry
}

/**
 * The texts of all entries in one go, for the editor's first start (it would need a request for every hundred entries otherwise):
 * one line of JSON each, `{"version":1,"commit":…}` first, then `{"path":…,"sha":…,"text":…}`. CI packs it with gzip next to the index.
 * Folders (.folder.yaml) are not in it, the index has their titles.
 */
export function buildBundle(files: RepoFile[], commit: string, shaOf: (text: string) => string): string {
  const lines = files.flatMap((file) => {
    const entry = indexEntry(file, shaOf(file.text))
    return entry && entry.type !== 'folder' ? [{ path: file.path, sha: entry.sha, text: file.text }] : []
  })
  lines.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return [JSON.stringify({ version: 1, commit }), ...lines.map((l) => JSON.stringify(l))].join('\n') + '\n'
}

/** The index of the files of a repository, in path order so that the same repository gives the same index. */
export function buildIndex(files: RepoFile[], commit: string, shaOf: (text: string) => string): RepoIndex {
  const entries = files.flatMap((file) => indexEntry(file, shaOf(file.text)) ?? []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { version: 1, commit, entries }
}
