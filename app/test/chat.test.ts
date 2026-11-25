import { describe, expect, it } from 'vitest'
import { FakeAgent, type Agent, type AgentRequest, type ToolCall } from '../src/agent.js'
import { SignedOut } from '../src/api.js'
import { FakeApi } from '../src/fake.js'
import { Workspace } from '../src/workspace.svelte.js'

const ERIKA = 'entities/people/erika-mustermann.yaml'
const FESTPLATZ = 'entities/places/elbdeich-festplatz.yaml'
const TRADITION = 'contents/traditionen/osterfeuer-tradition.yaml'

/** An assistant that answers with the calls it is given, and writes down what it was asked. */
class Scripted implements Agent {
  asked: AgentRequest[] = []
  constructor(public calls: ToolCall[] | (() => ToolCall[])) {}
  async respond(request: AgentRequest): Promise<ToolCall[]> {
    this.asked.push(request)
    return typeof this.calls === 'function' ? this.calls() : this.calls
  }
}

async function started(agent?: Agent) {
  const ws = new Workspace(new FakeApi(), agent)
  await ws.start()
  ws.stopLive()
  return ws
}
const texts = (ws: Workspace) => ws.chat.map((m) => `${m.role}: ${m.text}`)

describe('what the assistant is told', () => {
  it('gets the open entry as it is typed now, the entities with id and name, and the conversation without the notes of the app', async () => {
    const agent = new Scripted([{ tool: 'say', text: 'Hallo!' }])
    const ws = await started(agent)
    ws.select(ERIKA)
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.send('Hi')
    await ws.send('Und weiter?')
    const [first, second] = agent.asked
    expect(first.entry).toMatchObject({ path: ERIKA, id: 'erika-mustermann' })
    expect(first.entry!.text).toContain('Erika M.')
    expect(first.history).toEqual([])
    expect(first.index).toContainEqual({ id: 'feuerwehrhaus', type: 'place', name: 'Feuerwehrhaus Schnackenburg' })
    // only entities: no contents, no objects
    expect(first.index.every((e) => ['person', 'organization', 'place', 'event', 'thing'].includes(e.type))).toBe(true)
    expect(first.index.some((e) => e.id === 'osterfeuer-tradition')).toBe(false)
    expect(second.history).toEqual([{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hallo!' }])
  })

  it('is told that nothing is open, when nothing is', async () => {
    const agent = new Scripted([{ tool: 'say', text: 'Ok' }])
    const ws = await started(agent)
    await ws.send('Hallo')
    expect(agent.asked[0].entry).toBeNull()
  })

  it('does not send an empty message, nor while it is working', async () => {
    const agent = new Scripted([{ tool: 'say', text: 'Ok' }])
    const ws = await started(agent)
    await ws.send('   ')
    const first = ws.send('Eins')
    expect(ws.thinking).toBe(true)
    await ws.send('Zwei')
    await first
    expect(agent.asked).toHaveLength(1)
    expect(texts(ws)).toEqual(['user: Eins', 'assistant: Ok'])
    expect(ws.thinking).toBe(false)
  })
})

describe('changing a field', () => {
  it('sets it as an unsaved change of the open entry and asks for its form to be opened; nothing is saved', async () => {
    const ws = await started(new Scripted([{ tool: 'patch', field: 'description', value: 'Die Chronistin.' }]))
    ws.select(ERIKA)
    await ws.send('Beschreibe sie')
    expect(ws.selected!.text).toContain('description: Die Chronistin.')
    expect(ws.dirty.map((e) => e.path)).toEqual([ERIKA])
    expect(ws.changes).toEqual([])
    expect(ws.openForm).toBe(ERIKA)
    expect(texts(ws)).toEqual(['user: Beschreibe sie', 'status: Beschreibung geändert.'])
  })

  it('sets the dates and the rule of an event, and refuses ones that make no sense', async () => {
    const ws = await started(
      new Scripted([
        { tool: 'patch', field: 'dates', value: [{ start: '2026-11-28T17:00', note: 'Markt' }], old: [{ start: '2026-04-04T20:00', note: 'Beginn bei Einbruch der Dunkelheit' }] },
        { tool: 'patch', field: 'rule', value: { rrule: 'FREQ=YEARLY;BYADVENT=-1', start: '2024-01-01' }, old: { rrule: 'FREQ=YEARLY;BYEASTER=-1', start: '2020-04-11T20:00' } },
        { tool: 'patch', field: 'rule', value: { rrule: 'FREQ=MONTHLY;BYADVENT=-1', start: '2024-01-01' } },
        { tool: 'patch', field: 'dates', value: [{ start: 'bald' }] },
      ]),
    )
    ws.select('entities/events/osterfeuer.yaml')
    await ws.send('Trag die Termine ein')
    const text = ws.selected!.text
    expect(text).toContain('2026-11-28T17:00')
    expect(text).toContain('BYADVENT=-1')
    expect(texts(ws).join('\n')).toContain('Regel: Die Regel stimmt nicht')
    expect(texts(ws).join('\n')).toContain('Termine: Jeder Termin braucht einen Beginn')
  })

  it('changes the entry that was open when the message was sent, also if another is open when the answer comes', async () => {
    let ws!: Workspace
    const agent = new Scripted(() => {
      ws.select(FESTPLATZ)
      return [{ tool: 'patch', field: 'description', value: 'Beschreibung.' }]
    })
    ws = await started(agent)
    ws.select(ERIKA)
    await ws.send('x')
    expect(ws.entries.find((e) => e.path === ERIKA)!.text).toContain('description: Beschreibung.')
    expect(ws.entries.find((e) => e.path === FESTPLATZ)!.text).not.toContain('Beschreibung.')
  })

  it('leaves a field alone that the person changed since the assistant saw it', async () => {
    const ws = await started(new Scripted([{ tool: 'patch', field: 'address', value: 'Neu 1', old: 'Alt 2' }]))
    ws.select('entities/places/feuerwehrhaus.yaml')
    await ws.send('Adresse')
    expect(ws.selected!.text).toContain('Am Markt 3')
    expect(ws.dirty).toEqual([])
    expect(ws.openForm).toBeUndefined()
    expect(texts(ws)[1]).toMatch(/^status: Adresse: Das hast du inzwischen geändert/)
  })

  it('removes a field when the value is empty', async () => {
    const ws = await started(new Scripted([{ tool: 'patch', field: 'address', value: '', old: 'Am Markt 3, 29493 Schnackenburg' }]))
    ws.select('entities/places/feuerwehrhaus.yaml')
    await ws.send('Adresse weg')
    expect(ws.selected!.text).not.toContain('address')
    expect(texts(ws)[1]).toBe('status: Adresse entfernt.')
  })

  it('does not rename: name, id and type are the person\'s', async () => {
    const ws = await started(
      new Scripted([
        { tool: 'patch', field: 'name', value: 'Anders' },
        { tool: 'patch', field: 'id', value: 'anders' },
        { tool: 'patch', field: 'type', value: 'place' },
      ]),
    )
    ws.select(ERIKA)
    await ws.send('Umbenennen')
    expect(ws.dirty).toEqual([])
    const notes = texts(ws).slice(1)
    expect(notes).toHaveLength(3)
    expect(notes[0]).toMatch(/^status: „Name“ ändert man mit „Umbenennen“/)
    expect(notes[1]).toMatch(/^status: „ID“ ändert man mit „Umbenennen“/)
    expect(notes[2]).toMatch(/^status: „Typ“ ändert man mit „Umbenennen“/)
  })

  it('refuses a field the type does not have, a choice that is none, a reference that is not there, and a wrong kind of value', async () => {
    const ws = await started(
      new Scripted([
        { tool: 'patch', field: 'published', value: '2026-01-01' }, // a person has no such field
        { tool: 'patch', field: 'kind', value: 'galaxy' },
        { tool: 'patch', field: 'parent', value: 'nirgendwo' },
        { tool: 'patch', field: 'address', value: ['a', 'b'] },
        { tool: 'patch', field: 'links', value: [{ label: 'Ohne Adresse' }] },
      ]),
    )
    ws.select(FESTPLATZ)
    await ws.send('Mach was')
    expect(ws.dirty).toEqual([])
    const notes = texts(ws).slice(1)
    expect(notes[0]).toBe('status: Das Feld „published“ gibt es bei Ort nicht.')
    expect(notes[1]).toContain('„galaxy“ ist keine Möglichkeit')
    expect(notes[2]).toBe('status: Teil von: Den Eintrag „nirgendwo“ gibt es nicht.')
    expect(notes[3]).toBe('status: Adresse: Text erwartet.')
    expect(notes[4]).toContain('Jeder Link braucht')
  })

  it('sets references to ids that exist, a single one also given as a list', async () => {
    const ws = await started(new Scripted([{ tool: 'patch', field: 'parent', value: ['feuerwehrhaus'] }, { tool: 'patch', field: 'kind', value: 'building' }]))
    ws.select(FESTPLATZ)
    await ws.send('Gehört zum Feuerwehrhaus')
    expect(ws.selected!.data).toMatchObject({ parent: 'feuerwehrhaus', kind: 'building' })
  })

  it('needs an open entry', async () => {
    const ws = await started(new Scripted([{ tool: 'patch', field: 'description', value: 'x' }]))
    await ws.send('Beschreibe')
    expect(texts(ws)[1]).toBe('status: Dafür muss ein Eintrag geöffnet sein.')
  })
})

describe('setting a text', () => {
  it('sets one role of a content, and only of one that has texts', async () => {
    const ws = await started(new Scripted([{ tool: 'set_text', role: 'social', value: 'Das Osterfeuer brennt!' }]))
    ws.select(TRADITION)
    await ws.send('Schreib einen Post')
    expect(ws.selected!.data!.text).toMatchObject({ social: 'Das Osterfeuer brennt!\n' })
    expect(texts(ws)[1]).toBe('status: Text „Social Media“ geändert.')

    const person = await started(new Scripted([{ tool: 'set_text', role: 'social', value: 'x' }]))
    person.select(ERIKA)
    await person.send('Post')
    expect(person.dirty).toEqual([])
    expect(texts(person)[1]).toBe('status: Person hat keine Texte.')
  })
})

describe('making an entry', () => {
  it('makes it with its fields, opens it, and asks for its form', async () => {
    const ws = await started(new Scripted([{ tool: 'create_entry', type: 'place', name: 'Alte Fähre', folder: 'gummern', fields: { description: 'Hier fuhr die Fähre.', kind: 'other', name: 'Ignoriert' } }]))
    ws.select(ERIKA)
    await ws.send('Lege die Alte Fähre an')
    const entry = ws.selected!
    expect(entry.path).toBe('entities/places/gummern/alte-faehre.yaml')
    expect(entry.data).toMatchObject({ id: 'gummern/alte-faehre', name: 'Alte Fähre', description: 'Hier fuhr die Fähre.', kind: 'other' })
    expect(ws.openForm).toBe(entry.path)
    expect(ws.dirty.map((e) => e.path)).toEqual([entry.path])
    expect(texts(ws)).toEqual(['user: Lege die Alte Fähre an', 'status: Ort „Alte Fähre“ angelegt.', 'status: Beschreibung geändert.', 'status: Typ geändert.'])
  })

  it('marks an entity that is made from a name only as incomplete (a stub), and one with a description not', async () => {
    const ws = await started(new Scripted([{ tool: 'create_entry', type: 'person', name: 'Max Ketterer' }, { tool: 'create_entry', type: 'place', name: 'Leipzig', fields: { description: 'Eine Stadt.' } }]))
    await ws.send('Lege beide an')
    expect(ws.entries.find((e) => e.path === 'entities/people/max-ketterer.yaml')!.data).toMatchObject({ name: 'Max Ketterer', stub: true })
    expect(ws.entries.find((e) => e.path === 'entities/places/leipzig.yaml')!.data?.stub).toBeUndefined()
  })

  it('numbers an id that is in use, and says when it cannot (a content without a topic)', async () => {
    const ws = await started(
      new Scripted([
        { tool: 'create_entry', type: 'place', name: 'Feuerwehrhaus' },
        { tool: 'create_entry', type: 'content', name: 'Ohne Thema' },
      ]),
    )
    await ws.send('Mach zwei')
    expect(ws.entries.some((e) => e.path === 'entities/places/feuerwehrhaus-2.yaml')).toBe(true)
    expect(texts(ws).at(-1)).toContain('Ein Inhalt gehört in ein Thema')
  })
})

describe('when nothing can be changed, or something goes wrong', () => {
  it('says once that nothing can be changed (nobody is signed in), and changes nothing', async () => {
    const ws = await started(new Scripted([{ tool: 'patch', field: 'description', value: 'x' }, { tool: 'patch', field: 'description', value: 'y' }, { tool: 'say', text: 'Schade.' }]))
    ws.select(ERIKA)
    ws.user = null
    await ws.send('Beschreibe')
    expect(ws.dirty).toEqual([])
    expect(texts(ws)).toEqual(['user: Beschreibe', `status: ${ws.readonlyReason}`, 'assistant: Schade.'])
  })

  it('tells what went wrong and stays usable', async () => {
    let fail = true
    const ws = await started(
      new Scripted(() => {
        if (fail) throw new Error('Der Server ist nicht erreichbar.')
        return [{ tool: 'say', text: 'Wieder da.' }]
      }),
    )
    await ws.send('Hallo')
    expect(texts(ws)).toEqual(['user: Hallo', 'status: Das hat nicht geklappt: Der Server ist nicht erreichbar.'])
    expect(ws.thinking).toBe(false)
    fail = false
    await ws.send('Nochmal')
    expect(texts(ws).at(-1)).toBe('assistant: Wieder da.')
  })

  it('signs out when the session is over', async () => {
    const ws = await started(
      new Scripted(() => {
        throw new SignedOut()
      }),
    )
    await ws.send('Hallo')
    expect(ws.user).toBeNull()
    expect(ws.error).toBe('Du bist nicht mehr angemeldet.')
  })

  it('says so when there is no assistant', async () => {
    const ws = await started()
    await ws.send('Hallo')
    expect(texts(ws)).toEqual(['user: Hallo', 'status: Der Chat ist hier nicht eingerichtet.'])
  })

  it('starts afresh', async () => {
    const ws = await started(new Scripted([{ tool: 'say', text: 'Ok' }]))
    await ws.send('Hallo')
    ws.clearChat()
    expect(ws.chat).toEqual([])
  })
})

describe('the stand-in for the demo', () => {
  it('sets the description, and says what it cannot do', async () => {
    const ws = await started(new FakeAgent(0))
    await ws.send('Hallo')
    expect(texts(ws)[1]).toContain('Öffne zuerst einen Eintrag')
    ws.select(ERIKA)
    await ws.send('Beschreibung: Chronistin des Ortes.')
    expect(ws.selected!.text).toContain('description: Chronistin des Ortes.')
    await ws.send('Was kannst du?')
    expect(texts(ws).at(-1)).toContain('Demo-KI')
  })
})
