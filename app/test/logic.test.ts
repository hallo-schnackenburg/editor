import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoAddress, similarEntries, findHolder, fullName, holderOf, parseAddress, streetKey, describeIssue, issueText, nextDates, whenText, fieldOfIssue, groups, idOf, isDirty, issuesOf, makeEntry, newEntry, setRole, setValue, titleOf, typeOf, withText, shortName, newContextFor, newContextBelow, excludedTargets, movedFile, renumbered, groupIndex, isGroup, type Entry } from '../src/logic.js'

const ROOT = new URL('../../core/test/fixtures/examples/', import.meta.url).pathname
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))
const examples = () => walk(ROOT).map((f) => makeEntry(f.slice(ROOT.length), readFileSync(f, 'utf8'), 'sha'))
const find = (id: string) => examples().find((e) => idOf(e) === id)!

describe('an entry', () => {
  it('knows its id, type and what people call it', () => {
    const e = find('erika-mustermann')
    expect([idOf(e), typeOf(e), titleOf(e)]).toEqual(['erika-mustermann', 'person', 'Erika Mustermann'])
    expect(titleOf(find('osterfeuer-tradition'))).toBe('Das Osterfeuer am Elbdeich')
    expect(titleOf(makeEntry('entities/people/x.yaml', 'nonsense: ['))).toBe('x')
  })

  it('is dirty once its text differs from the saved one', () => {
    const e = find('erika-mustermann')
    expect(isDirty(e)).toBe(false)
    expect(isDirty(withText(e, e.text + '# note\n'))).toBe(true)
  })
})

describe('issues', () => {
  const all = examples()
  it('are none for the examples', () => {
    for (const e of all) expect(issuesOf(e, all), e.path).toEqual([])
  })

  it('include the shape, the path and the references', () => {
    const content = find('osterfeuer-tradition')
    const broken = withText(content, content.text.replace('about: [osterfeuer, feuerwehr-schnackenburg]', 'about: [osterfeuer, gibts-nicht]'))
    expect(issuesOf(broken, all).map((i) => i.message)).toEqual(['"gibts-nicht" does not exist'])
    expect(issuesOf(withText(content, 'id: ['), all)[0].message).toMatch(/syntax error/)
    expect(issuesOf({ ...content, path: 'contents/anders.yaml' }, all)[0].message).toMatch(/id must be the file name/)
  })

  it('belong to the field of their path', () => {
    expect(fieldOfIssue({ path: '/about/1', message: '' })).toBe('about')
    expect(fieldOfIssue({ path: '/text/teaser', message: '' })).toBe('text')
    expect(fieldOfIssue({ path: '/', message: '' })).toBeUndefined()
  })
})

describe('groups', () => {
  it('sort the entries by type and name, and filter', () => {
    const all = examples()
    expect(groups(all).map((g) => [g.label, g.entries.map(titleOf)])).toEqual([
      ['Person', ['Erika Mustermann']],
      ['Organisation', ['Freiwillige Feuerwehr Schnackenburg']],
      ['Ort', ['Festplatz am Elbdeich', 'Feuerwehrhaus Schnackenburg']],
      ['Ereignis', ['Osterfeuer in Schnackenburg']],
      ['Inhalt', ['Das Osterfeuer am Elbdeich']],
      ['Objekt', ['Osterfeuer', 'Osterfeuer am Deich']],
    ])
    expect(groups(all, 'feuerwehr').map((g) => g.label)).toEqual(['Organisation', 'Ort'])
  })
})

