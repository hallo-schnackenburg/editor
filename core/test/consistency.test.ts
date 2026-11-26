import { describe, expect, it } from 'vitest'
import { adviseObject, checkFiles, checkObject, checkRefs } from '../src/consistency.js'
import { checkGroups } from '../src/groups.js'
import { examples, example } from './fixtures.js'

const all = new Map(examples().map((e) => [e.data.id as string, e.data as { type: string }]))
const lookup = (id: string) => all.get(id)

describe('the files of an object', () => {
  it('are in order for the example', () => expect(checkFiles(example('01kb4z8m3q7xv2n5r6t9c0d1ae'))).toEqual([]))

  it('must have a path that belongs to the hash, and the same for variants', () => {
    const object = structuredClone(example('01kb4z8m3q7xv2n5r6t9c0d1ae'))
    object.files[0].path = `files/00/00/${'0'.repeat(64)}/original.jpg`
    object.files[0].variants[0].path = object.files[0].variants[0].path.replace(/\.[0-9a-f]{12}\./, '.000000000000.')
    expect(checkFiles(object).map((i) => i.path)).toEqual(['/files/0/path', '/files/0/variants/0/path'])
  })

  it('must have unique numbers', () => {
    const object = structuredClone(example('01kb4z8m3q7xv2n5r6t9c0d1ae'))
    object.files = [{ ...object.files[0], num: 1 }, { ...object.files[0], num: 1 }]
    expect(checkFiles(object)[0].message).toMatch(/unique/)
  })
})

describe('references', () => {
  it('lead to entries that exist', () => {
    for (const e of examples()) expect(checkRefs(e.data, lookup), e.path).toEqual([])
    const content = { ...example('osterfeuer-tradition'), about: ['osterfeuer', 'gibts-nicht'] }
    expect(checkRefs(content, lookup)).toEqual([{ path: '/about/1', message: '"gibts-nicht" does not exist' }])
  })

  it('lead to entries of an allowed type', () => {
    const content = { ...example('osterfeuer-tradition'), authors: ['elbdeich-festplatz'], about: ['01kb4z8m3q7xv2n5r6t9c0d1ae'] }
    const messages = checkRefs(content, lookup).map((i) => `${i.path}: ${i.message}`)
    expect(messages).toEqual([
      '/authors/0: "elbdeich-festplatz" is a place; allowed here: person, organization',
      '/about/0: "01kb4z8m3q7xv2n5r6t9c0d1ae" is a object; allowed here: person, organization, place, event, thing',
    ])
  })
})

describe('the kind of an object', () => {
  const photo = () => structuredClone(example('01kb4z8m3q7xv2n5r6t9c0d1ae'))

  it('is in order for the example', () => expect(checkObject(photo())).toEqual([]))

  it('decides the subtype', () => {
    expect(checkObject({ ...photo(), subtype: 'letter' })).toEqual([{ path: '/subtype', message: 'not a subtype of Bild' }])
  })

  it('decides which fields apply', () => {
    expect(checkObject({ ...photo(), language: 'de' })).toEqual([{ path: '/language', message: 'does not apply to Bild' }])
    expect(checkObject({ type: 'object', kind: 'document', parents: ['g'], language: 'de', alt: 'x' }).map((i) => i.path)).toEqual(['/alt'])
  })

  it('decides the roles, the numbers and the count of the files', () => {
    const file = photo().files[0]
    expect(checkObject({ ...photo(), files: [{ ...file, role: 'page' }] })[0].path).toBe('/files/0/role')
    expect(checkObject({ ...photo(), files: [file, file] })).toEqual([{ path: '/files', message: 'Bild has at most 1 file' }])
    const page = { type: 'object', kind: 'document', parents: ['g'], files: [{ ...file, role: 'page' }] }
    expect(checkObject(page)).toEqual([])
    expect(adviseObject(page)).toEqual([{ path: '/files/0/num', message: 'the pages are numbered (num)', warning: true }])
    expect(checkObject({ type: 'object', kind: 'group', files: [file] })[0].message).toMatch(/no files of its own/)
  })

  it('is in a group, unless it is a group (a group without parents is a root)', () => {
    const { parents: _, ...loose } = photo()
    expect(checkObject(loose)).toEqual([])
    expect(adviseObject(loose)).toEqual([{ path: '/parents', message: 'Bild has to be in a group', warning: true }])
    expect(adviseObject({ ...loose, parents: [] })[0].path).toBe('/parents')
    expect(checkObject({ type: 'object', kind: 'group' })).toEqual([])
    expect(checkObject({ type: 'object', kind: 'group', parents: ['root'] })).toEqual([])
  })

  it('wants the place when the content is kept elsewhere, and only then', () => {
    const where = { type: 'object', kind: 'image', parents: ['g'], storage: 'external' }
    expect(checkObject(where)).toEqual([])
    expect(adviseObject(where)).toEqual([{ path: '/external', message: 'storage is external: say where (external)', warning: true }])
    expect(checkObject({ type: 'object', kind: 'image', parents: ['g'], external: [{ site: 'Arcinsys' }] })[0].path).toBe('/external')
    const file = photo().files[0]
    expect(checkObject({ type: 'object', kind: 'image', parents: ['g'], storage: 'external', external: [{ site: 'Arcinsys' }], files: [{ ...file, role: 'thumbnail' }] })).toEqual([])
    expect(checkObject({ type: 'object', kind: 'image', parents: ['g'], storage: 'external', external: [{ site: 'Arcinsys' }], files: [file] })[0].path).toBe('/files/0/role')
  })
})

describe('the references inside an object', () => {
  it('are checked in origin and original too', () => {
    const photo = { ...example('01kb4z8m3q7xv2n5r6t9c0d1ae'), origin: { by: ['erika-mustermann', 'gibts-nicht'], place: 'erika-mustermann' }, original: { holder: 'osterfeuer' } }
    expect(checkRefs(photo, lookup).map((i) => `${i.path}: ${i.message}`)).toEqual([
      '/origin/by/1: "gibts-nicht" does not exist',
      '/origin/place: "erika-mustermann" is a person; allowed here: place',
      '/original/holder: "osterfeuer" is a event; allowed here: person, organization',
    ])
  })
})

describe('groups', () => {
  const objects: Record<string, { type: string; data: Record<string, unknown> }> = {
    album: { type: 'object', data: { id: 'album', type: 'object', kind: 'group', parents: ['sammlung'] } },
    sammlung: { type: 'object', data: { id: 'sammlung', type: 'object', kind: 'group' } },
    foto: { type: 'object', data: { id: 'foto', type: 'object', kind: 'image' } },
  }
  const find = (id: string) => objects[id]

  it('hold objects, and objects that are groups', () => {
    expect(checkGroups({ id: 'x', type: 'object', parents: ['album', 'sammlung'] }, find)).toEqual([])
    expect(checkGroups({ id: 'x', type: 'object', parents: ['foto'] }, find)).toEqual([{ path: '/parents/0', message: '"foto" is not a group' }])
  })

  it('do not lie in themselves, not through others either', () => {
    expect(checkGroups({ id: 'sammlung', type: 'object', kind: 'group', parents: ['album'] }, find)[0].message).toMatch(/in itself/)
    expect(checkGroups({ id: 'album', type: 'object', kind: 'group', parents: ['album'] }, find)[0].message).toMatch(/in itself/)
    expect(checkGroups({ id: 'sammlung', type: 'object', kind: 'group' }, find)).toEqual([])
  })
})
