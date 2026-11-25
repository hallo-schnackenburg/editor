import { describe, expect, it } from 'vitest'
import { FakeAgent, type Agent, type AgentRequest, type ToolCall } from '../src/agent.js'
import { FakeApi } from '../src/fake.js'
import { Workspace } from '../src/workspace.svelte.js'

const ERIKA = 'entities/people/erika-mustermann.yaml'
const FESTPLATZ = 'entities/places/elbdeich-festplatz.yaml'

/** An assistant that answers each round with what `answer` makes of the request. */
class Rounds implements Agent {
  asked: AgentRequest[] = []
  constructor(private answer: (request: AgentRequest, round: number) => ToolCall[]) {}
  async respond(request: AgentRequest): Promise<ToolCall[]> {
    this.asked.push(request)
    return this.answer(request, this.asked.length - 1)
  }
}

async function started(agent: Agent) {
  const ws = new Workspace(new FakeApi(), agent)
  await ws.start()
  ws.stopLive()
  return ws
}
const confirms = (ws: Workspace) => ws.chat.filter((m) => m.role === 'confirm')
const notes = (ws: Workspace) => ws.chat.filter((m) => m.role === 'status').map((m) => m.text)

describe('looking things up', () => {
  it('answers a search and asks again with the answer, until the assistant says something', async () => {
    const agent = new Rounds((_request, round) => (round === 0 ? [{ id: 'a', tool: 'search', query: 'Erika' }] : [{ tool: 'say', text: 'Gefunden.' }]))
    const ws = await started(agent)
    await ws.send('Wer ist Erika?')
    expect(agent.asked).toHaveLength(2)
    expect(agent.asked[0].trail).toEqual([])
    const [step] = agent.asked[1].trail
    expect(step.calls).toEqual([{ id: 'a', tool: 'search', input: { query: 'Erika' } }])
    expect(step.results[0].id).toBe('a')
    expect(step.results[0].text).toContain('erika-mustermann')
    expect(step.results[0].text).toContain(ERIKA)
    expect(ws.chat.at(-1)).toMatchObject({ role: 'assistant', text: 'Gefunden.' })
    expect(ws.thinking).toBe(false)
  })

  it('says so when nothing is found, and gives ids to calls that have none', async () => {
    const agent = new Rounds((_r, round) => (round === 0 ? [{ tool: 'search', query: 'gibtesnicht' }] : [{ tool: 'say', text: 'Nichts.' }]))
    const ws = await started(agent)
    await ws.send('Suche')
    expect(agent.asked[1].trail[0].results[0]).toEqual({ id: 'call_0_0', text: 'Nichts gefunden.' })
  })

  it('reads an entry by id or path, and says when it is not clear or not there', async () => {
    const agent = new Rounds((_r, round) =>
      round === 0 ? [{ id: '1', tool: 'read_entry', entry: 'erika-mustermann' }, { id: '2', tool: 'read_entry', entry: FESTPLATZ }, { id: '3', tool: 'read_entry', entry: 'nope' }] : [{ tool: 'say', text: 'ok' }],
    )
    const ws = await started(agent)
    await ws.send('Lies')
    const results = agent.asked[1].trail[0].results
    expect(results[0].text).toContain('Mustermann')
    expect(results[1].text).toContain('Festplatz')
    expect(results[2].text).toBe('Einen Eintrag „nope“ gibt es nicht.')
  })

  it('opens an entry and shows its form', async () => {
    const agent = new Rounds((_r, round) => (round === 0 ? [{ tool: 'open_entry', entry: 'erika-mustermann' }] : [{ tool: 'say', text: 'Offen.' }]))
    const ws = await started(agent)
    await ws.send('Öffne Erika')
    expect(ws.selectedPath).toBe(ERIKA)
    expect(ws.openForm).toBe(ERIKA)
    expect(agent.asked[1].entry?.path).toBe(ERIKA) // the next round sees the open entry
    expect(agent.asked[1].trail[0].results[0].text).toContain('Mustermann')
  })

  it('reads a submission of somebody else without changing the screen', async () => {
    const agent = new Rounds((_r, round) => (round === 0 ? [{ tool: 'read_submission', number: 1 }, { tool: 'read_submission', number: 99 }] : [{ tool: 'say', text: 'ok' }]))
    const ws = await started(agent)
    await ws.send('Was macht #1?')
    const [one, missing] = agent.asked[1].trail[0].results
    expect(one.text).toContain('„Feuerwehr Texte“ von bernd')
    expect(one.text).toContain('Einträge')
    expect(missing.text).toBe('Die Einreichung #99 gibt es nicht.')
    expect(ws.review.selected).toBeUndefined()
  })

  it('looks at a submission read only, and comes back', async () => {
    const agent = new Rounds((_r, round) => {
      if (round === 0) return [{ tool: 'open_submission', number: 1 }]
      if (round === 1) return [{ tool: 'show_own_work' }]
      return [{ tool: 'say', text: 'Zurück.' }]
    })
    const ws = await started(agent)
    await ws.send('Zeig mir #1 und dann wieder meins')
    expect(agent.asked[1].app.viewing).toBe('Feuerwehr Texte')
    expect(agent.asked[2].app.viewing).toBeNull()
    expect(ws.branch).toBeUndefined()
  })

  it('stops after a few rounds', async () => {
    const agent = new Rounds(() => [{ tool: 'search', query: 'a' }])
    const ws = await started(agent)
    await ws.send('Endlos')
    expect(agent.asked).toHaveLength(8)
    expect(notes(ws).at(-1)).toMatch(/zu viel Hin und Her/)
    expect(ws.thinking).toBe(false)
  })

  it('tells the assistant about the app', async () => {
    const agent = new Rounds(() => [{ tool: 'say', text: 'Hi' }])
    const ws = await started(agent)
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.send('Hallo')
    const { app } = agent.asked[0]
    expect(app.unsaved).toEqual([ERIKA])
    expect(app.viewing).toBeNull()
    expect(app.submissions.map((s) => s.number)).toContain(1)
  })
})