describe('setValue', () => {
  const person = find('erika-mustermann')

  it('changes a text field and keeps the rest', () => {
    const text = setValue(person, 'name', 'string', 'Erika M.')
    expect(text).toContain('name: Erika M.')
    expect(text).toContain('links:')
  })

  it('takes a field out when it is emptied', () => {
    expect(setValue(person, 'links', 'links', [{ label: '', url: '' }])).not.toContain('links')
    expect(setValue(person, 'links', 'links', [{ label: 'Homepage', url: '' }])).not.toContain('links')
    expect(setValue(find('osterfeuer-tradition'), 'authors', 'ref', [])).not.toContain('authors')
  })

  it('writes references as a list, a location only when both numbers are there, and a flag only when set', () => {
    const place = newEntry('place', 'Fähre')
    expect(setValue(place, 'location', 'location', { lat: 53, lon: null })).not.toContain('location')
    expect(setValue(place, 'location', 'location', { lat: 53.01, lon: 11.5 })).toMatch(/location:\n {2}lat: 53.01\n {2}lon: 11.5/)
    const event = newEntry('event', 'Fest')
    expect(setValue(event, 'recurring', 'boolean', true)).toContain('recurring: true')
    expect(setValue(withText(event, setValue(event, 'recurring', 'boolean', true)), 'recurring', 'boolean', false)).not.toContain('recurring')
    expect(setValue(event, 'organizers', 'ref', ['a', 'b'])).toMatch(/organizers:\n {2}- a\n {2}- b/)
  })

  it('writes a text role as a block', () => {
    const content = newEntry('content', 'Fest', 'veranstaltungen')
    expect(setRole(content, 'teaser', 'Ein Satz.')).toContain('text:\n  teaser: |\n    Ein Satz.\n')
  })
})

describe('newEntry', () => {
  it('makes the id from the name and files it where its type says', () => {
    const e = newEntry('person', 'Erika Müller')
    expect([e.path, e.sha, isDirty(e)]).toEqual(['entities/people/erika-mueller.yaml', undefined, true])
    expect(e.text).toBe('id: erika-mueller\ntype: person\nname: "Erika Müller"\n')
  })

  it('files a content in the topic folder, as a title', () => {
    const e = newEntry('content', 'Das Osterfeuer', ' Kunst & Kultur ')
    expect(e.path).toBe('contents/kunst-kultur/das-osterfeuer.yaml')
    expect(e.text).toContain('title: "Das Osterfeuer"')
    expect(() => newEntry('content', 'Ohne Thema', '')).toThrow(/Thema/)
  })

  it('files an entity in a free folder below its type, and the id is the path', () => {
    const e = newEntry('place', 'Haus 4', ' Gummern / Haupt Straße ', undefined, { parent: 'gummern', kind: 'building' })
    expect(e.path).toBe('entities/places/gummern/haupt-strasse/haus-4.yaml')
    expect(e.text).toBe('id: gummern/haupt-strasse/haus-4\ntype: place\nname: "Haus 4"\nkind: building\nparent: gummern\n')
    expect(newEntry('place', 'Gummern').path).toBe('entities/places/gummern.yaml')
  })

  it('puts a number at the end of the name when the id is in use', () => {
    const taken = new Set(['gummern/3', 'gummern/3-2'])
    expect(newEntry('place', '3', 'gummern', undefined, { taken: (id) => taken.has(id) }).path).toBe('entities/places/gummern/3-3.yaml')
    expect(newEntry('person', 'Erika', '', undefined, { parent: 'x' }).text).not.toContain('parent')
  })

  it('makes object ids that are ULIDs, with the type, and refuses a name that has no letter', () => {
    const photo = newEntry('object', 'Kirchturm', '', (b) => b.fill(0), { kind: 'image' })
    expect(photo.path).toMatch(/^objects\/00\/[0-7][0-9a-hjkmnp-tv-z]{9}0{16}\.yaml$/)
    expect(photo.text).toContain('type: object\ntitle: "Kirchturm"\nkind: image\n')
    expect(() => newEntry('person', '???')).toThrow(/keine gültige ID/)
  })
})

