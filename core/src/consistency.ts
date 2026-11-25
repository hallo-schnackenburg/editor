// What the JSON Schema cannot say: that the paths of the files match their hashes, and that references lead to
// entries that exist and are of an allowed type. The shape is checked first (schema.ts); these checks assume it.

import { MODEL, type EntryType } from './model.generated.js'
import { fileDir } from './paths.js'
import type { Issue } from './types.js'

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

/** File and variant paths of an object must belong to their hashes. */
export function checkFiles(entry: unknown): Issue[] {
  if (!isObj(entry) || !Array.isArray(entry.files)) return []
  const issues: Issue[] = []
  entry.files.forEach((f, i) => {
    if (!isObj(f) || typeof f.sha256 !== 'string' || typeof f.path !== 'string') return
    const dir = fileDir(f.sha256)
    if (!f.path.startsWith(`${dir}/original.`)) issues.push({ path: `/files/${i}/path`, message: `the path must be ${dir}/original.<ext>` })
    const variants = Array.isArray(f.variants) ? f.variants : []
    variants.forEach((v: unknown, j: number) => {
      if (!isObj(v) || typeof v.sha256 !== 'string' || typeof v.path !== 'string') return
      const ok = v.path.startsWith(`${dir}/`) && new RegExp(`\\.${v.sha256.slice(0, 12)}\\.[a-z0-9]+$`).test(v.path)
      if (!ok) issues.push({ path: `/files/${i}/variants/${j}/path`, message: `the path must be in ${dir}/ and end in .${v.sha256.slice(0, 12)}.<ext>` })
    })
  })
  const nums = entry.files.map((f) => (isObj(f) ? f.num : undefined)).filter((n) => n !== undefined)
  if (new Set(nums).size !== nums.length) issues.push({ path: '/files', message: 'the numbers (num) of the files must be unique' })
  return issues
}

type Kinds = Record<string, { label: string; subtypes: Record<string, string>; files: { roles?: readonly string[]; numbered?: boolean; min?: number; max?: number } }>

/**
 * What the kind of an object (its `kind`: image, document, ...) decides: the subtype, the fields that apply, and the files
 * (their roles, their numbers, how many). Without files is fine for now (there is no upload yet): the minimum is not enforced.
 */
export function checkObject(entry: unknown): Issue[] {
  if (!isObj(entry) || entry.type !== 'object' || typeof entry.kind !== 'string') return []
  const model = MODEL.types.object
  const kinds = (model as unknown as { kinds: Kinds }).kinds
  const kind = kinds[entry.kind]
  if (!kind) return []
  const issues: Issue[] = []
  if (typeof entry.subtype === 'string' && !(entry.subtype in kind.subtypes)) issues.push({ path: '/subtype', message: `not a subtype of ${kind.label}` })
  for (const [name, spec] of Object.entries(model.fields as Record<string, { applies?: readonly string[] }>)) {
    if (spec.applies && !spec.applies.includes(entry.kind) && entry[name] !== undefined) issues.push({ path: `/${name}`, message: `does not apply to ${kind.label}` })
  }
  const files = Array.isArray(entry.files) ? entry.files.filter(isObj) : []
  const external = entry.storage === 'external'
  if (external && !Array.isArray(entry.external)) issues.push({ path: '/external', message: 'storage is external: say where (external)' })
  if (!external && entry.external !== undefined) issues.push({ path: '/external', message: 'external only goes with storage: external' })
  const rule = kind.files
  files.forEach((f, i) => {
    const roles = external ? ['thumbnail', 'screenshot'] : rule.roles
    if (roles && typeof f.role === 'string' && !roles.includes(f.role)) issues.push({ path: `/files/${i}/role`, message: `a file of ${kind.label}${external ? ' kept elsewhere' : ''} has the role ${roles.join(' or ')}` })
    if (rule.numbered && !external && typeof f.num !== 'number') issues.push({ path: `/files/${i}/num`, message: 'the pages are numbered (num)' })
  })
  if (rule.max !== undefined && !external && files.length > rule.max) issues.push({ path: '/files', message: rule.max === 0 ? `${kind.label} has no files of its own` : `${kind.label} has at most ${rule.max} file${rule.max === 1 ? '' : 's'}` })
  return issues
}

/** What a reference field accepts: the entry the id leads to, and its type. */
export type Lookup = (id: string) => { type: string } | undefined

/** Every id in a reference field must exist and be of one of the types the field allows. */
export function checkRefs(entry: unknown, lookup: Lookup): Issue[] {
  if (!isObj(entry) || typeof entry.type !== 'string' || !(entry.type in MODEL.types)) return []
  type Spec = { ref?: readonly string[]; parts?: Record<string, Spec> }
  const fields = MODEL.types[entry.type as EntryType].fields as Record<string, Spec>
  const issues: Issue[] = []
  const walk = (specs: Record<string, Spec>, data: Obj, at: string) => {
    for (const [name, spec] of Object.entries(specs)) {
      const value = data[name]
      if (spec.parts) {
        if (isObj(value)) walk(spec.parts, value, `${at}/${name}`)
        continue
      }
      if (!spec.ref) continue
      // A list of ids, or one id (a single reference).
      const ids: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
      ids.forEach((id, i) => {
        if (typeof id !== 'string') return
        const where = Array.isArray(value) ? `${at}/${name}/${i}` : `${at}/${name}`
        const target = lookup(id)
        if (!target) issues.push({ path: where, message: `"${id}" does not exist` })
        else if (!spec.ref!.includes(target.type)) issues.push({ path: where, message: `"${id}" is a ${target.type}; allowed here: ${spec.ref!.join(', ')}` })
      })
    }
  }
  walk(fields, entry, '')
  return issues
}

/** Everything that is checked without other entries: the schema's job is done before; this is the rest. */
export const checkConsistency = (entry: unknown): Issue[] => [...checkFiles(entry), ...checkObject(entry)]
