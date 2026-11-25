// Objects can be in groups (an album, a collection): `parents` lists the groups an object is in, several are possible. Only the
// member writes the relation. A group can be in groups too, but not in itself, not through others.

import type { Issue } from './types.js'

export type GroupLookup = (id: string) => { type: string; data?: Record<string, unknown> } | undefined

/** The ids of the groups an object is in. */
export const parentsOf = (entry: { parents?: unknown }): string[] => (Array.isArray(entry.parents) ? entry.parents.filter((p): p is string => typeof p === 'string') : [])

/** Whether one of the groups above `ids` is `self`. */
function reaches(self: unknown, ids: string[], find: GroupLookup): boolean {
  const seen = new Set<string>()
  for (let todo = [...ids]; todo.length > 0; ) {
    const at = todo.pop()!
    if (at === self) return true
    if (seen.has(at)) continue
    seen.add(at)
    const found = find(at)
    if (found?.type === 'object') todo.push(...parentsOf(found.data ?? {}))
  }
  return false
}

/** Checks that `parents` are groups and that the object does not lie in itself. References that lead nowhere are the business of checkRefs. */
export function checkGroups(entry: unknown, find: GroupLookup): Issue[] {
  if (typeof entry !== 'object' || entry === null) return []
  const object = entry as { id?: unknown; type?: unknown; parents?: unknown }
  if (object.type !== 'object') return []
  const issues: Issue[] = []
  parentsOf(object).forEach((id, i) => {
    const found = find(id)
    if (found?.type === 'object' && found.data?.kind !== 'group') issues.push({ path: `/parents/${i}`, message: `"${id}" is not a group` })
  })
  if (reaches(object.id, parentsOf(object), find)) issues.push({ path: '/parents', message: 'an object cannot be in itself or in a group that is in it' })
  return issues
}