describe('where a new entry is made (the plus in the tree)', () => {
  const at = (id: string, name: string, kind: string, parent?: string) => makeEntry(`entities/places/${id}.yaml`, `id: ${id}\ntype: place\nname: ${name}\nkind: ${kind}\n${parent ? `parent: ${parent}\n` : ''}`)
  const gummern = at('gummern', 'Gummern', 'locality', 'schnackenburg')
  const markt = at('schnackenburg/am-markt', 'Am Markt', 'street', 'schnackenburg')

  it('takes the type from the folder, and the folder below the folder of the type', () => {
    expect(newContextFor('entities')).toBeUndefined()
    expect(newContextFor('entities/people')).toEqual({ type: 'person', folder: '' })
    expect(newContextFor('entities/places')).toEqual({ type: 'place', folder: '', kind: 'locality' }) // the first places are localities
    expect(newContextFor('contents')).toEqual({ type: 'content', folder: '' })
    expect(newContextFor('contents/geschichte')).toEqual({ type: 'content', folder: 'geschichte' })
    expect(newContextFor('objects')).toEqual({ type: 'object', folder: '' })
    expect(newContextFor('objects/ae')).toBeUndefined() // the folders are made by the app
    expect(newContextFor('entities/places/schnackenburg/elbstrasse')).toEqual({ type: 'place', folder: 'schnackenburg/elbstrasse' })
  })

  it('makes the place beside the folder the parent of a new place (a locality: any kind, a street: a building)', () => {
    expect(newContextFor('entities/places/gummern', gummern)).toEqual({ type: 'place', folder: 'gummern', parent: 'gummern', kind: undefined })
    expect(newContextFor('entities/places/schnackenburg/am-markt', markt)).toEqual({ type: 'place', folder: 'schnackenburg/am-markt', parent: 'schnackenburg/am-markt', kind: 'building' })
  })

  it('takes the place above for a folder that has none of its own, and "sonstige" for another place', () => {
    const schnackenburg = at('schnackenburg', 'Schnackenburg', 'locality')
    expect(newContextFor('entities/places/schnackenburg/sonstige', undefined, schnackenburg)).toEqual({ type: 'place', folder: 'schnackenburg/sonstige', parent: 'schnackenburg', kind: 'other' })
    expect(newContextFor('entities/places/sonstige')).toEqual({ type: 'place', folder: 'sonstige' })
  })

  it('does not offer a place itself or the places in it as the place it lies in', () => {
    const ort = at('a', 'A', 'locality')
    const strasse = at('a/b', 'B', 'street', 'a')
    const haus = at('a/b/1', 'Haus', 'building', 'a/b')
    const andere = at('c', 'C', 'locality')
    expect(excludedTargets(ort, 'parent', [ort, strasse, haus, andere]).sort()).toEqual(['a', 'a/b', 'a/b/1'])
    expect(excludedTargets(strasse, 'parent', [ort, strasse, haus, andere]).sort()).toEqual(['a/b', 'a/b/1'])
    expect(excludedTargets(ort, 'about', [ort, strasse])).toEqual(['a'])
  })

  it('offers a plus at a street without a folder, but not at a building', () => {
    expect(newContextBelow(markt)).toEqual({ type: 'place', folder: 'schnackenburg/am-markt', parent: 'schnackenburg/am-markt', kind: 'building' })
    expect(newContextBelow(at('schnackenburg/am-markt/3', 'Am Markt 3', 'building', 'schnackenburg/am-markt'))).toBeUndefined()
  })
})

describe('places', () => {
  it('shortens a house under the entry its folder is named after (with Nr.)', () => {
    expect([shortName('Am Markt 3', 'Am Markt'), shortName('Am Markt 3a', 'Am Markt'), shortName('Am Markt Passage', 'Am Markt'), shortName('Kirche Gartow', 'Am Markt'), shortName('Am Markt', 'Am Markt')]).toEqual(['Nr. 3', 'Nr. 3a', 'Passage', 'Kirche Gartow', 'Am Markt'])
  })

  it('takes the path below the folder of the type as the id, when the entry does not say', () => {
    expect(idOf(makeEntry('entities/places/gummern/3.yaml', ''))).toBe('gummern/3')
    expect(idOf(makeEntry('entities/places/schnackenburg/elbstrasse/3.yaml', 'id: x\n'))).toBe('x')
    expect(idOf(makeEntry('contents/geschichte/mühle.yaml', ''))).toBe('mühle')
  })

  it('writes the parent as one id, and takes it out when it is emptied', () => {
    const place = newEntry('place', 'Gummern')
    const set = setValue(place, 'parent', 'string', 'schnackenburg')
    expect(set).toContain('parent: schnackenburg')
    expect(setValue(withText(place, set), 'parent', 'string', '')).not.toContain('parent')
  })

  it('checks the kind of a place against the kind of its parent', () => {
    const town = makeEntry('entities/places/s.yaml', 'id: s\ntype: place\nname: S\nkind: locality\n')
    const house = makeEntry('entities/places/h.yaml', 'id: h\ntype: place\nname: H\nkind: building\nparent: s\n')
    const street = makeEntry('entities/places/st.yaml', 'id: st\ntype: place\nname: St\nkind: street\nparent: h\n')
    expect(issuesOf(house, [town, house, street])).toEqual([])
    expect(issuesOf(street, [town, house, street]).map((i) => i.message)).toEqual(['a street lies in a locality, not in a building'])
  })
})

