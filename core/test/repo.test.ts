import { describe, expect, it } from 'vitest'
import { validateRepo, type RepoFile } from '../src/repo.js'
import { examples } from './fixtures.js'

const files = (): RepoFile[] => examples().map((e) => ({ path: e.path, text: e.text }))

describe('validateRepo', () => {
  it('has nothing to say about the examples', () => {
    expect(validateRepo(files())).toEqual([])
  })

  it('names the entry and the problem, entries in order', () => {
    const all = files().map((f) => (f.path.endsWith('erika-mustermann.yaml') ? { ...f, text: 'id: erika-mustermann\ntype: person\n' } : f))
    expect(validateRepo(all)).toEqual([{ path: 'entities/people/erika-mustermann.yaml', issues: [{ path: '/', message: 'missing field "name"' }] }])
  })

  it('finds a reference that leads nowhere, or to the wrong kind of entry', () => {
    const all = files().map((f) =>
      f.path.endsWith('osterfeuer-tradition.yaml') ? { ...f, text: f.text.replace('about: [osterfeuer, feuerwehr-schnackenburg]', 'about: [osterfeuer, gibts-nicht, 01kb4z8m3q7xv2n5r6t9c0d1ae]') } : f,
    )
    const [problem] = validateRepo(all)
    expect(problem.path).toBe('contents/traditionen/osterfeuer-tradition.yaml')
    expect(problem.issues.map((i) => i.message)).toEqual(['"gibts-nicht" does not exist', expect.stringMatching(/01kb4z8m3q7xv2n5r6t9c0d1ae/)])
  })

  it('finds an id that is used twice, and an entry that is not where its id says', () => {
    const erika = files().find((f) => f.path.endsWith('erika-mustermann.yaml'))!
    const problems = validateRepo([...files(), { path: 'entities/people/zweite-erika.yaml', text: erika.text }])
    expect(problems.map((p) => p.path)).toEqual(['entities/people/zweite-erika.yaml'])
    expect(problems[0].issues.map((i) => i.message).join(' ')).toMatch(/id must be the path below entities\/people\/ without \.yaml \(zweite-erika\)/)
  })

  it('refuses a file in our folders that is not the path of an entry, and leaves the rest of the repository alone', () => {
    const problems = validateRepo([...files(), { path: 'entities/people/Erika.yml', text: '' }, { path: 'README.md', text: '# x' }, { path: '.github/workflows/validate.yml', text: 'on: pull_request' }])
    expect(problems).toEqual([{ path: 'entities/people/Erika.yml', issues: [{ path: '/', message: expect.stringMatching(/not the path of an entry/) }] }])
  })
})

describe('validateRepo and topic folders', () => {
  it('accepts a .folder.yaml with a title, and a folder with nothing filed in it', () => {
    expect(validateRepo([...files(), { path: 'contents/traditionen/.folder.yaml', text: 'title: Traditionen & Bräuche\n' }, { path: 'contents/kunst/.folder.yaml', text: 'title: Kunst\n' }])).toEqual([])
  })

  it('names what is wrong with a .folder.yaml', () => {
    const problems = validateRepo([...files(), { path: 'contents/kunst/.folder.yaml', text: 'name: Kunst\n' }])
    expect(problems).toEqual([{ path: 'contents/kunst/.folder.yaml', issues: [{ path: '/title', message: 'missing field "title"' }, { path: '/name', message: 'unknown field "name"' }] }])
  })

  it('allows a content in one topic folder only', () => {
    const content = files().find((f) => f.path.endsWith('osterfeuer-tradition.yaml'))!
    const [direct, deep] = [
      validateRepo([...files(), { path: 'contents/osterfeuer-direkt.yaml', text: content.text.replace('id: osterfeuer-tradition', 'id: osterfeuer-direkt') }]),
      validateRepo([...files(), { path: 'contents/a/b/osterfeuer-tief.yaml', text: content.text.replace('id: osterfeuer-tradition', 'id: osterfeuer-tief') }]),
    ]
    expect(direct[0].issues[0].message).toMatch(/not the path of an entry/)
    expect(deep[0].issues[0].message).toMatch(/not the path of an entry/)
  })
})

