import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { blobSha } from '../src/blob-sha.js'
import { buildBundle, buildIndex, indexEntry } from '../src/index-build.js'
import { examples } from './fixtures.js'

const files = () => examples().map((e) => ({ path: e.path, text: e.text }))

describe('index', () => {
  it('gives the sha that git gives', () => {
    const text = 'id: a\ntype: person\nname: Ä\n'
    const git = execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim()
    expect(blobSha(text)).toBe(git)
  })

  it('has one line per stored file, in path order, the same for the same files', () => {
    const index = buildIndex(files(), 'abc', blobSha)
    expect(index.commit).toBe('abc')
    expect(index.entries.length).toBe(files().filter((f) => indexEntry(f, 'x')).length)
    expect(index.entries.map((e) => e.path)).toEqual([...index.entries.map((e) => e.path)].sort())
    expect(buildIndex([...files()].reverse(), 'abc', blobSha)).toEqual(index)
  })

  it('names the entry by name or title and keeps what the tree needs', () => {
    const erika = indexEntry({ path: 'entities/people/erika-mustermann.yaml', text: 'id: erika-mustermann\ntype: person\nname: Erika Mustermann\ntags:\n  - _stub\n  - Chor\n' }, 'x')
    expect(erika).toMatchObject({ id: 'erika-mustermann', type: 'person', title: 'Erika Mustermann', tags: ['_stub', 'Chor'] })
    const object = indexEntry({
      path: 'objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml',
      text: 'id: 01kb4z8m3q7xv2n5r6t9c0d1ae\ntype: object\nkind: image\nsubtype: photo\ntitle: Fähre\ndate: "1952"\nparents: [01kb4z8m3q7xv2n5r6t9c0d1aa]\n',
    }, 'y')
    expect(object).toMatchObject({ kind: 'image', subtype: 'photo', title: 'Fähre', date: '1952', parents: ['01kb4z8m3q7xv2n5r6t9c0d1aa'] })
  })

  it('lists what an entry refers to, nested too', () => {
    const object = indexEntry(
      { path: 'objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml', text: 'id: 01kb4z8m3q7xv2n5r6t9c0d1ae\ntype: object\nkind: image\ntitle: Fähre\norigin:\n  by: [erika-mustermann]\n  place: feuerwehrhaus\nabout: [erika-mustermann]\nparents: [01kb4z8m3q7xv2n5r6t9c0d1aa]\n' },
      'y',
    )
    expect(object?.refs).toEqual(['erika-mustermann', 'feuerwehrhaus', '01kb4z8m3q7xv2n5r6t9c0d1aa'])
    expect(indexEntry({ path: 'entities/people/e.yaml', text: 'id: e\ntype: person\nname: E\n' }, 'x')?.refs).toBeUndefined()
  })

  it('packs the texts of all entries, one line each, with the commit first', () => {
    const lines = buildBundle(files(), 'abc', blobSha).trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ version: 1, commit: 'abc' })
    const entries = buildIndex(files(), 'abc', blobSha).entries.filter((e) => e.type !== 'folder')
    expect(lines.slice(1).map((l) => [l.path, l.sha])).toEqual(entries.map((e) => [e.path, e.sha]))
    expect(lines.slice(1).every((l) => blobSha(l.text) === l.sha)).toBe(true)
  })

  it('leaves out what is not ours or not YAML', () => {
    expect(indexEntry({ path: 'README.md', text: '# x' }, 'x')).toBeUndefined()
    expect(indexEntry({ path: 'entities/people/x.yaml', text: ': : :' }, 'x')).toBeUndefined()
  })

  it('has the postal code of a place', () => {
    const place = indexEntry({ path: 'entities/places/schnackenburg.yaml', text: 'id: schnackenburg\ntype: place\nname: Schnackenburg\nkind: locality\npostal_code: "29493"\n' }, 'x')
    expect(place).toMatchObject({ postal: '29493' })
  })
})
