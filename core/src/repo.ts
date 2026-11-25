// The check of a whole data repository, as the automatic check of a submission runs it: every entry for itself (shape, path,
// files, texts), and the entries among each other (every reference leads to an entry of an allowed type, no id twice).

import { checkRefs, type Lookup } from './consistency.js'
import { validateFolderYaml } from './folder.js'
import { checkGroups } from './groups.js'
import { checkParent } from './places.js'
import { checkEvent } from './recurrence.js'
import { ENTRY_PATH, FOLDER_PATH, checkPath } from './paths.js'
import type { Issue } from './types.js'
import { readObject } from './yaml/read.js'
import { validateEntryYaml } from './yaml/validate.js'

export interface RepoFile {
  path: string
  text: string
}

export interface RepoProblem {
  path: string
  issues: Issue[]
}

/** Where entries may be kept; a file there that is not an entry file is a mistake. Everything else in the repository is not our business. */
const OURS = /^(?:entities|contents|objects)\//

/** The problems of the files of a repository, by file; none if all is well. */
export function validateRepo(files: RepoFile[]): RepoProblem[] {
  const problems = new Map<string, Issue[]>()
  const add = (path: string, issue: Issue) => problems.set(path, [...(problems.get(path) ?? []), issue])

  const entries: { path: string; data: Record<string, unknown> }[] = []
  /** Entries that are broken still exist for the references to them: the others are not to be blamed for that. */
  const broken: { path: string; data: Record<string, unknown> }[] = []
  for (const file of files) {
    if (!OURS.test(file.path)) continue
    if (FOLDER_PATH.test(file.path)) {
      for (const issue of validateFolderYaml(file.text)) add(file.path, issue)
      continue
    }
    if (!ENTRY_PATH.test(file.path)) {
      add(file.path, { path: '/', message: 'not the path of an entry: lower-case segments, ending in .yaml; a content lies in exactly one topic folder (contents/<topic>/<id>.yaml)' })
      continue
    }
    const issues = validateEntryYaml(file.text)
    const data = readObject(file.text)
    if (issues.length > 0 || !data) {
      for (const issue of issues) add(file.path, issue)
      if (data && typeof data.id === 'string' && typeof data.type === 'string') broken.push({ path: file.path, data })
      continue
    }
    for (const issue of checkPath(file.path, data)) add(file.path, issue)
    entries.push({ path: file.path, data })
  }

  const index = new Map<string, { type: string; path: string; data?: Record<string, unknown> }>()
  for (const { path, data } of broken) if (!index.has(String(data.id))) index.set(String(data.id), { type: String(data.type), path })
  for (const { path, data } of entries) {
    const id = String(data.id)
    const known = index.get(id)
    if (known) add(path, { path: '/id', message: `id "${id}" is also used by ${known.path}` })
    else index.set(id, { type: String(data.type), path, data })
  }
  const lookup: Lookup = (id) => index.get(id)
  for (const { path, data } of entries) for (const issue of [...checkRefs(data, lookup), ...checkParent(data, lookup), ...checkGroups(data, lookup), ...checkEvent(data)]) add(path, issue)

  return [...problems].map(([path, issues]) => ({ path, issues })).sort((a, b) => a.path.localeCompare(b.path))
}