describe('events', () => {
  const event = (extra: string) => makeEntry('entities/events/lichterfest.yaml', `id: lichterfest\ntype: event\nname: Lichterfest\n${extra}`, 'sha')

  it('writes dates, and a rule only when it has text and a start', () => {
    const e = event('')
    expect(setValue(e, 'dates', 'dates', [{ start: '2026-11-28', note: 'Markt' }, { start: '' }])).toMatch(/dates:\n {2}- start: "?2026-11-28"?\n {4}note: Markt\n/)
    expect(setValue(e, 'rule', 'rule', { rrule: ' FREQ=YEARLY;BYADVENT=-1 ', start: '2024-01-01' })).toMatch(/rule:\n {2}rrule: FREQ=YEARLY;BYADVENT=-1\n {2}start: "?2024-01-01"?/)
    expect(setValue(e, 'rule', 'rule', { rrule: '', start: '2024-01-01' })).not.toContain('rule')
  })

  it('finds what an event lacks: a one-off event needs a date, a recurring one a rule that is right', () => {
    expect(issuesOf(event(''), []).map((i) => i.path)).toEqual(['/dates'])
    expect(issuesOf(event('dates:\n  - start: 2026-11-28\n'), [])).toEqual([])
    expect(issuesOf(event('recurring: true\n'), [])).toEqual([])
    expect(issuesOf(event('recurring: true\nrule:\n  rrule: FREQ=MONTHLY;BYADVENT=-1\n  start: 2024-01-01\n'), []).map((i) => i.path)).toEqual(['/rule'])
  })

  it('says it in German', () => {
    const e = event('')
    expect(describeIssue(e, { path: '/dates', message: 'a one-off event needs a date' })).toBe('Termine: Ein einmaliges Ereignis braucht mindestens einen Termin')
    expect(issueText('the end is before the start')).toBe('Das Ende liegt vor dem Beginn')
    expect(issueText('something else')).toBe('something else')
  })
})


describe('showing dates', () => {
  it('reads dates, and does not break on what is not one', () => {
    expect(whenText('2026-04-04')).toMatch(/04\.04\.2026/)
    expect(whenText('2026-04-04T20:00')).toContain('20:00 Uhr')
    expect(whenText(undefined)).toBe('')
    expect(whenText('bald')).toBe('bald')
  })

  it('has no upcoming dates for a rule that is not right, instead of an error', () => {
    expect(nextDates({ rrule: 'FREQ=YEARLY;BYEASTER=-1', start: '2020-01-01' })).toHaveLength(3)
    expect(nextDates({ rrule: undefined, start: '2020-01-01' } as never)).toEqual([])
    expect(nextDates({ rrule: 'FREQ=YEARLY', start: undefined } as never)).toEqual([])
    expect(nextDates({} as never)).toEqual([])
  })
})

describe('objects in the form', () => {
  const photo = () => makeEntry('objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml', 'id: 01kb4z8m3q7xv2n5r6t9c0d1ae\ntype: object\nkind: image\ntitle: Foto\n', 'sha')

  it('sets a group field from its parts, and takes empty parts and the whole field out', () => {
    const entry = photo()
    const text = setValue(entry, 'origin', 'group', { by: ['erika-mustermann'], place: '' })
    expect(text).toContain('origin:\n  by:\n    - erika-mustermann\n')
    expect(text).not.toContain('place')
    expect(setValue(withText(entry, text), 'origin', 'group', { by: [], place: '' })).not.toContain('origin')
  })

  it('offers as parents only groups that do not lie in the object itself', () => {
    const group = (id: string, parents?: string[]) => makeEntry(`objects/xx/${id}.yaml`, `id: ${id}\ntype: object\nkind: group\ntitle: ${id}\n${parents ? `parents: [${parents.join(', ')}]\n` : ''}`, 'sha')
    const outer = group('outer')
    const inner = group('inner', ['outer'])
    const other = group('other')
    const single = makeEntry('objects/xx/single.yaml', 'id: single\ntype: object\nkind: image\ntitle: Foto\n', 'sha')
    expect(excludedTargets(outer, 'parents', [outer, inner, other, single]).sort()).toEqual(['inner', 'outer', 'single'])
  })

  it('finds a group that lies in itself, and a parent that is no group', () => {
    const a = makeEntry('objects/xx/a.yaml', 'id: 01kb4z8m3q7xv2n5r6t9c0d1aa\ntype: object\nkind: group\ntitle: A\nparents: [01kb4z8m3q7xv2n5r6t9c0d1ab]\n', 'sha')
    const b = makeEntry('objects/xx/b.yaml', 'id: 01kb4z8m3q7xv2n5r6t9c0d1ab\ntype: object\nkind: group\ntitle: B\nparents: [01kb4z8m3q7xv2n5r6t9c0d1aa]\n', 'sha')
    expect(issuesOf(a, [a, b]).map((i) => i.message)).toContain('an object cannot be in itself or in a group that is in it')
    const photo = makeEntry('objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml', 'id: 01kb4z8m3q7xv2n5r6t9c0d1ae\ntype: object\nkind: image\ntitle: F\nparents: [01kb4z8m3q7xv2n5r6t9c0d1ac]\n', 'sha')
    const notGroup = makeEntry('objects/ac/01kb4z8m3q7xv2n5r6t9c0d1ac.yaml', 'id: 01kb4z8m3q7xv2n5r6t9c0d1ac\ntype: object\nkind: image\ntitle: G\n', 'sha')
    expect(issuesOf(photo, [photo, notGroup]).map((i) => i.message)).toEqual(['"01kb4z8m3q7xv2n5r6t9c0d1ac" is not a group'])
  })
})

