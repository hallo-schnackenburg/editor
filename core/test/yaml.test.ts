import { describe, expect, it } from 'vitest'
import { locate } from '../src/yaml/locate.js'
import { readField, readObject } from '../src/yaml/read.js'
import { replaceIds, setField, setId, setText } from '../src/yaml/patch.js'
import { validateEntryYaml } from '../src/yaml/validate.js'
import { examples } from './fixtures.js'

describe('validateEntryYaml', () => {
  it('accepts every example as it is written', () => {
    for (const e of examples()) expect(validateEntryYaml(e.text), e.path).toEqual([])
  })
  it('reports a syntax error, then the shape, then the rest', () => {
    expect(validateEntryYaml('id: [')[0].message).toMatch(/^YAML syntax error/)
    expect(validateEntryYaml('id: x\ntype: person\n')[0].message).toMatch(/missing field "name"/)
    const long = `id: x\ntype: content\ntitle: T\ntext:\n  teaser: ${'x'.repeat(250)}\n`
    expect(validateEntryYaml(long)).toEqual([{ path: '/text/teaser', message: '250 characters; at most 200' }])
  })
})

describe('reading', () => {
  const text = 'id: x\ntype: person\nname: "Erika"\n'
  it('gets a field or the whole entry', () => {
    expect(readField(text, 'name')).toBe('Erika')
    expect(readObject(text)).toEqual({ id: 'x', type: 'person', name: 'Erika' })
    expect(readObject('[1, 2]')).toBeUndefined()
  })
})

describe('locate', () => {
  it('finds the place of an issue in the text', () => {
    const text = 'id: x\ntype: person\nname: 5\n'
    const span = locate(text, '/name')
    expect(text.slice(span.from, span.to)).toBe('name: 5')
  })
})

describe('setField', () => {
  const text = '# a comment\nid: x\ntype: person\nname: Erika\n'
  it('changes a field and keeps the comment', () => {
    const r = setField(text, 'name', 'Erika Mustermann', 'Erika')
    expect(r).toEqual({ ok: true, text: '# a comment\nid: x\ntype: person\nname: Erika Mustermann\n' })
  })
  it('does not overwrite what has changed in the meantime', () => {
    expect(setField(text, 'name', 'Neu', 'Alt')).toEqual({ ok: false, current: 'Erika' })
  })
  it('removes a field when it is set to empty, and never touches id or type', () => {
    expect(setField(text, 'name', '', 'Erika')).toMatchObject({ ok: true, text: '# a comment\nid: x\ntype: person\n' })
    expect(() => setField(text, 'id', 'y', 'x')).toThrow(/cannot be changed/)
  })
})

describe('setText', () => {
  it('writes a role as a block and removes it again', () => {
    const base = 'id: x\ntype: content\ntitle: T\n'
    const withText = setText(base, 'teaser', 'Ein Satz.')
    expect(withText).toBe('id: x\ntype: content\ntitle: T\ntext:\n  teaser: |\n    Ein Satz.\n')
    expect(validateEntryYaml(withText)).toEqual([])
    expect(setText(withText, 'teaser', '')).toBe(base)
  })
})

describe('replaceIds', () => {
  it('replaces ids in a list or a single reference and leaves the rest as it is', () => {
    const text = '# a comment\nid: x\nplaces: [a, b/1]\nparent: a\n'
    const map = new Map([['a', 'c'], ['b/1', 'd/1']])
    expect(replaceIds(text, 'places', map)).toBe('# a comment\nid: x\nplaces: [c, d/1]\nparent: a\n')
    expect(replaceIds(text, 'parent', map)).toBe('# a comment\nid: x\nplaces: [a, b/1]\nparent: c\n')
    expect(replaceIds(text, 'missing', map)).toBe(text)
    expect(replaceIds(text, 'places', new Map([['z', 'y']]))).toBe(text)
  })
})

describe('setId', () => {
  it('sets the id and keeps the rest', () => {
    expect(setId('# note\nid: a\ntype: place\nname: A\n', 'b/1')).toBe('# note\nid: b/1\ntype: place\nname: A\n')
  })
})

describe('replaceIds (quotes)', () => {
  it('keeps quotes, block lists and comments', () => {
    const text = 'places:\n  - "a" # the village\n  - b\nparent: \'a\'\n'
    const map = new Map([['a', 'c']])
    expect(replaceIds(text, 'places', map)).toBe('places:\n  - "c" # the village\n  - b\nparent: \'a\'\n')
    expect(replaceIds(text, 'parent', map)).toBe('places:\n  - "a" # the village\n  - b\nparent: \'c\'\n')
  })
})

describe('tags', () => {
  const person = (tags: string) => `id: erika\ntype: person\nname: Erika\ntags:\n${tags}`
  it('are free text, internal ones start with an underscore', () => {
    expect(validateEntryYaml(person('  - Chor\n  - Freiwillige Feuerwehr\n  - _stub\n'))).toEqual([])
  })
  it('are not empty, not twice, not with a comma or spaces around', () => {
    expect(validateEntryYaml(person('  - ""\n')).length).toBeGreaterThan(0)
    expect(validateEntryYaml(person('  - Chor\n  - Chor\n')).length).toBeGreaterThan(0)
    expect(validateEntryYaml(person('  - "a, b"\n')).length).toBeGreaterThan(0)
    expect(validateEntryYaml(person('  - " Chor"\n')).length).toBeGreaterThan(0)
  })
})