describe('validateRepo and the places', () => {
  /** The id is the path below entities/places/; the parent is one id. */
  const place = (id: string, kind: string, parent?: string) => ({ path: `entities/places/${id}.yaml`, text: `id: ${id}\ntype: place\nname: ${id}\nkind: ${kind}\n${parent ? `parent: ${parent}\n` : ''}` })
  const tree = [place('schnackenburg', 'locality'), place('gummern', 'locality', 'schnackenburg'), place('gummern/5', 'building', 'gummern'), place('schnackenburg/am-markt', 'street', 'schnackenburg'), place('schnackenburg/am-markt/3', 'building', 'schnackenburg/am-markt'), place('schnackenburg/badestelle', 'other', 'schnackenburg'), place('elberadweg', 'other')]

  it('accepts a locality in a locality, a street in it, a building in the street or directly in a locality, other places in a locality or alone', () => {
    expect(validateRepo([...files(), ...tree])).toEqual([])
  })

  it('lets the folders be what the authors like: the parent has nothing to do with them', () => {
    expect(validateRepo([...files(), ...tree, place('irgendwo/anders/haus', 'building', 'gummern')])).toEqual([])
  })

  it('names what is wrong: a street or building without a parent, a locality in a street, a street in a building, a building in a building', () => {
    const bad = [place('a-strasse', 'street'), place('haus-0', 'building'), place('ort-2', 'locality', 'schnackenburg/am-markt'), place('strasse-3', 'street', 'schnackenburg/am-markt/3'), place('haus-4', 'building', 'schnackenburg/am-markt/3')]
    const problems = validateRepo([...files(), ...tree, ...bad])
    expect(Object.fromEntries(problems.map((p) => [p.path.replace(/^entities\/places\/|\.yaml$/g, ''), p.issues.map((i) => i.message)]))).toEqual({
      'a-strasse': ['a street lies in a locality: parent is missing'],
      'haus-0': ['a building lies in a street, a square or a locality: parent is missing'],
      'ort-2': ['a locality lies in a locality, not in a street'],
      'strasse-3': ['a street lies in a locality, not in a building'],
      'haus-4': ['a building lies in a street, a square or a locality, not in a building'],
    })
  })

  it('names a parent that does not exist, and an id that is not the path', () => {
    const lost = place('verloren', 'other', 'nirgendwo')
    const wrong = { path: 'entities/places/gummern/7.yaml', text: 'id: gummern-7\ntype: place\nname: Sieben\nkind: building\nparent: gummern\n' }
    const problems = Object.fromEntries(validateRepo([...files(), ...tree, lost, wrong]).map((p) => [p.path, p.issues.map((i) => i.message)]))
    expect(problems['entities/places/verloren.yaml']).toEqual(['"nirgendwo" does not exist'])
    expect(problems['entities/places/gummern/7.yaml'][0]).toMatch(/id must be the path below entities\/places\/ without \.yaml \(gummern\/7\)/)
  })

  it('refuses a place that lies in itself, directly or round a circle', () => {
    const circle = [place('selbst', 'locality', 'selbst'), place('kreis-a', 'locality', 'kreis-b'), place('kreis-b', 'locality', 'kreis-a')]
    const problems = Object.fromEntries(validateRepo([...files(), ...tree, ...circle]).map((p) => [p.path.replace(/^entities\/places\/|\.yaml$/g, ''), p.issues.map((i) => i.message)]))
    const message = ['a place cannot lie in itself or in one of its own places']
    expect(problems).toEqual({ selbst: message, 'kreis-a': message, 'kreis-b': message })
  })

  it('does not check places that have no kind, and takes only one parent, as an id', () => {
    const old = { path: 'entities/places/alt.yaml', text: 'id: alt\ntype: place\nname: Alt\nparent: schnackenburg\n' }
    expect(validateRepo([...files(), ...tree, old])).toEqual([])
    const two = { path: 'entities/places/zwei.yaml', text: 'id: zwei\ntype: place\nname: Zwei\nkind: other\nparent: [schnackenburg, gummern]\n' }
    expect(validateRepo([...files(), ...tree, two])[0].issues[0].path).toBe('/parent')
  })
})

describe('validateRepo and what is only incomplete', () => {
  const loose = { path: 'objects/0z/01hf81wat0wdcc5wxfz659zn0z.yaml', text: 'id: 01hf81wat0wdcc5wxfz659zn0z\ntype: object\nkind: image\nsubtype: photo\ntitle: Fährfest\nalt: Fährfest von oben\ncaption: Fährfest, 1960.\norigin:\n  by:\n    - erika-mustermann\nlicense: cc-by-4.0\ndate: 1964-12-12\n' }

  it('reports an object without a group as a warning, not as an error', () => {
    const problems = validateRepo([...files(), loose])
    const issues = problems.find((p) => p.path === loose.path)?.issues ?? []
    expect(issues.some((i) => i.path === '/parents' && i.warning === true)).toBe(true)
    expect(issues.filter((i) => !i.warning)).toEqual([])
  })
})

describe('validateRepo and an address that does not fit its street', () => {
  const place = (id: string, extra: string) => ({ path: `entities/places/${id}.yaml`, text: `id: ${id}\ntype: place\nname: ${id}\n${extra}` })
  const tree = [place('schnackenburg', 'kind: locality\n'), { ...place('schnackenburg/niedernstrasse', 'kind: street\nparent: schnackenburg\n'), text: 'id: schnackenburg/niedernstrasse\ntype: place\nname: Niedernstraße\nkind: street\nparent: schnackenburg\n' }]

  it('warns when the address names another street than the parent, and only warns', () => {
    const house = (address: string) => place('schnackenburg/niedernstrasse/3', `kind: building\nparent: schnackenburg/niedernstrasse\naddress: ${address}\n`)
    const issues = (address: string) => validateRepo([...files(), ...tree, house(address)]).flatMap((p) => p.issues)
    expect(issues('Niedernstr. 3, 29493 Schnackenburg')).toEqual([])
    expect(issues('Alandstraße 7, 29493 Schnackenburg')).toEqual([{ path: '/address', message: 'the address names Alandstraße, but the building lies in Niedernstraße', warning: true }])
  })
})