describe('the order of files', () => {
  const page = (sha: string, num: number) => ({ sha256: sha, role: 'page', num })
  const shas = (files: { sha256?: unknown }[]) => files.map((f) => f.sha256)

  it('moves a page and numbers the pages anew', () => {
    const moved = movedFile([page('a', 1), page('b', 2), page('c', 3)], 'c', -1, true)
    expect(moved.map((f) => [f.sha256, f.num])).toEqual([['a', 1], ['c', 2], ['b', 3]])
  })

  it('leaves the list as it is at the ends and for unknown files', () => {
    const files = [page('a', 1), page('b', 2)]
    expect(movedFile(files, 'a', -1, true)).toBe(files)
    expect(movedFile(files, 'b', 1, true)).toBe(files)
    expect(movedFile(files, 'x', 1, true)).toBe(files)
  })

  it('does not number what is not numbered', () => {
    expect(movedFile([{ sha256: 'a' }, { sha256: 'b' }], 'a', 1, false).map((f) => f.num)).toEqual([undefined, undefined])
  })

  it('closes the gap of a removed page', () => {
    expect(shas(renumbered([page('a', 1), page('c', 3)]))).toEqual(['a', 'c'])
    expect(renumbered([page('a', 1), page('c', 3)]).map((f) => f.num)).toEqual([1, 2])
  })
})

describe('the groups of the objects', () => {
  const object = (id: string, kind: string, title: string, parents?: string[]) =>
    makeEntry(`objects/${id.slice(-2)}/${id}.yaml`, `id: ${id}\ntype: object\nkind: ${kind}\ntitle: ${title}\n${parents ? `parents: [${parents.join(', ')}]\n` : ''}`, 'sha')
  const A = '01kb4z8m3q7xv2n5r6t9c0d1aa'
  const B = '01kb4z8m3q7xv2n5r6t9c0d1bb'
  const C = '01kb4z8m3q7xv2n5r6t9c0d1cc'
  const D = '01kb4z8m3q7xv2n5r6t9c0d1dd'
  const E = '01kb4z8m3q7xv2n5r6t9c0d1ee'
  const titles = (list: ReturnType<typeof makeEntry>[] | undefined) => (list ?? []).map(titleOf)

  it('is a tree: groups without a group are the roots, groups come before the other members', () => {
    const all = [object(A, 'group', 'Fotos'), object(B, 'group', 'Alben', [A]), object(C, 'image', 'Brücke', [A]), object(D, 'image', 'Deich', [B])]
    const tree = groupIndex(all)
    expect(titles(tree.roots)).toEqual(['Fotos'])
    expect(titles(tree.members.get(A))).toEqual(['Alben', 'Brücke'])
    expect(titles(tree.members.get(B))).toEqual(['Deich'])
    expect(tree.loose).toEqual([])
  })

  it('has an object in several groups', () => {
    const tree = groupIndex([object(A, 'group', 'Fotos'), object(B, 'group', 'Favoriten'), object(C, 'image', 'Brücke', [A, B])])
    expect(titles(tree.members.get(A))).toEqual(['Brücke'])
    expect(titles(tree.members.get(B))).toEqual(['Brücke'])
    expect(tree.up.get(C)).toEqual([A, B])
  })

  it('keeps what is in no group that exists apart, and the other entries out', () => {
    const tree = groupIndex([object(A, 'group', 'Fotos'), object(C, 'image', 'Ohne'), object(D, 'image', 'Verwaist', [E]), object(B, 'group', 'Verwaist', [E]), object(E, 'image', 'Kein Gruppe', [A]), ...examples().filter((e) => typeOf(e) !== 'object')])
    expect(titles(tree.roots)).toEqual(['Fotos'])
    expect(titles(tree.loose).sort()).toEqual(['Ohne', 'Verwaist', 'Verwaist'])
    expect(isGroup(tree.byId.get(A)!)).toBe(true)
    expect(isGroup(tree.byId.get(C)!)).toBe(false)
  })

  it('is not led in circles by groups that are in each other', () => {
    const tree = groupIndex([object(A, 'group', 'A', [B]), object(B, 'group', 'B', [A]), object(C, 'group', 'C', [C])])
    expect(tree.roots).toEqual([])
    expect(titles(tree.members.get(A))).toEqual(['B'])
    expect(tree.up.get(C)).toEqual([])
  })

  it('is in a new object when it is made in a group', () => {
    const photo = newEntry('object', 'Kirchturm', '', (b) => b.fill(0), { kind: 'image', group: A })
    expect(photo.data?.parents).toEqual([A])
  })
})

