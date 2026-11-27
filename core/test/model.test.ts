import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain script, no types
import { render, read, schemaOf } from '../scripts/generate.mjs'
import schema from '../schema/entry.schema.json'
import { MODEL, ENTRY_TYPES, TEXT_ROLES } from '../src/model.generated.js'

const source = readFileSync(new URL('../../contents.yaml', import.meta.url), 'utf8')

describe('contents.yaml', () => {
  it('has its generated files up to date (run `npm run generate` in core if this fails)', () => {
    const out = render(source)
    expect(readFileSync(new URL('../src/model.generated.ts', import.meta.url), 'utf8')).toBe(out.model)
    expect(`${JSON.stringify(schema, null, 2)}\n`).toBe(out.schema)
  })

  it('lists the types and the text roles', () => {
    expect(ENTRY_TYPES).toEqual(['person', 'organization', 'place', 'event', 'thing', 'content', 'object'])
    expect(TEXT_ROLES).toEqual(['body', 'teaser', 'summary'])
    expect(MODEL.types.object.subtypes).toHaveProperty('photo', 'Foto')
    expect(MODEL.types.object.kinds.group.files).toEqual({ max: 0 })
  })

  it('tells the editor how each field is shown', () => {
    const kinds = (type: keyof typeof MODEL.types) => Object.fromEntries(Object.entries(MODEL.types[type].fields).map(([name, f]) => [name, f.kind]))
    expect(kinds('place')).toEqual({ name: 'string', description: 'string', kind: 'choice', parent: 'ref', location: 'location', address: 'string', postal_code: 'string', tags: 'tags', links: 'links' })
    // the description is written over several lines
    expect(MODEL.types.place.fields.description).toMatchObject({ multiline: true })
    for (const type of ['person', 'organization', 'place', 'event'] as const) expect(kinds(type)).toMatchObject({ description: 'string', links: 'links' })
    expect(MODEL.types.place.fields.kind.options).toMatchObject({ locality: 'Ort', building: 'Gebäude' })
    expect(MODEL.types.place.fields.parent).toMatchObject({ kind: 'ref', single: true })
    expect(kinds('content')).toEqual({ title: 'string', authors: 'ref', about: 'ref', objects: 'ref', published: 'date', text: 'text', tags: 'tags' })
    expect(kinds('event')).toMatchObject({ recurring: 'boolean', organizers: 'ref' })
    expect(kinds('person')).toMatchObject({ links: 'links' })
    expect(kinds('object')).toMatchObject({ kind: 'choice', files: 'files', alt: 'string', date: 'string', origin: 'group', original: 'group', about: 'ref', external: 'other' })
    expect(MODEL.types.object.fields.origin.parts).toMatchObject({ by: { kind: 'ref', ref: ['person', 'organization'] }, place: { kind: 'ref', single: true } })
    expect(MODEL.types.object.fields.recipient).toMatchObject({ applies: ['document'] })
  })

  it('refuses options that do not name every value of the choice', () => {
    expect(() => read(source.replace('options: { locality: Ort, street: Straße, square: Platz, building: Gebäude, other: Sonstiger Ort }', 'options: { locality: Ort }'))).toThrow(/options must name every value/)
  })

  it('only lets the text hold the roles it defines', () => {
    expect(schemaOf(read(source)).$defs.text.propertyNames.enum).toEqual(TEXT_ROLES)
  })

  it('refuses a model that points to a type or role that does not exist', () => {
    expect(() => read(source.replace('ref: [place]', 'ref: [nowhere]'))).toThrow(/not a type/)
    expect(() => read(source.replace('fallback: [summary]', 'fallback: [nothing]'))).toThrow(/not another role/)
  })
})