describe('what asks first', () => {
  it('saves only when the person presses the button', async () => {
    const agent = new Rounds(() => [{ tool: 'save' }])
    const ws = await started(agent)
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.send('Speichere')
    const [question] = confirms(ws)
    expect(question.pending).toMatchObject({ label: 'Fertig', state: 'open' })
    expect(ws.dirty).toHaveLength(1)
    await ws.confirm(question)
    expect(question.pending!.state).toBe('done')
    expect(ws.dirty).toHaveLength(0)
    expect(notes(ws).at(-1)).toBe('Gespeichert.')
    expect(ws.changes.length).toBeGreaterThan(0)
  })

  it('does nothing when the person does not want it, and a button works once', async () => {
    const agent = new Rounds(() => [{ tool: 'delete_entry', entry: 'erika-mustermann' }])
    const ws = await started(agent)
    await ws.send('Lösche Erika')
    const [question] = confirms(ws)
    expect(question.text).toContain('Erika')
    ws.dismiss(question)
    await ws.confirm(question)
    expect(question.pending!.state).toBe('dismissed')
    expect(ws.entries.some((e) => e.path === ERIKA)).toBe(true)
  })

  it('deletes an entry after the yes', async () => {
    const agent = new Rounds(() => [{ tool: 'delete_entry', entry: 'erika-mustermann' }])
    const ws = await started(agent)
    await ws.send('Lösche Erika')
    await ws.confirm(confirms(ws)[0])
    expect(ws.entries.some((e) => e.path === ERIKA)).toBe(false)
    expect(ws.changes.some((c) => c.kind === 'removed')).toBe(true)
  })

  it('renames an entry and tells what moves, but changes nothing before the yes', async () => {
    const agent = new Rounds(() => [{ tool: 'rename_entry', entry: 'erika-mustermann', name: 'Erika Beispiel' }])
    const ws = await started(agent)
    await ws.send('Benenne Erika um')
    const [question] = confirms(ws)
    expect(question.text).toContain('„Erika Beispiel“')
    expect(question.text).toContain('erika-beispiel')
    expect(ws.entries.some((e) => e.path === ERIKA)).toBe(true)
    await ws.confirm(question)
    expect(ws.entries.some((e) => e.path === ERIKA)).toBe(false)
    expect(ws.entries.some((e) => e.path.endsWith('erika-beispiel.yaml'))).toBe(true)
  })

  it('submits the draft', async () => {
    const ws = await started(new Rounds(() => [{ tool: 'submit_draft' }]))
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.send('Reich es ein')
    const [question] = confirms(ws)
    expect(question.pending!.label).toBe('Vorschlagen')
    await ws.confirm(question)
    expect(ws.submissions.some((s) => s.state === 'submitted' && s.author === ws.user!.login)).toBe(true)
  })

  it('says there is nothing to submit or save', async () => {
    const ws = await started(new Rounds((_r, round) => (round === 0 ? [{ id: 'x', tool: 'save' }, { id: 'y', tool: 'submit_draft' }] : [{ tool: 'say', text: 'ok' }])))
    await ws.send('Alles')
    expect(confirms(ws)).toHaveLength(0)
    expect(notes(ws)).toEqual(['Es gibt nichts zu speichern.', 'Es gibt keine Einreichung im Entwurf, die sich vorschlagen ließe.'])
  })

  it('accepts a submission of somebody else after the yes', async () => {
    const ws = await started(new Rounds(() => [{ tool: 'accept_submission', number: 1 }]))
    await ws.send('Nimm #1 an')
    const [question] = confirms(ws)
    expect(question.text).toContain('Feuerwehr Texte')
    expect(ws.submissions.find((s) => s.number === 1)!.state).toBe('submitted')
    await ws.confirm(question)
    expect(ws.submissions.find((s) => s.number === 1)!.state).toBe('merged')
    expect(notes(ws).at(-1)).toBe('Einreichung #1 angenommen.')
  })

  it('closes and comments only after the yes', async () => {
    const ws = await started(new Rounds((_r, round) => (round === 0 ? [{ tool: 'comment_submission', number: 1, text: 'Danke!' }, { tool: 'close_submission', number: 1 }] : [])))
    await ws.send('Kommentiere und schließ')
    const [comment, close] = confirms(ws)
    expect(comment.text).toContain('Danke!')
    await ws.confirm(comment)
    expect((await ws.review.peek(1)).comments.some((c) => c.body === 'Danke!')).toBe(true)
    await ws.confirm(close)
    expect(ws.submissions.find((s) => s.number === 1)!.state).toBe('closed')
  })

  it('works in the submission of somebody else, and may review it', async () => {
    const ws = await started(new Rounds((_r, round) => (round === 0 ? [{ tool: 'open_submission', number: 1 }] : round === 1 ? [{ tool: 'accept_submission', number: 1 }] : [])))
    await ws.send('Schau #1 an')
    expect(ws.branch).toBe('submission/bernd/feuerwehr-texte')
    expect(ws.editable).toBe(true)
    expect(confirms(ws).map((m) => m.pending!.label)).toEqual(['Annehmen'])
  })

  it('does not switch while there is something unsaved: the person is asked first', async () => {
    const ws = await started(new Rounds((_r, round) => (round === 0 ? [{ tool: 'open_submission', number: 1 }] : [])))
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# open\n')
    await ws.send('Schau #1 an')
    expect(ws.branch).toBeUndefined()
    expect(ws.switching).toEqual({ branch: 'submission/bernd/feuerwehr-texte' })
  })
})

describe('the stand-in', () => {
  it('opens an entry by its name, and asks when several fit', async () => {
    const ws = await started(new FakeAgent(0))
    await ws.send('öffne Erika')
    expect(ws.selectedPath).toBe(ERIKA)
    await ws.send('öffne xyz')
    expect(notes(ws).length + ws.chat.filter((m) => m.role === 'assistant').length).toBeGreaterThan(0)
    await ws.send('speichern')
    expect(ws.chat.at(-1)?.role).toBe('status') // nothing to save
  })
})
