import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Plan, entityYaml, grounded, run, shape, withAbout, type Mention } from '../scripts/extract-entities.js'

const m = (over: Partial<Mention>): Mention => ({ name: 'Anglerverein Schnackenburg', type: 'organization', evidence: 'Anglerverein Schnackenburg und Umgebung', ...over })
const TEXT = 'Der Anglerverein Schnackenburg und Umgebung hat seinen Sitz in Gummern. Vorsitzender ist Hans Meier, Tel. 0151 1234567.'

describe('shape', () => {
  it('keeps what is well formed and throws away contact data and unknown types', () => {
    const kept = shape({ mentions: [m({}), m({ name: 'Hans Meier 0151 1234567', type: 'person' }), { name: 'x', type: 'animal', evidence: 'x' }, { name: 'Gummern', type: 'place', kind: 'locality', evidence: 'in Gummern' }, 'junk'] })
    expect(kept.map((k) => k.name)).toEqual(['Anglerverein Schnackenburg', 'Gummern'])
    expect(shape(undefined)).toEqual([])
  })
  it('knows a kind only for a place', () => {
    expect(shape({ mentions: [m({ kind: 'locality' } as never)] })[0].kind).toBeUndefined()
  })
})

describe('grounded', () => {
  it('needs the passage in the text and the words of the name in it', () => {
    expect(grounded(m({}), TEXT, [])).toBe(true)
    expect(grounded(m({ evidence: 'Ein ganz anderer Satz' }), TEXT, [])).toBe(false)
    expect(grounded(m({ name: 'Ruderverein Schnackenburg' }), TEXT, [])).toBe(false)
    expect(grounded(m({ name: 'Hans Meier', type: 'person', evidence: 'Vorsitzender ist Hans Meier' }), TEXT, [])).toBe(true)
  })
})

describe('Plan', () => {
  it('makes one entity of what is named twice, and puts a place in the locality the text names', () => {
    const plan = new Plan([], [])
    const ids = plan.add(
      [
        { name: 'Aussichtsturm', type: 'place', kind: 'other', in: 'Gummern', evidence: 'Aussichtsturm in Gummern' },
        { name: 'Gummern', type: 'place', kind: 'locality', evidence: 'in Gummern' },
      ],
      'Der Aussichtsturm in Gummern ist 14 Meter hoch.',
    )
    expect(ids).toEqual(['gummern', 'gummern/sonstige/aussichtsturm'])
    expect(plan.add([{ name: 'Gummern', type: 'place', kind: 'locality', evidence: 'in Gummern' }], 'Es liegt in Gummern.')).toEqual(['gummern'])
    expect(plan.entities.get('place:aussichtsturm')).toMatchObject({ kind: 'other', parent: 'gummern', existing: false })
  })

  it('drops what the text does not say, and a parent that is not a known locality', () => {
    const plan = new Plan([], [])
    expect(plan.add([m({ evidence: 'steht nirgends' })], TEXT)).toEqual([])
    plan.add([{ name: 'Hafenkran', type: 'thing', in: 'Atlantis', evidence: 'Hafenkran am Wasser' } as Mention], 'Der Hafenkran am Wasser.')
    expect(plan.entities.get('thing:hafenkran')?.parent).toBeUndefined()
    plan.add([{ name: 'Elbstrand', type: 'place', kind: 'other', in: 'Atlantis', evidence: 'Elbstrand' }], 'Der Elbstrand.')
    expect(plan.entities.get('place:elbstrand')?.id).toBe('sonstige/elbstrand')
  })

  it('uses an entity that is there, and takes the plain id from a content, which gets another one', () => {
    const plan = new Plan([{ id: 'feuerwehr', type: 'organization', name: 'Freiwillige Feuerwehr Schnackenburg' }], ['kapern'])
    expect(plan.add([{ name: 'Freiwillige Feuerwehr Schnackenburg', type: 'organization', evidence: 'Freiwillige Feuerwehr' }], 'Die Freiwillige Feuerwehr Schnackenburg übt.')).toEqual(['feuerwehr'])
    // the content gives way: an entity has the plain id
    expect(plan.add([{ name: 'Kapern', type: 'place', kind: 'locality', evidence: 'Kapern liegt' }], 'Kapern liegt an der Elbe.')).toEqual(['kapern'])
    expect(plan.renames.get('kapern')).toBe('kapern-text')
  })
})

