import { describe, expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { idOf, makeEntry, placeMove, siblingTarget, type Entry } from '../src/logic.js'
import { Workspace } from '../src/workspace.svelte.js'

const SEED: Record<string, string> = {
  'entities/places/schnackenburg.yaml': 'id: schnackenburg\ntype: place\nname: Schnackenburg\nkind: locality\npostal_code: "29493"\n',
  'entities/places/gummern.yaml': 'id: gummern\ntype: place\nname: Gummern\nkind: locality\nparent: schnackenburg\n',
  'entities/places/schnackenburg/niedernstrasse.yaml': 'id: schnackenburg/niedernstrasse\ntype: place\nname: Niedernstraße\nkind: street\nparent: schnackenburg\n',
  'entities/places/schnackenburg/am-markt.yaml': 'id: schnackenburg/am-markt\ntype: place\nname: Am Markt\nkind: square\nparent: schnackenburg\n',
  'entities/places/schnackenburg/niedernstrasse/niedernstrasse-3.yaml':
    'id: schnackenburg/niedernstrasse/niedernstrasse-3\ntype: place\nname: Niedernstraße 3\nkind: building\nparent: schnackenburg/niedernstrasse\naddress: Niedernstraße 3, 29493 Schnackenburg\n',
  'entities/places/schnackenburg/niedernstrasse/rathaus.yaml': 'id: schnackenburg/niedernstrasse/rathaus\ntype: place\nname: Rathaus\nkind: building\nparent: schnackenburg/niedernstrasse\naddress: Hinter dem Markt 1\n',
  'entities/places/schnackenburg/sonstige/aussichtsturm.yaml': 'id: schnackenburg/sonstige/aussichtsturm\ntype: place\nname: Aussichtsturm\nkind: other\nparent: schnackenburg\n',
  'entities/organizations/verein.yaml': 'id: verein\ntype: organization\nname: Verein\nplaces: [schnackenburg/niedernstrasse/niedernstrasse-3]\n',
}
const entries = (): Entry[] => Object.entries(SEED).map(([path, text]) => makeEntry(path, text, 'sha'))
const get = (list: Entry[], id: string) => list.find((e) => idOf(e) === id)!

describe('placeMove', () => {
  const all = entries()
  const house = get(all, 'schnackenburg/niedernstrasse/niedernstrasse-3')
  const markt = get(all, 'schnackenburg/am-markt')
  const strasse = get(all, 'schnackenburg/niedernstrasse')
  const ort = get(all, 'schnackenburg')
  const turm = get(all, 'schnackenburg/sonstige/aussichtsturm')

  it('moves a building from one street to the next, into the folder of the new one', () => {
    expect(placeMove(house, { parent: markt }, all)).toEqual({ parent: 'schnackenburg/am-markt', folder: 'schnackenburg/am-markt' })
  })
  it('does nothing where it already is', () => {
    expect(placeMove(house, { parent: strasse }, all)).toBeUndefined()
  })
  it('does not put a street in a street, or a place in itself or below', () => {
    expect(placeMove(strasse, { parent: markt }, all)).toBeUndefined()
    expect(placeMove(strasse, { parent: strasse }, all)).toBeUndefined()
    expect(placeMove(ort, { parent: strasse }, all)).toBeUndefined()
  })
  it('puts a street in a locality, and another place in the folder "sonstige" of it', () => {
    const gummern = get(all, 'gummern')
    expect(placeMove(strasse, { parent: gummern }, all)).toEqual({ parent: 'gummern', folder: 'gummern' })
    expect(placeMove(turm, { parent: gummern }, all)).toEqual({ parent: 'gummern', folder: 'gummern/sonstige' })
    expect(placeMove(turm, { parent: gummern, other: true }, all)).toEqual({ parent: 'gummern', folder: 'gummern/sonstige' })
    // anything but a locality dropped on a folder "sonstige" becomes another place
    expect(placeMove(house, { parent: gummern, other: true }, all)).toEqual({ parent: 'gummern', folder: 'gummern/sonstige', kind: 'other' })
    expect(placeMove(get(all, 'gummern'), { parent: ort, other: true }, all)).toBeUndefined()
    expect(placeMove(turm, { parent: ort, other: true }, all)).toBeUndefined() // it is there
    expect(placeMove(turm, { parent: strasse }, all)).toBeUndefined()
  })
  it('puts any place directly under "Orte" (without a parent), if it does not lie there', () => {
    expect(placeMove(get(all, 'gummern'), {}, all)).toEqual({ folder: '' })
    expect(placeMove(house, {}, all)).toEqual({ folder: '' })
    expect(placeMove(ort, {}, all)).toBeUndefined()
  })
  it('puts a place into the folder "sonstige" under "Orte": no parent, and another place', () => {
    expect(placeMove(turm, { other: true }, all)).toEqual({ folder: 'sonstige' })
    expect(placeMove(house, { other: true }, all)).toEqual({ folder: 'sonstige', kind: 'other' })
    expect(placeMove(ort, { other: true }, all)).toBeUndefined()
  })
  it('takes the place a sibling lies in as the target, or "Orte" for one that lies in none', () => {
    const rathaus = get(all, 'schnackenburg/niedernstrasse/rathaus')
    expect(siblingTarget(rathaus, all)?.parent).toBe(strasse)
    expect(placeMove(get(all, 'schnackenburg/am-markt'), siblingTarget(rathaus, all)!, all)).toBeUndefined() // a square in a street: no
    expect(placeMove(house, siblingTarget(markt, all)!, all)).toEqual({ parent: 'schnackenburg', folder: 'schnackenburg' }) // beside a square: into the locality
    expect(placeMove(turm, siblingTarget(strasse, all)!, all)).toBeUndefined() // it lies there already
    expect(siblingTarget(ort, all)).toEqual({})
    // beside a place in a folder "sonstige" is that folder: a house dropped there becomes another place
    expect(siblingTarget(turm, all)).toEqual({ parent: ort, other: true })
    expect(placeMove(house, siblingTarget(turm, all)!, all)).toEqual({ parent: 'schnackenburg', folder: 'schnackenburg/sonstige', kind: 'other' })
    expect(placeMove(rathaus, siblingTarget(turm, all)!, all)).toEqual({ parent: 'schnackenburg', folder: 'schnackenburg/sonstige', kind: 'other' })
    expect(siblingTarget(undefined, all)).toBeUndefined()
  })
})

async function started() {
  const ws = new Workspace(new FakeApi(SEED))
  await ws.start()
  ws.stopLive()
  return ws
}

describe('Workspace.movePlace', () => {
  it('moves the house, names it after the new street, makes its address again and rewrites the references', async () => {
    const ws = await started()
    const error = await ws.movePlace('entities/places/schnackenburg/niedernstrasse/niedernstrasse-3.yaml', { parent: 'schnackenburg/am-markt', folder: 'schnackenburg/am-markt' })
    expect(error).toBeUndefined()
    const moved = ws.entries.find((e) => e.path === 'entities/places/schnackenburg/am-markt/am-markt-3.yaml')
    expect(moved?.data).toMatchObject({ id: 'schnackenburg/am-markt/am-markt-3', name: 'Am Markt 3', parent: 'schnackenburg/am-markt', address: 'Am Markt 3, 29493 Schnackenburg' })
    expect(ws.entries.some((e) => e.path.endsWith('niedernstrasse-3.yaml'))).toBe(false)
    expect(ws.entries.find((e) => idOf(e) === 'verein')?.data?.places).toEqual(['schnackenburg/am-markt/am-markt-3'])
    expect(ws.dirty).toEqual([])
  })

  it('keeps the name and a hand-written address of a house that is not named after its street', async () => {
    const ws = await started()
    expect(await ws.movePlace('entities/places/schnackenburg/niedernstrasse/rathaus.yaml', { parent: 'schnackenburg/am-markt', folder: 'schnackenburg/am-markt' })).toBeUndefined()
    expect(ws.entries.find((e) => e.path === 'entities/places/schnackenburg/am-markt/rathaus.yaml')?.data).toMatchObject({ name: 'Rathaus', parent: 'schnackenburg/am-markt', address: 'Hinter dem Markt 1' })
  })

  it('moves a street with what lies in it', async () => {
    const ws = await started()
    expect(await ws.movePlace('entities/places/schnackenburg/niedernstrasse.yaml', { parent: 'gummern', folder: 'gummern' }, () => true)).toBeUndefined()
    const paths = ws.entries.map((e) => e.path)
    expect(paths).toContain('entities/places/gummern/niedernstrasse.yaml')
    expect(paths).toContain('entities/places/gummern/niedernstrasse/niedernstrasse-3.yaml')
    expect(paths.some((p) => p.startsWith('entities/places/schnackenburg/niedernstrasse'))).toBe(false)
  })

  it('changes nothing when the new id is taken', async () => {
    const seed = new Workspace(new FakeApi({ ...SEED, 'entities/places/schnackenburg/am-markt/am-markt-3.yaml': 'id: schnackenburg/am-markt/am-markt-3\ntype: place\nname: Am Markt 3\nkind: building\nparent: schnackenburg/am-markt\n' }))
    await seed.start()
    seed.stopLive()
    const error = await seed.movePlace('entities/places/schnackenburg/niedernstrasse/niedernstrasse-3.yaml', { parent: 'schnackenburg/am-markt', folder: 'schnackenburg/am-markt' })
    expect(error).toMatch(/Es gibt schon einen Eintrag/)
    expect(seed.dirty).toEqual([])
    expect(seed.entries.some((e) => e.path === 'entities/places/schnackenburg/niedernstrasse/niedernstrasse-3.yaml')).toBe(true)
  })

  it('makes a house another place when it is dropped on "sonstige", and takes it out of its street', async () => {
    const ws = await started()
    expect(await ws.movePlace('entities/places/schnackenburg/niedernstrasse/rathaus.yaml', { parent: 'schnackenburg', folder: 'schnackenburg/sonstige', kind: 'other' })).toBeUndefined()
    expect(ws.entries.find((e) => e.path === 'entities/places/schnackenburg/sonstige/rathaus.yaml')?.data).toMatchObject({ kind: 'other', parent: 'schnackenburg', name: 'Rathaus' })
  })
})

describe('renaming a street', () => {
  const seed = (): Record<string, string> => ({
    ...SEED,
    'entities/places/schnackenburg/niedernstrasse.yaml': 'id: schnackenburg/niedernstrasse\ntype: place\nname: Niedernstrasse\nkind: street\nparent: schnackenburg\n',
    'entities/places/schnackenburg/niedernstrasse/niedernstrasse-3.yaml':
      'id: schnackenburg/niedernstrasse/niedernstrasse-3\ntype: place\nname: "3"\nkind: building\nparent: schnackenburg/niedernstrasse\naddress: Niedernstrasse 3, 29493 Schnackenburg\n',
    'entities/places/schnackenburg/niedernstrasse/rathaus.yaml': 'id: schnackenburg/niedernstrasse/rathaus\ntype: place\nname: Rathaus\nkind: building\nparent: schnackenburg/niedernstrasse\naddress: Niedernstr. 5\n',
    'entities/places/schnackenburg/am-markt/laden.yaml': 'id: schnackenburg/am-markt/laden\ntype: place\nname: Laden\nkind: building\nparent: schnackenburg/am-markt\naddress: Niedernstrasse 1\n',
  })

  it('takes the new name into the addresses of what lies in the street, and only of those', async () => {
    const ws = new Workspace(new FakeApi(seed()))
    await ws.start()
    ws.stopLive()
    await ws.select('entities/places/schnackenburg/niedernstrasse.yaml')
    ws.edit(ws.selected!.text.replace('Niedernstrasse', 'Niedernstraße'))
    expect(await ws.finish(() => true, { wait: false })).toBe(true)
    const data = (path: string) => ws.entries.find((e) => e.path === path)?.data
    expect(data('entities/places/schnackenburg/niedernstrasse/niedernstrasse-3.yaml')?.address).toBe('Niedernstraße 3, 29493 Schnackenburg')
    expect(data('entities/places/schnackenburg/niedernstrasse/rathaus.yaml')?.address).toBe('Niedernstraße 5')
    expect(data('entities/places/schnackenburg/am-markt/laden.yaml')?.address).toBe('Niedernstrasse 1')
  })
})
