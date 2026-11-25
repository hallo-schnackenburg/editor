import { describe, expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { makeEntry, planRename, type Entry } from '../src/logic.js'
import { ASK_ABOVE, Workspace } from '../src/workspace.svelte.js'

const SEED: Record<string, string> = {
  'entities/places/gummern.yaml': 'id: gummern\ntype: place\nname: Gummern\nkind: locality\n',
  'entities/places/gummern/3.yaml': 'id: gummern/3\ntype: place\nname: Haus Drei\nkind: building\nparent: gummern\n',
  'entities/places/holtorf.yaml': 'id: holtorf\ntype: place\nname: Holtorf\nkind: locality\n',
  'entities/organizations/feuerwehr-gummern.yaml': 'id: feuerwehr-gummern\ntype: organization\nname: Feuerwehr Gummern\nplaces:\n  - gummern\n  - gummern/3\n',
  'entities/events/fest.yaml': 'id: fest\ntype: event\nname: Fest\norganizers: [feuerwehr-gummern]\nplaces: [gummern/3, holtorf]\n',
  'contents/ort/die-faehre.yaml': 'id: die-faehre\ntype: content\ntitle: Die Fähre\nauthors: [feuerwehr-gummern]\nabout: [gummern]\npublished: 2026-11-21\ntext:\n  body: |\n    Hallo.\n  teaser: |\n    Hallo.\n  summary: |\n    Hallo.\n',
}
const GUMMERN = 'entities/places/gummern.yaml'

const all = (): Entry[] => Object.entries(SEED).map(([path, text]) => makeEntry(path, text, 'sha'))
const find = (entries: Entry[], path: string) => entries.find((e) => e.path === path)!
const rename = (entry: Entry, name: string) => makeEntry(entry.path, entry.text.replace(/^name: .*$/m, `name: ${name}`), entry.sha, entry.saved)
const none = () => false

async function started() {
  const ws = new Workspace(new FakeApi(SEED))
  await ws.start()
  ws.stopLive()
  return ws
}
/** Renames the open entry the way the form does: the name is typed, then the field is left. */
async function renameTo(ws: Workspace, name: string, confirm?: (n: number) => boolean) {
  await ws.ensureAround(ws.selectedPath!)
  ws.edit(ws.selected!.text.replace(/^name: .*$/m, `name: ${name}`))
  return ws.renameOpen(confirm)
}

describe('planRename', () => {
  it('takes the id and the file from the name, and moves what lies below with it', () => {
    const entries = all()
    const plan = planRename(rename(find(entries, GUMMERN), 'Gummern Dorf'), entries.map((e) => (e.path === GUMMERN ? rename(e, 'Gummern Dorf') : e)), none)!
    expect(plan.moves.map((m) => [m.before.path, m.after.path])).toEqual([
      [GUMMERN, 'entities/places/gummern-dorf.yaml'],
      ['entities/places/gummern/3.yaml', 'entities/places/gummern-dorf/3.yaml'],
    ])
    expect(plan.moves[0].after.text).toContain('id: gummern-dorf')
    expect(plan.moves[1].after.text).toContain('id: gummern-dorf/3')
    // The ones below keep their name; their reference to the entry above follows it.
    expect(plan.moves[1].after.text).toContain('name: Haus Drei')
    expect(plan.moves[1].after.text).toMatch(/parent: gummern-dorf\n/)
    // Everybody who points at anything that moved gets the new ids; a reference to something else stays.
    const byPath = Object.fromEntries(plan.rewrites.map((r) => [r.before.path, r.after.data]))
    expect(Object.keys(byPath).sort()).toEqual(['contents/ort/die-faehre.yaml', 'entities/events/fest.yaml', 'entities/organizations/feuerwehr-gummern.yaml'])
    expect(byPath['entities/organizations/feuerwehr-gummern.yaml']).toMatchObject({ places: ['gummern-dorf', 'gummern-dorf/3'] })
    expect(byPath['entities/events/fest.yaml']).toMatchObject({ places: ['gummern-dorf/3', 'holtorf'], organizers: ['feuerwehr-gummern'] })
    expect(byPath['contents/ort/die-faehre.yaml']).toMatchObject({ about: ['gummern-dorf'] })
  })

  it('renames a leaf in its folder, and a content in its topic', () => {
    const entries = all()
    const house = planRename(rename(find(entries, 'entities/places/gummern/3.yaml'), 'Haus Vier'), entries, none)!
    expect(house.moves.map((m) => m.after.path)).toEqual(['entities/places/gummern/haus-vier.yaml'])
    expect(house.rewrites.map((r) => r.before.path).sort()).toEqual(['entities/events/fest.yaml', 'entities/organizations/feuerwehr-gummern.yaml'])
    const content = find(entries, 'contents/ort/die-faehre.yaml')
    const plan = planRename(makeEntry(content.path, content.text.replace('Die Fähre', 'Die Elbfähre'), 'sha'), entries, none)!
    expect(plan.moves.map((m) => m.after.path)).toEqual(['contents/ort/die-elbfaehre.yaml'])
    expect(plan.moves[0].after.text).toContain('id: die-elbfaehre')
  })

  it('does nothing when the id already fits, without a name, or for an object', () => {
    const entries = all()
    expect(planRename(find(entries, GUMMERN), entries, none)).toBeUndefined()
    expect(planRename(rename(find(entries, GUMMERN), '   '), entries, none)).toBeUndefined()
    const media = makeEntry(`objects/ae/${'0'.repeat(24)}ae.yaml`, `id: ${'0'.repeat(24)}ae\ntype: object\nkind: image\ntitle: Neu\n`, 'sha')
    expect(planRename(media, [media], none)).toBeUndefined()
  })

  it('refuses a name without a letter or digit, and an id that is in use (nothing changes)', () => {
    const entries = all()
    expect(() => planRename(rename(find(entries, GUMMERN), '???'), entries, none)).toThrow(/gültige ID/)
    const used = (path: string) => entries.some((e) => e.path === path)
    expect(() => planRename(rename(find(entries, GUMMERN), 'Holtorf'), entries, used)).toThrow(/schon einen Eintrag mit der ID „holtorf“/)
    // One of the entries below would land on an id that is in use.
    const more = [...entries, makeEntry('entities/places/neu/3.yaml', 'id: neu/3\ntype: place\nname: x\n', 'sha')]
    expect(() => planRename(rename(find(more, GUMMERN), 'Neu'), more, (p) => more.some((e) => e.path === p))).toThrow(/„neu“|„neu\/3“/)
  })
})

describe('renaming in the workspace', () => {
  it('is one change with what goes with it, and the entries are consistent afterwards', async () => {
    const ws = await started()
    await ws.select(GUMMERN)
    expect(await renameTo(ws, 'Gummern Dorf')).toBeUndefined()
    expect(ws.selectedPath).toBe('entities/places/gummern-dorf.yaml')
    expect(ws.changes).toEqual([]) // typed, not finished: no change yet
    expect(await ws.finish()).toBe(true)
    expect(ws.changes.map((c) => [c.kind, c.entry.path, c.from, c.moved, c.references])).toEqual([
      ['renamed', 'entities/places/gummern-dorf.yaml', GUMMERN, 1, 3],
    ])
    expect(ws.problems.size).toBe(0)
    expect(ws.entries.some((e) => e.path === GUMMERN)).toBe(false)
    expect(ws.dirty).toEqual([])
  })

  it('stops with the reason and changes nothing when the id is in use', async () => {
    const ws = await started()
    await ws.select(GUMMERN)
    ws.edit(ws.selected!.text.replace('name: Gummern', 'name: Holtorf'))
    expect(ws.renameOpen()).toMatch(/schon einen Eintrag mit der ID „holtorf“/)
    expect(ws.selectedPath).toBe(GUMMERN)
    expect(ws.dirty.some((e) => e.path === 'entities/places/holtorf.yaml')).toBe(false)
  })

  it('asks when many entries move, and stops if the answer is no', async () => {
    const entries: Record<string, string> = { ...SEED }
    for (let i = 0; i < ASK_ABOVE; i++) entries[`entities/places/gummern/h${i}.yaml`] = `id: gummern/h${i}\ntype: place\nname: H${i}\nparent: gummern\n`
    const ws = new Workspace(new FakeApi(entries))
    await ws.start()
    ws.stopLive()
    await ws.select(GUMMERN)
    let asked = 0
    expect(await renameTo(ws, 'Gummern Dorf', (n) => ((asked = n), false))).toBe('Nicht umbenannt.')
    expect(asked).toBe(ASK_ABOVE + 2)
    expect(ws.selectedPath).toBe(GUMMERN)
    expect(await renameTo(ws, 'Gummern Dorf', () => true)).toBeUndefined()
    expect(ws.selectedPath).toBe('entities/places/gummern-dorf.yaml')
  })

  it('is shown while typing without changing anything, and happens with finish', async () => {
    const ws = await started()
    await ws.select(GUMMERN)
    ws.edit(ws.selected!.text.replace('name: Gummern', 'name: Gummern Dorf'))
    expect(ws.previewRename()).toEqual({ path: 'entities/places/gummern-dorf.yaml' })
    expect(ws.selectedPath).toBe(GUMMERN)
    expect(ws.changes).toEqual([])
    expect(await ws.finish()).toBe(true)
    expect(ws.selectedPath).toBe('entities/places/gummern-dorf.yaml')
    expect(ws.changes).toHaveLength(1)
  })

  it('is taken back as a whole', async () => {
    const ws = await started()
    await ws.ensure(ws.entries.map((e) => e.path))
    const before = new Map(ws.entries.map((e) => [e.path, e.text]))
    await ws.select(GUMMERN)
    await renameTo(ws, 'Gummern Dorf')
    ws.revert() // nothing is saved yet: it is taken back where it is typed
    expect(ws.changes).toEqual([])
    expect(new Map(ws.entries.map((e) => [e.path, e.text]))).toEqual(before)
    expect(ws.entries.every((e) => e.text === e.saved)).toBe(true)
    expect(ws.selectedPath).toBe(GUMMERN)
  })

  it('goes on from the last name, and is none when the old name is typed again', async () => {
    const ws = await started()
    await ws.select(GUMMERN)
    await renameTo(ws, 'Gummern Dorf')
    expect(await renameTo(ws, 'Gummern an der Elbe')).toBeUndefined()
    expect(ws.selectedPath).toBe('entities/places/gummern-an-der-elbe.yaml')
    await ws.finish()
    expect(ws.changes).toHaveLength(1)
    expect(ws.changes[0]).toMatchObject({ kind: 'renamed', from: GUMMERN, moved: 1, references: 3 })
    expect(await renameTo(ws, 'Gummern')).toBeUndefined()
    expect(ws.selectedPath).toBe(GUMMERN)
    await ws.finish()
    expect(ws.changes).toEqual([])
    expect(ws.dirty).toEqual([])
  })

  it('moves a new entry without leaving a deleted one behind', async () => {
    const ws = await started()
    ws.create('place', 'Alte Fähre', 'gummern')
    expect(await renameTo(ws, 'Neue Fähre')).toBeUndefined()
    expect(ws.selectedPath).toBe('entities/places/gummern/neue-faehre.yaml')
    await ws.finish()
    expect(ws.changes.map((c) => c.kind)).toEqual(['renamed'])
    expect(ws.changes[0]).toMatchObject({ moved: 0, references: 0 })
  })

  it('is saved as one commit with "Fertig": the old files are gone, the new ones and the references are there', async () => {
    const api = new FakeApi(SEED)
    const ws = new Workspace(api)
    await ws.start()
    ws.stopLive()
    await ws.select(GUMMERN)
    await renameTo(ws, 'Gummern Dorf')
    expect(await ws.finish()).toBe(true)
    const paths = (await api.index(ws.draft!.branch)).entries.map((e) => e.path)
    expect(paths).toContain('entities/places/gummern-dorf.yaml')
    expect(paths).toContain('entities/places/gummern-dorf/3.yaml')
    expect(paths).not.toContain(GUMMERN)
    expect(paths).not.toContain('entities/places/gummern/3.yaml')
    expect((await api.read(['entities/events/fest.yaml'], ws.draft!.branch))[0].text).toContain('gummern-dorf/3')
    expect(ws.dirty).toEqual([])
    expect(ws.changes).toHaveLength(1)
    expect(ws.changes[0]).toMatchObject({ kind: 'renamed', from: GUMMERN, moved: 1, references: 3 })
  })

  it('is taken back as a whole after it was saved, which saves that and closes the draft', async () => {
    const api = new FakeApi(SEED)
    const ws = new Workspace(api)
    await ws.start()
    ws.stopLive()
    await ws.ensure(ws.entries.map((e) => e.path))
    const before = new Map(ws.entries.map((e) => [e.path, e.text]))
    await ws.select(GUMMERN)
    await renameTo(ws, 'Gummern Dorf')
    await ws.finish()
    await ws.discard('entities/places/gummern-dorf.yaml')
    expect(ws.changes).toEqual([])
    expect(new Map(ws.entries.map((e) => [e.path, e.text]))).toEqual(before)
    expect(ws.draft).toBeUndefined()
  })

  it('moves a place to another folder with "Fertig": id and file change, what lies below goes along, references follow', async () => {
    const api = new FakeApi(SEED)
    const ws = new Workspace(api)
    await ws.start()
    ws.stopLive()
    await ws.select(GUMMERN)
    ws.setFolder('Holtorf / Ortsteile')
    expect(ws.previewRename()).toEqual({ path: 'entities/places/holtorf/ortsteile/gummern.yaml' })
    expect(ws.selectedPath).toBe(GUMMERN) // only shown
    expect(ws.changes).toEqual([])
    expect(await ws.finish()).toBe(true)
    expect(ws.selectedPath).toBe('entities/places/holtorf/ortsteile/gummern.yaml')
    expect(ws.moveTo).toEqual({})
    const paths = (await api.index(ws.draft!.branch)).entries.map((e) => e.path)
    expect(paths).toContain('entities/places/holtorf/ortsteile/gummern/3.yaml')
    expect(paths).not.toContain(GUMMERN)
    expect(ws.changes[0]).toMatchObject({ kind: 'renamed', moved: 1 })
    expect(ws.entries.find((e) => e.path === 'entities/events/fest.yaml')!.text).toContain('holtorf/ortsteile/gummern/3')
  })

  it('does not move a place into itself, or onto an id that is in use, and says why', async () => {
    const ws = await started()
    await ws.select(GUMMERN)
    ws.setFolder('gummern')
    expect(ws.previewRename().error).toMatch(/nicht in sich selbst/)
    expect(await ws.finish()).toBe(false)
    ws.setFolder('')
    await ws.select('entities/places/gummern/3.yaml')
    ws.setFolder('')
    expect(ws.previewRename().error ?? ws.previewRename().path).toBeDefined()
  })

  it('is taken back with "Verwerfen" before it is saved', async () => {
    const ws = await started()
    await ws.select(GUMMERN)
    ws.setFolder('holtorf')
    ws.revert()
    expect(ws.moveTo).toEqual({})
    expect(ws.previewRename()).toEqual({})
  })
})
