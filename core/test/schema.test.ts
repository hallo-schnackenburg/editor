import { describe, expect, it } from 'vitest'
import { validateEntry } from '../src/schema.js'
import { example } from './fixtures.js'

const person = () => example('erika-mustermann')
const content = () => example('osterfeuer-tradition')
const object = () => example('01kb4z8m3q7xv2n5r6t9c0d1ae')
const messages = (data: unknown) => validateEntry(data).map((i) => `${i.path}: ${i.message}`)

describe('an entry', () => {
  it('is valid when it follows its type', () => {
    for (const data of [person(), content(), object()]) expect(messages(data)).toEqual([])
  })

  it('needs an id and a type', () => {
    expect(messages({ name: 'X' }).join('\n')).toMatch(/missing field "id"/)
    expect(messages({ id: 'x', name: 'X' }).join('\n')).toMatch(/missing field "type"/)
    expect(messages({ id: 'x', type: 'gadget', name: 'X' }).join('\n')).toMatch(/must be one of/)
  })

  it('refuses a field that its type does not have', () => {
    expect(messages({ ...person(), title: 'Frau' })).toEqual(['/title: unknown field "title"'])
    expect(messages({ ...content(), recurring: true })).toEqual(['/recurring: unknown field "recurring"'])
  })

  it('needs the fields its type requires', () => {
    expect(messages({ id: 'a', type: 'person' })).toEqual(['/: missing field "name"'])
    expect(messages({ ...content(), title: undefined })[0]).toMatch(/missing field "title"/)
  })

  it('has an id as a slug, and for an object a ULID', () => {
    expect(messages({ ...person(), id: 'Erika Mustermann' })[0]).toMatch(/^\/id: not a valid id/)
    expect(messages({ ...object(), id: 'ohne-ulid' })[0]).toMatch(/^\/id:/)
    expect(messages({ ...person(), id: 'erika-2' })).toEqual([])
  })
})

describe('references', () => {
  it('are lists of ids, not empty and without repeats', () => {
    expect(messages({ ...content(), authors: 'erika-mustermann' })[0]).toMatch(/^\/authors: must be array/)
    expect(messages({ ...content(), authors: [] })[0]).toMatch(/^\/authors:/)
    expect(messages({ ...content(), authors: ['a', 'a'] })[0]).toMatch(/^\/authors:/)
    expect(messages({ ...content(), authors: ['Nicht Gültig'] })[0]).toMatch(/^\/authors\/0: not a valid id/)
  })
})

describe('the text of a content', () => {
  it('takes the roles of the model and no other', () => {
    expect(messages({ ...content(), text: { body: 'x', insta: 'y' } }).join('\n')).toMatch(/not a text role: "insta"/)
  })
  it('needs at least one role, each a text', () => {
    expect(messages({ ...content(), text: {} })[0]).toMatch(/^\/text:/)
    expect(messages({ ...content(), text: { body: '' } })[0]).toMatch(/^\/text\/body:/)
  })
})

describe('objects', () => {
  it('takes the listed subtypes, other types take none', () => {
    expect(messages({ ...object(), subtype: 'hologram' })[0]).toMatch(/^\/subtype: must be one of: photo/)
    expect(messages({ ...person(), subtype: 'photo' })[0]).toMatch(/^\/subtype: this type has no subtypes/)
  })
  it('needs a type (kind), and each file its hash, path and size', () => {
    expect(messages({ ...object(), kind: undefined })[0]).toMatch(/missing field "kind"/)
    expect(messages({ ...object(), kind: 'sculpture' })[0]).toMatch(/^\/kind: must be one of: image/)
    const { sha256, ...rest } = object().files[0]
    expect(messages({ ...object(), files: [rest] })[0]).toMatch(/missing field "sha256"/)
  })
  it('take a date as EDTF, and references in origin and original', () => {
    for (const date of ['1963', '1963-07-14', '196X', '1960/1969', '1963?']) expect(messages({ ...object(), date }), date).toEqual([])
    expect(messages({ ...object(), date: '14.07.1963' })[0]).toMatch(/^\/date:/)
    expect(messages({ ...object(), origin: { by: 'erika-mustermann' } })[0]).toMatch(/^\/origin\/by: must be array/)
    expect(messages({ ...object(), origin: { place: 'Nicht Gültig' } })[0]).toMatch(/^\/origin\/place: not a valid id/)
    expect(messages({ ...object(), original: { holder: 'elbdeich-festplatz', shelf: 3 } })[0]).toMatch(/unknown field "shelf"/)
  })
})

describe('follow-up messages', () => {
  it('reports a broken link once, not also the fields around it as unknown', () => {
    const issues = validateEntry({ id: 'x', type: 'person', name: 'X', links: [{ label: 'a', url: '' }] })
    expect(issues.map((i) => i.path)).toEqual(['/links/0/url'])
  })
})