describe('the address of a building', () => {
  const place = (id: string, extra: string) => makeEntry(`entities/places/${id}.yaml`, `id: ${id}\ntype: place\n${extra}`, 'sha')
  const world = [
    place('schnackenburg', 'name: Schnackenburg\nkind: locality\npostal_code: "29493"\n'),
    place('gummern', 'name: Gummern\nkind: locality\nparent: schnackenburg\n'),
    place('aulosen', 'name: Aulosen\nkind: locality\npostal_code: "39615"\n'),
    place('aulosen/haus', 'name: Aulosen 4\nkind: building\nparent: aulosen\n'),
  ]
  const building = (name: string, parent = 'gummern') => place('gummern/x', `name: ${name}\nkind: building\nparent: ${parent}\n`)

  it('is the name, the postal code of the nearest place above that has one, and its name', () => {
    expect(autoAddress(building('Gummern 3'), world)).toBe('Gummern 3, 29493 Schnackenburg')
    expect(autoAddress(world[3], world)).toBe('Aulosen 4, 39615 Aulosen')
  })

  it('is nothing for a name that is not a place and a house number, for another kind, or without a postal code above', () => {
    expect(autoAddress(building('Gasthaus Gummern'), world)).toBeUndefined()
    expect(autoAddress(building('Gummern'), world)).toBeUndefined()
    expect(autoAddress(place('gummern/y', 'name: Gummern 3\nkind: other\nparent: gummern\n'), world)).toBeUndefined()
    expect(autoAddress(building('Gummern 3'), world.filter((e) => idOf(e) !== 'schnackenburg'))).toBeUndefined()
    expect(autoAddress(building('Gummern 3', 'nowhere'), world)).toBeUndefined()
  })

  it('does not run in circles when places lie in each other', () => {
    const loop = [place('a', 'name: A\nkind: locality\nparent: b\n'), place('b', 'name: B\nkind: locality\nparent: a\n')]
    expect(autoAddress(place('a/1', 'name: A 1\nkind: building\nparent: a\n'), loop)).toBeUndefined()
  })
})

