import { describe, expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { Workspace } from '../src/workspace.svelte.js'

const OSTERFEUER = 'entities/events/osterfeuer.yaml'

async function started() {
  const ws = new Workspace(new FakeApi())
  await ws.start()
  ws.stopLive()
  return ws
}

describe('deleting an entry', () => {
  it('takes the references to it out of the others, and taking it back brings them back', async () => {
    const ws = await started()
    const before = ws.referencesTo(OSTERFEUER)
    expect(before).toBeGreaterThan(0)
    await ws.select(OSTERFEUER)
    await ws.remove()
    expect(ws.entries.some((e) => JSON.stringify(e.data).includes('"osterfeuer"'))).toBe(false)
    expect(ws.changes.filter((c) => c.kind === 'changed').length).toBe(before)
    await ws.discard(OSTERFEUER)
    expect(ws.changes).toEqual([])
  })
})

describe('saving an entry whose id does not come from its name', () => {
  const FESTPLATZ = 'entities/places/elbdeich-festplatz.yaml' // named "Festplatz am Elbdeich"

  it('keeps the id when something else was changed', async () => {
    const ws = await started()
    await ws.select(FESTPLATZ)
    ws.edit(ws.selected!.text + 'description: Neu.\n')
    expect(ws.previewRename().path).toBeUndefined()
    expect(await ws.finish()).toBe(true)
    expect(ws.entries.some((e) => e.path === FESTPLATZ)).toBe(true)
    expect(ws.changes.map((c) => c.kind)).toEqual(['changed'])
  })

  it('follows the name once the name is changed', async () => {
    const ws = await started()
    await ws.select(FESTPLATZ)
    ws.edit(ws.selected!.text.replace('Festplatz am Elbdeich', 'Festplatz Elbdeich'))
    expect(await ws.finish()).toBe(true)
    expect(ws.entries.some((e) => e.path.endsWith('festplatz-elbdeich.yaml'))).toBe(true)
  })
})

describe('proposing', () => {
  it('shows the submission that was proposed, and it stays the one that is worked on', async () => {
    const ws = await started()
    await ws.select('entities/people/erika-mustermann.yaml')
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.finish()
    const number = ws.draft!.number
    expect(await ws.submit()).toBe(true)
    expect(ws.review.selected).toBe(number)
    expect(ws.review.detailOpen).toBe(true)
    expect(ws.active).toMatchObject({ number, state: 'submitted' })
  })
})
