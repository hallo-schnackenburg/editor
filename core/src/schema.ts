// Checks one entry (already parsed from YAML) against the JSON Schema and turns the validator's
// errors into short, readable issues.

import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import schema from '../schema/entry.schema.json'
import { MODEL } from './model.generated.js'
import type { Issue } from './types.js'

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

/** The patterns of ids: a value that breaks one of them is a reference or an id that is not one. */
const ID_PATTERNS = new Set<string>(Object.values(MODEL.ids).map((rule) => rule.pattern))

const child = (path: string, key: string) => (path === '/' ? `/${key}` : `${path}/${key}`)

function toIssue(error: ErrorObject): Issue {
  const path = error.instancePath || '/'
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'unevaluatedProperties':
      return { path: child(path, String(params.unevaluatedProperty)), message: `unknown field "${params.unevaluatedProperty}"` }
    case 'additionalProperties':
      return { path: child(path, String(params.additionalProperty)), message: `unknown field "${params.additionalProperty}"` }
    case 'false schema':
      return { path, message: path.endsWith('/subtype') ? 'this type has no subtypes' : 'not allowed here' }
    case 'required':
      return { path, message: `missing field "${params.missingProperty}"` }
    case 'propertyNames':
      return { path, message: `not a text role: "${(params as { propertyName?: string }).propertyName}"` }
    case 'enum':
      return { path, message: `must be one of: ${(params.allowedValues as unknown[]).join(', ')}` }
    case 'const':
      return { path, message: `must be "${params.allowedValue}"` }
    case 'type':
      return { path, message: `must be ${params.type}` }
    case 'pattern':
      if (params.pattern === MODEL.ids.object.pattern) return { path, message: 'not a valid id: a ULID in lower case (26 characters)' }
      return { path, message: path.endsWith('/id') || /\/\d+$/.test(path) || ID_PATTERNS.has(String(params.pattern)) ? 'not a valid id: lower-case letters, digits and single hyphens (an entity id may have folders: gummern/3)' : (error.message ?? 'invalid') }
    default:
      return { path, message: error.message ?? 'invalid' }
  }
}

/** Returns an empty list if the entry is valid. */
export function validateEntry(data: unknown): Issue[] {
  if (validate(data)) return []
  const errors = (validate.errors ?? []).filter((e) => e.keyword !== 'if' && e.keyword !== 'propertyNames')
  const names = (validate.errors ?? []).filter((e) => e.keyword === 'propertyNames')
  // A property that failed its own check also counts as "not evaluated"; that is a follow-up, not a second mistake.
  const real = errors.filter((e) => e.keyword !== 'unevaluatedProperties')
  return [...(real.length > 0 ? real : errors), ...names].map(toIssue)
}