describe('finding where a house belongs', () => {
  const place = (id: string, extra: string) => makeEntry(`entities/places/${id}.yaml`, `id: ${id}\ntype: place\n${extra}`, 'sha')
  const world = [
    place('schnackenburg', 'name: Schnackenburg\nkind: locality\npostal_code: "29493"\n'),
    place('schnackenburg/niedernstrasse', 'name: Niedernstraße\nkind: street\nparent: schnackenburg\n'),
    place('gummern', 'name: Gummern\nkind: locality\nparent: schnackenburg\n'),
    place('schnackenburg/dorfstrasse', 'name: Dorfstraße\nkind: street\nparent: schnackenburg\n'),
    place('kapern', 'name: Kapern\nkind: locality\n'),
    place('kapern/dorfstrasse', 'name: Dorfstraße\nkind: street\nparent: kapern\n'),
  ]

  it('compares street names however they are written', () => {
    for (const s of ['Niedernstraße', 'niedernstrasse', 'Niedernstr.', 'Niedernstr', 'NIEDERN-STRASSE']) expect(streetKey(s), s).toBe('niedernstrasse')
  })

  it('splits an address into street, number, postal code and town', () => {
    expect(parseAddress('Niedernstr. 3a, 29493 Schnackenburg')).toEqual({ street: 'Niedernstr.', number: '3a', postal: '29493', town: 'Schnackenburg' })
    expect(parseAddress('Gummern 10')).toEqual({ street: 'Gummern', number: '10' })
    expect(parseAddress('Alter Postweg 25, Schnackenburg')).toEqual({ street: 'Alter Postweg', number: '25', town: 'Schnackenburg' })
    expect(parseAddress('Gasthaus Holtorf')).toBeUndefined()
  })

  it('finds the one street or place of that name, and none when it is not clear', () => {
    expect(findHolder('Niedernstr.', undefined, world)).toBe(world[1])
    expect(findHolder('Gummern', undefined, world)).toBe(world[2])
    expect(findHolder('Dorfstraße', undefined, world)).toBeUndefined()
    expect(findHolder('Dorfstraße', 'Kapern', world)).toBe(world[5])
    expect(findHolder('Dorfstraße', 'Schnackenburg', world)).toBe(world[3])
    expect(findHolder('Nirgends', undefined, world)).toBeUndefined()
  })

  it('says where a house without a parent belongs, by its address or else its name', () => {
    const house = (extra: string) => place('schnackenburg/x', `kind: building\n${extra}`)
    expect(holderOf(house('name: Niedernstraße 3\n'), world)?.parent).toBe(world[1])
    expect(holderOf(house('name: Haus\naddress: Gummern 10, 29493 Schnackenburg\n'), world)).toMatchObject({ number: '10' })
    expect(holderOf(house('name: Niedernstraße 3\nparent: gummern\n'), world)).toBeUndefined()
    expect(holderOf(place('x', 'name: Niedernstraße 3\nkind: street\n'), world)).toBeUndefined()
  })

  it('names a building that is only a number after its street, and makes its address from that', () => {
    const house = place('schnackenburg/niedernstrasse/3', 'name: "3"\nkind: building\nparent: schnackenburg/niedernstrasse\n')
    expect(fullName(house, world)).toBe('Niedernstraße 3')
    expect(autoAddress(house, world)).toBe('Niedernstraße 3, 29493 Schnackenburg')
    expect(fullName(place('x', 'name: Feuerwehr\nkind: building\nparent: gummern\n'), world)).toBe('Feuerwehr')
  })
})

describe('entries a new one may be a second of', () => {
  const place = (id: string, name: string) => makeEntry(`entities/places/${id}.yaml`, `id: ${id}\ntype: place\nname: ${name}\nkind: other\n`, 'sha')
  const org = (id: string, name: string) => makeEntry(`entities/organizations/${id}.yaml`, `id: ${id}\ntype: organization\nname: ${name}\n`, 'sha')
  const all = [place('aussichtspunkt', 'Aussichtspunkt'), place('marktplatz', 'Marktplatz'), place('fischerhaus', 'Fischerhaus'), org('aussichtsturm', 'Aussichtsturm')]
  const names = (found: Entry[]) => found.map((e) => e.data?.name)

  it('finds the same name written differently, one inside the other, and the same stem', () => {
    expect(names(similarEntries(place('neu', 'Aussichtsturm'), all))).toEqual(['Aussichtspunkt'])
    expect(names(similarEntries(place('neu', 'Markt-Platz'), all))).toEqual(['Marktplatz'])
    expect(names(similarEntries(place('neu', 'Fischerhaus am Hafen'), all))).toEqual(['Fischerhaus'])
    expect(names(similarEntries(place('neu', 'Fischerhauss'), all))).toEqual(['Fischerhaus'])
  })

  it('looks only at entries of the same type, never at itself, and not at names that are too short or not alike', () => {
    expect(similarEntries(place('x', 'Hafen'), all)).toEqual([])
    expect(similarEntries(place('x', 'Ab'), all)).toEqual([])
    expect(similarEntries(all[1], all)).toEqual([])
  })
})