describe('files', () => {
  it('writes an entity as a stub, with nothing the text did not say', () => {
    expect(entityYaml({ id: 'gummern', type: 'place', name: 'Gummern', kind: 'locality', existing: false })).toBe('id: gummern\ntype: place\nname: Gummern\nkind: locality\ntags:\n  - _stub\n')
  })

  it('sets about in front of the text and leaves the rest of the file as it is', () => {
    const file = 'id: a\ntype: content\ntitle: A\npublished: 2025-01-01\ntext:\n  body: |\n    Hallo\ntags:\n  - x\n'
    const once = withAbout(file, ['gummern', 'anglerverein'])
    expect(once).toBe('id: a\ntype: content\ntitle: A\npublished: 2025-01-01\nabout: [gummern, anglerverein]\ntext:\n  body: |\n    Hallo\ntags:\n  - x\n')
    expect(withAbout(once, ['gummern'])).toBe(once)
    expect(withAbout(once, ['kapern'])).toContain('about: [gummern, anglerverein, kapern]')
  })
})

describe('run', () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'extract-'))
    mkdirSync(join(root, 'contents', 'vereine'), { recursive: true })
    writeFileSync(join(root, 'contents', 'vereine', 'anglerverein.yaml'), `id: anglerverein\ntype: content\ntitle: Anglerverein\npublished: 2025-05-22\ntext:\n  body: |\n    ${TEXT}\n`)
    return root
  }
  const ask = async () => ({ mentions: [m({}), { name: 'Gummern', type: 'place', kind: 'locality', evidence: 'Sitz in Gummern' }, { name: 'Hans Meier', type: 'person', evidence: 'Vorsitzender ist Hans Meier' }] })

  it('changes nothing without write', async () => {
    const root = repo()
    const { planned, changed } = await run({ root, ask, log: () => {} })
    expect(planned.map((p) => p.id).sort()).toEqual(['anglerverein-schnackenburg', 'gummern', 'hans-meier'])
    expect(changed).toBe(1)
    expect(readFileSync(join(root, 'contents', 'vereine', 'anglerverein.yaml'), 'utf8')).not.toContain('about')
  })

  it('writes the entities and the references, and asks the model once when the cache is there', async () => {
    const root = repo()
    let asked = 0
    const counting = async () => (asked++, ask())
    const cache = join(root, 'cache')
    await run({ root, ask: counting, write: true, cache, log: () => {} })
    await run({ root, ask: counting, write: true, cache, log: () => {} })
    expect(asked).toBe(1)
    expect(readFileSync(join(root, 'entities', 'people', 'hans-meier.yaml'), 'utf8')).toContain('_stub')
    expect(readFileSync(join(root, 'contents', 'vereine', 'anglerverein.yaml'), 'utf8')).toContain('about: [')
  })

  it('renames a content that has the id of an entity, in its file too', async () => {
    const root = repo()
    const askGummern = async () => ({ mentions: [{ name: 'Anglerverein', type: 'organization', evidence: 'Der Anglerverein' }] })
    const { renamed } = await run({ root, ask: askGummern, write: true, log: () => {} })
    expect(renamed).toBe(1)
    expect(existsSync(join(root, 'contents', 'vereine', 'anglerverein.yaml'))).toBe(false)
    expect(readFileSync(join(root, 'contents', 'vereine', 'anglerverein-text.yaml'), 'utf8')).toContain('id: anglerverein-text')
    expect(readFileSync(join(root, 'entities', 'organizations', 'anglerverein.yaml'), 'utf8')).toContain('id: anglerverein')
  })
})
