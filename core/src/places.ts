// The places form a tree: a locality (Ort: a town, village or quarter) may lie in another locality and contains streets and squares,
// those contain buildings; a building may also lie directly in a locality (villages without street names). Other places (a bathing
// spot, a lookout) lie in a locality or have no parent. `parent` is one id; it is a relation, not the folder the file lies in.
// Only places that have a `kind` are checked, so that places made before the kinds existed stay valid.

import { parseAddress, streetKey } from './address.js'
import type { Issue } from './types.js'

/** Which kinds a place of a kind may lie in. An empty list: it has no parent. */
const PARENT_KINDS: Record<string, readonly string[]> = {
  locality: ['locality'],
  street: ['locality'],
  square: ['locality'],
  building: ['street', 'square', 'locality'],
  other: ['locality'],
}
/** Kinds that must have a parent (others may have none). */
const NEEDS_PARENT = new Set(['street', 'square', 'building'])
const WORDS: Record<string, string> = { locality: 'a locality', street: 'a street', square: 'a square', building: 'a building', other: 'another place' }

/** `a street, a square or a locality` */
const list = (kinds: readonly string[]): string => kinds.map((k) => WORDS[k]).reduce((all, w, i) => (i === 0 ? w : i === kinds.length - 1 ? `${all} or ${w}` : `${all}, ${w}`), '')

/** Whether a place of this kind may lie in a place of that kind (the kind of a parent). */
export const canLieIn = (kind: string, parentKind: string): boolean => (PARENT_KINDS[kind] ?? []).includes(parentKind)

export type PlaceLookup = (id: string) => { type: string; data?: Record<string, unknown> } | undefined

/** The id a place lies in (`parent`), if it has one. */
export const parentOf = (entry: { parent?: unknown }): string | undefined => (typeof entry.parent === 'string' ? entry.parent : undefined)

/** Whether a place lies in itself: following its parents leads back to it (or round in a circle). */
function inCircle(id: unknown, parentId: string, find: PlaceLookup): boolean {
  const seen = new Set<string>(typeof id === 'string' ? [id] : [])
  for (let at: string | undefined = parentId; at !== undefined; ) {
    if (seen.has(at)) return true
    seen.add(at)
    const found = find(at)
    at = found?.type === 'place' ? parentOf(found.data ?? {}) : undefined
  }
  return false
}

/** Checks the kind of a place against the kind of its parent, and that it does not lie in itself. References that lead nowhere are the business of checkRefs. */
export function checkParent(entry: unknown, find: PlaceLookup): Issue[] {
  if (typeof entry !== 'object' || entry === null) return []
  const place = entry as { id?: unknown; type?: unknown; kind?: unknown; parent?: unknown }
  if (place.type === 'place' && typeof place.parent === 'string' && inCircle(place.id, place.parent, find)) return [{ path: '/parent', message: 'a place cannot lie in itself or in one of its own places' }]
  if (place.type !== 'place' || typeof place.kind !== 'string' || !(place.kind in PARENT_KINDS)) return []
  const allowed = PARENT_KINDS[place.kind]
  const parentId = parentOf(place)
  if (parentId === undefined) return []
  const parent = find(parentId)
  const parentKind = parent?.type === 'place' ? parent.data?.kind : undefined
  if (typeof parentKind !== 'string' || !(parentKind in PARENT_KINDS) || allowed.includes(parentKind)) return []
  return [{ path: '/parent', message: `${WORDS[place.kind]} lies in ${list(allowed)}, not in ${WORDS[parentKind]}` }]
}

/**
 * What is merely incomplete or does not fit in a place: no parent yet where one is wanted, or an address that names another street
 * or place than the parent. Warnings only: to be put right later, they refuse nothing.
 */
export function advisePlace(entry: unknown, find: PlaceLookup): Issue[] {
  if (typeof entry !== 'object' || entry === null) return []
  const place = entry as { type?: unknown; kind?: unknown; parent?: unknown; address?: unknown }
  if (place.type !== 'place' || typeof place.kind !== 'string' || !(place.kind in PARENT_KINDS)) return []
  const parentId = parentOf(place)
  if (parentId === undefined) {
    return NEEDS_PARENT.has(place.kind) ? [{ path: '/parent', message: `${WORDS[place.kind]} lies in ${list(PARENT_KINDS[place.kind])}: parent is missing`, warning: true }] : []
  }
  const parent = find(parentId)
  const name = parent?.type === 'place' ? parent.data?.name : undefined
  const parsed = place.kind === 'building' && typeof place.address === 'string' ? parseAddress(place.address) : undefined
  if (parsed && typeof name === 'string' && streetKey(parsed.street) !== streetKey(name) && ['street', 'square'].includes(String(parent?.data?.kind))) {
    return [{ path: '/address', message: `the address names ${parsed.street}, but the building lies in ${name}`, warning: true }]
  }
  return []
}
