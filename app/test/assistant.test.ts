import { describe, expect, it } from 'vitest'
import type { Agent, AssistAnswer, AssistRequest } from '../src/agent.js'
import { Assistant } from '../src/assistant.svelte.js'
import { makeEntry, withText, type Entry } from '../src/logic.js'

const place = makeEntry('entities/places/schnackenburg.yaml', 'id: schnackenburg\ntype: place\nname: Schnackenburg\nkind: locality\n', 'sha')
const org = (extra = '') => makeEntry('entities/organizations/feuerwehr.yaml', `id: feuerwehr\ntype: organization\nname: Freiwillige Feuerwehr Schnackenburg\n${extra}`, 'sha')

/** The little of a workspace the helper needs: the open entry, all entries, and the text of the open entry replaced. */
function stand(entry: Entry, answers: (request: AssistRequest) => AssistAnswer) {
  const state = { entries: [entry, place], editable: true, requests: [] as AssistRequest[], folders: [] as string[] }
  const ws = {
    get entries() { return state.entries },
    get selected() { return state.entries[0] },
    get editable() { return state.editable },
    setFolder: (folder: string) => { state.folders.push(folder) },
    edit: (text: string) => { state.entries = [withText(state.entries[0], text), place] },
  }
  const agent: Agent = { respond: async () => [], assist: async (request) => { state.requests.push(request); return answers(request) } }
  const assistant = new Assistant(ws as never, agent, 0)
  return { state, ws, assistant }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('the helper', () => {
  it('enters what comes back into empty fields and marks them', async () => {
    const { ws, assistant } = stand(org(), (r) => (r.stage === 'fields' ? { fields: { places: ['schnackenburg'] } } : { fields: {} }))
    assistant.nudge(ws.selected.path)
    await settle()
    expect(ws.selected.data?.places).toEqual(['schnackenburg'])
    expect(Object.keys(assistant.filled[ws.selected.path])).toEqual(['places'])
  })

  it('asks only for fields that are empty and not the name, and never for texts or addresses', async () => {
    const { state, ws, assistant } = stand(org('places: [schnackenburg]\n'), () => ({ fields: {} }))
    assistant.nudge(ws.selected.path)
    await settle()
    const open = state.requests[0].open
    expect(open).not.toContain('places')
    expect(open).not.toContain('name')
    expect(open).not.toContain('description')
  })

  it('leaves a field alone that the person touched, also when it is empty again', async () => {
    const { ws, assistant } = stand(org(), () => ({ fields: { places: ['schnackenburg'] } }))
    assistant.touch(ws.selected.path, 'places')
    assistant.nudge(ws.selected.path)
    await settle()
    expect(ws.selected.data?.places).toBeUndefined()
  })

  it('does not overwrite what was typed while the answer was on its way', async () => {
    const holder: { ws?: { edit(text: string): void; selected: Entry } } = {}
    const { ws, assistant } = stand(org(), () => {
      holder.ws!.edit(holder.ws!.selected.text + 'places: [gummern]\n')
      return { fields: { places: ['schnackenburg'] } }
    })
    holder.ws = ws
    assistant.nudge(ws.selected.path)
    await settle()
    expect(ws.selected.data?.places).toEqual(['gummern'])
  })

  it('takes back what it entered, and the field is the person\'s from then on', async () => {
    const { ws, assistant } = stand(org(), () => ({ fields: { places: ['schnackenburg'] } }))
    assistant.nudge(ws.selected.path)
    await settle()
    assistant.undo(ws.selected.path, 'places')
    expect(ws.selected.data?.places).toBeUndefined()
    expect(assistant.filled[ws.selected.path]?.places).toBeUndefined()
    assistant.nudge(ws.selected.path)
    await settle()
    expect(ws.selected.data?.places).toBeUndefined()
  })

  it('does not ask for a name that is too short, nor when nothing changed since the last question', async () => {
    const short = stand(makeEntry('entities/organizations/x.yaml', 'id: x\ntype: organization\nname: Ab\n', 'sha'), () => ({ fields: {} }))
    short.assistant.nudge(short.ws.selected.path)
    await settle()
    expect(short.state.requests).toHaveLength(0)
    const same = stand(org(), () => ({ fields: {} }))
    same.assistant.nudge(same.ws.selected.path)
    await settle()
    same.assistant.nudge(same.ws.selected.path)
    await settle()
    expect(same.state.requests.filter((r) => r.stage === 'fields')).toHaveLength(1)
  })

  it('keeps the source of a value that comes from the map', async () => {
    const entry = makeEntry('entities/places/gummern/3.yaml', 'id: gummern/3\ntype: place\nname: Gummern 3\nkind: building\nparent: schnackenburg\n', 'sha')
    const { ws, assistant } = stand(entry, (r) => (r.stage === 'location' ? { fields: { location: { lat: 52.98, lon: 11.57 } }, source: { location: 'OpenStreetMap: x' } } : { fields: {} }))
    assistant.nudge(ws.selected.path)
    await settle()
    expect(ws.selected.data?.location).toEqual({ lat: 52.98, lon: 11.57 })
    expect(assistant.filled[ws.selected.path].location.source).toBe('OpenStreetMap: x')
  })
})

describe('the helper and the folder', () => {
  it('moves a place it put somewhere into the folder of its parent', async () => {
    const entry = makeEntry('entities/places/fischerhaus.yaml', 'id: fischerhaus\ntype: place\nname: Fischerhaus\nkind: building\n', 'sha')
    const { state, ws, assistant } = stand(entry, (r) => (r.stage === 'fields' ? { fields: { parent: 'schnackenburg' } } : { fields: {} }))
    assistant.nudge(ws.selected.path)
    await settle()
    expect(ws.selected.data?.parent).toBe('schnackenburg')
    expect(state.folders).toEqual(['schnackenburg'])
  })
})
