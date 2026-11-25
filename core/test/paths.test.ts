import { describe, expect, it } from 'vitest'
import { checkPath, entryPath, fileDir, objectId, slugify, variantPath } from '../src/paths.js'
import { MODEL } from '../src/model.generated.js'
import { examples } from './fixtures.js'

describe('slugify', () => {
  it('writes umlauts out and makes hyphens of the rest', () => {
    expect(slugify('Müller & Söhne: Große Brücke!')).toBe('mueller-soehne-grosse-bruecke')
    expect(slugify('  Café  Zur Fähre ')).toBe('cafe-zur-faehre')
    expect(slugify('Hallo Schnackenburg e.V.')).toBe('hallo-schnackenburg')
    expect(slugify('Verein e. V. Elbe')).toBe('verein-elbe')
    expect(slugify('Eva Vogel')).toBe('eva-vogel')
    expect(slugify('---')).toBe('')
  })
})

describe('objectId', () => {
  it('is a ULID in lower case: ten characters of time, sixteen random ones', () => {
    expect(objectId(0, (b) => b.fill(0))).toBe('0'.repeat(26))
    expect(objectId(1_764_000_000_000, (b) => b.fill(31)).slice(10)).toBe('z'.repeat(16))
  })
  it('sorts by the time it was made and fits the id rule', () => {
    const rule = new RegExp(MODEL.ids.object.pattern)
    const a = objectId(1_000_000_000_000), b = objectId(1_000_000_000_001)
    expect(rule.test(a)).toBe(true)
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true)
  })
})

describe('entryPath', () => {
  it('follows the type', () => {
    expect(entryPath('person', 'erika-mustermann')).toBe('entities/people/erika-mustermann.yaml')
    expect(entryPath('object', '01kb4z8m3q7xv2n5r6t9c0d1ae')).toBe('objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml')
    expect(entryPath('content', 'osterfeuer', 'traditionen')).toBe('contents/traditionen/osterfeuer.yaml')
    expect(() => entryPath('content', 'osterfeuer')).toThrow(/topic/)
  })
})

describe('checkPath', () => {
  it('accepts every example where it lies', () => {
    for (const e of examples()) expect(checkPath(e.path, e.data), e.path).toEqual([])
  })
  it('takes the path below the folder of the type as the id of an entity, with free folders', () => {
    expect(entryPath('place', 'gummern/3')).toBe('entities/places/gummern/3.yaml')
    expect(checkPath('entities/places/gummern/3.yaml', { id: 'gummern/3', type: 'place' })).toEqual([])
    expect(checkPath('entities/places/schnackenburg/elbstrasse/3.yaml', { id: 'schnackenburg/elbstrasse/3', type: 'place' })).toEqual([])
    expect(checkPath('entities/places/gummern/3.yaml', { id: 'gummern-3', type: 'place' })[0].message).toMatch(/id must be the path below entities\/places\/ without \.yaml \(gummern\/3\)/)
  })
  it('says when the id is not the file name, or the folder is wrong', () => {
    const entry = { id: 'erika-mustermann', type: 'person' }
    expect(checkPath('entities/people/erika.yaml', entry)[0].message).toMatch(/id must be the path below entities\/people\/ without \.yaml \(erika\)/)
    expect(checkPath('entities/places/erika-mustermann.yaml', entry)[0].message).toMatch(/belongs in entities\/people\//)
    expect(checkPath('objects/xx/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml', { id: '01kb4z8m3q7xv2n5r6t9c0d1ae', type: 'object' })[0].message).toMatch(/objects\/ae\/01kb4z8m3q7xv2n5r6t9c0d1ae/)
    expect(checkPath('entities/events/x.yml', { id: 'x', type: 'event' })[0].message).toMatch(/\.yaml/)
    expect(checkPath('somewhere/x.yaml', { id: 'x', type: 'content' })[0].message).toMatch(/contents\//)
  })
})

describe('the object store', () => {
  const sha = 'ab'.repeat(32)
  it('lays files out as the archive does', () => {
    expect(fileDir(sha)).toBe(`files/ab/ab/${sha}`)
    expect(variantPath(sha, 'preview-400', 'cd'.repeat(32), 'jpg')).toBe(`files/ab/ab/${sha}/preview-400.cdcdcdcdcdcd.jpg`)
    expect(() => fileDir('xyz')).toThrow(/sha256/)
  })
})

describe('parseFilePath', () => {
  const sha = '9f2c' + '0'.repeat(60)
  it('knows the paths of the store and refuses all others', async () => {
    const { parseFilePath } = await import('../src/paths.js')
    expect(parseFilePath(`files/9f/2c/${sha}/original.tif`)).toEqual({ sha256: sha, kind: 'original' })
    expect(parseFilePath(`files/9f/2c/${sha}/preview-400.abcdef012345.jpg`)).toEqual({ sha256: sha, kind: 'variant' })
    expect(parseFilePath(`files/aa/2c/${sha}/original.tif`)).toBeNull()
    expect(parseFilePath('files/../secret')).toBeNull()
    expect(parseFilePath(`files/9f/2c/${sha}/other.txt`)).toBeNull()
  })
})
