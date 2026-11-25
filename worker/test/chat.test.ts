import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { BadRequest, SYSTEM_PROMPT, TOOLS, buildModelRequest, parseChatRequest, toToolCalls, type ChatRequest } from '../src/chat.js'
import { env, fakeGitHub, request, signIn } from './support.js'

const TEXT = 'id: gummern/sportplatz\ntype: place\nname: Sportplatz\n'
const base = (): ChatRequest => ({
  message: 'Beschreibe den Sportplatz',
  entry: { path: 'entities/places/gummern/sportplatz.yaml', id: 'gummern/sportplatz', text: TEXT },
  index: [{ id: 'gummern', type: 'place', name: 'Gummern' }],
  app: { viewing: null, draft: null, unsaved: [], changes: 0, submissions: [], files: [] },
  history: [],
  trail: [],
})

describe('the chat request', () => {
  it('accepts what the browser sends, with or without an open entry', () => {
    expect(parseChatRequest(base())).toEqual(base())
    expect(parseChatRequest({ ...base(), entry: null }).entry).toBeNull()
  })

  it('refuses what is too big or the wrong shape', () => {
    const bad = (patch: object) => () => parseChatRequest({ ...base(), ...patch })
    expect(bad({ message: '' })).toThrow(BadRequest)
    expect(bad({ message: 'x'.repeat(4001) })).toThrow(BadRequest)
    expect(bad({ history: Array.from({ length: 31 }, () => ({ role: 'user', text: 'x' })) })).toThrow(BadRequest)
    expect(bad({ history: [{ role: 'system', text: 'x' }] })).toThrow(BadRequest)
    expect(bad({ index: Array.from({ length: 1501 }, () => ({ id: 'a', type: 'place', name: 'A' })) })).toThrow(BadRequest)
    expect(bad({ index: [{ id: 'a' }] })).toThrow(BadRequest)
    expect(bad({ entry: { path: 'a', id: 'a', text: 'x'.repeat(30001) } })).toThrow(BadRequest)
    expect(bad({ app: null })).toThrow(BadRequest)
    expect(bad({ app: { ...base().app, submissions: Array.from({ length: 61 }, () => ({ number: 1, name: 'a', author: 'b', state: 'submitted' })) } })).toThrow(BadRequest)
    expect(bad({ trail: Array.from({ length: 11 }, () => ({ calls: [], results: [] })) })).toThrow(BadRequest)
    expect(bad({ trail: [{ calls: [{ id: 'a b', tool: 'search', input: {} }], results: [] }] })).toThrow(BadRequest) // not a usable id
    expect(bad({ trail: [{ calls: [{ id: 'a', tool: 'hack', input: {} }], results: [] }] })).toThrow(BadRequest) // not a tool
    expect(bad({ trail: [{ calls: [], results: [{ id: 'a' }] }] })).toThrow(BadRequest)
    expect(() => parseChatRequest('nope')).toThrow(BadRequest)
  })
})

describe('what the model is asked', () => {
  it('describes the state of the app', () => {
    const app = {
      viewing: 'Feuerwehr Texte',
      draft: { name: 'Einreichung vom 22.11.2026', state: 'draft' },
      unsaved: ['entities/people/erika.yaml'],
      changes: 3,
      submissions: [{ number: 4, name: 'Fest', author: 'bernd', state: 'submitted' }],
      files: [{ name: 'Brief 1.tif', mime: 'image/tiff', bytes: 20480 }],
    }
    const last = buildModelRequest({ ...base(), app }, 'm').messages.at(-1)!.content as string
    expect(last).toContain('Working in: the submission "Feuerwehr Texte", which somebody else started.')
    expect(last).toContain('Submission worked on: "Einreichung vom 22.11.2026" (draft); 3 entries differ from the database in it.')
    expect(last).toContain('Unsaved: entities/people/erika.yaml.')
    expect(last).toContain('Brief 1.tif (image/tiff, 20 kB)')
    expect(last).toContain('#4 "Fest" by bernd, submitted')
    expect(buildModelRequest(base(), 'm').messages.at(-1)!.content).toContain('Submission worked on: none yet')
  })

  it('puts the rounds of the answer after the question: what it called, and what the app answered', () => {
    const trail = [
      {
        calls: [{ id: 'toolu_1', tool: 'search', input: { query: 'Gasthof' } }, { id: 'toolu_2', tool: 'say', input: { text: 'Moment' } }],
        results: [{ id: 'toolu_1', text: 'place: holtorf/gasthof — Gasthof' }, { id: 'toolu_2', text: 'ok' }],
      },
    ]
    const messages = buildModelRequest({ ...base(), trail }, 'm').messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1].content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'Gasthof' } },
      { type: 'tool_use', id: 'toolu_2', name: 'say', input: { text: 'Moment' } },
    ])
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'place: holtorf/gasthof — Gasthof' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' },
    ])
  })

  it('has every tool the app knows, and says which ones it asks about first', () => {
    const names = TOOLS.map((t) => t.name)
    for (const name of ['search', 'read_entry', 'open_entry', 'patch', 'save', 'delete_entry', 'rename_entry', 'move_entry', 'submit_draft', 'accept_submission', 'close_submission', 'comment_submission', 'say']) expect(names).toContain(name)
    expect(new Set(names).size).toBe(names.length)
    expect(SYSTEM_PROMPT).toContain('asks the person about first')
  })

  it('knows the types, fields and text roles of the model, objects included', () => {
    expect(SYSTEM_PROMPT).toContain('place (Ort, entity)')
    expect(SYSTEM_PROMPT).toContain('description (Beschreibung')
    expect(SYSTEM_PROMPT).toContain('kind (Typ: one of: locality (Ort)')
    expect(SYSTEM_PROMPT).toContain('social (Social Media), at most 2200 characters')
    expect(SYSTEM_PROMPT).toContain('(Objekt, object)')
    const create = TOOLS.find((t) => t.name === 'create_entry')!.input_schema.properties as any
    expect(create.type.enum).toContain('object')
    expect(create.kind.enum).toEqual(['image', 'document', 'audio', 'video', 'group'])
    expect(create.type.enum).toContain('place')
  })

  it('sends the open entry, the entities, the date and the conversation, with alternating turns', () => {
    const now = new Date('2026-11-22T21:00:00Z')
    const model = buildModelRequest({ ...base(), history: [{ role: 'assistant', text: 'Hallo' }, { role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Ja?' }] }, 'm', now)
    expect(model.model).toBe('m')
    expect(model.tool_choice).toEqual({ type: 'any' })
    expect(model).not.toHaveProperty('temperature')
    // the assistant turn at the start is dropped; the last user turn is the context
    expect(model.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const last = model.messages[2].content as string
    expect(last).toContain('Today is 2026-11-22.')
    expect(last).toContain('Open entry (entities/places/gummern/sportplatz.yaml)')
    expect(last).toContain('name: Sportplatz')
    expect(last).toContain('- place: gummern — Gummern')
    expect(last).toContain('Beschreibe den Sportplatz')
  })

  it('says so when no entry is open', () => {
    expect(buildModelRequest({ ...base(), entry: null }, 'm').messages[0].content).toContain('Open entry: (none)')
  })
})

describe('the answer of the model', () => {
  const use = (name: string, input: object) => ({ type: 'tool_use', name, input })

  it('becomes tool calls', () => {
    const calls = toToolCalls({
      content: [
        use('patch', { field: 'description', value: 'Der Sportplatz.', old: undefined }),
        use('set_text', { role: 'social', value: 'Heute!' }),
        use('create_entry', { type: 'place', name: ' Alte Fähre ', folder: 'gummern', fields: { description: 'Fähre' } }),
        use('say', { text: 'Fertig.' }),
        { type: 'text', text: 'Und noch etwas.' },
      ],
    })
    expect(calls).toEqual([
      { tool: 'patch', field: 'description', value: 'Der Sportplatz.', old: undefined },
      { tool: 'set_text', role: 'social', value: 'Heute!' },
      { tool: 'create_entry', type: 'place', name: 'Alte Fähre', folder: 'gummern', fields: { description: 'Fähre' }, kind: undefined, files: undefined },
      { tool: 'say', text: 'Fertig.' },
      { tool: 'say', text: 'Und noch etwas.' },
    ])
  })

  it('drops calls that make no sense, and placeholders', () => {
    const calls = toToolCalls({
      content: [
        use('patch', { value: 'x' }), // no field
        use('patch', { field: 'description', value: 'unbekannt' }),
        use('patch', { field: 'description', value: '<UNKNOWN>' }),
        use('set_text', { role: 'nonsense', value: 'x' }),
        use('create_entry', { type: 'place', name: '?' }),
        use('create_entry', { type: 'place', name: 'Fähre', fields: { description: '?', kind: 'street' } }),
        use('unknown_tool', {}),
      ],
    })
    expect(calls).toEqual([{ tool: 'create_entry', type: 'place', name: 'Fähre', folder: undefined, fields: { kind: 'street' }, kind: undefined, files: undefined }])
  })

  it('makes an object from dropped files, and attaches files to one', () => {
    const calls = toToolCalls({
      content: [
        use('create_entry', { type: 'object', name: 'Brief an Anna', kind: 'document', files: [' Brief 1.tif ', 'Brief 2.tif', 3], fields: { date: '1963-07' } }),
        use('create_entry', { type: 'object', name: 'Foto', kind: 'nonsense' }),
        use('attach_files', { files: ['a.jpg'], entry: 'abc' }),
        use('attach_files', { files: [] }),
      ],
    })
    expect(calls).toEqual([
      { tool: 'create_entry', type: 'object', name: 'Brief an Anna', folder: undefined, fields: { date: '1963-07' }, kind: 'document', files: ['Brief 1.tif', 'Brief 2.tif'] },
      { tool: 'create_entry', type: 'object', name: 'Foto', folder: undefined, fields: undefined, kind: undefined, files: undefined },
      { tool: 'attach_files', files: ['a.jpg'], entry: 'abc' },
    ])
  })

  it('knows the tools that look things up, move around and ask first, with the ids the model gave', () => {
    const calls = toToolCalls({
      content: [
        { ...use('search', { query: ' Gasthof ', type: 'place' }), id: 'a1' },
        { ...use('search', { query: 'x', type: 'nonsense' }), id: 'a2' },
        { ...use('read_entry', { entry: 'holtorf/gasthof' }), id: 'a3' },
        use('list_changes', {}),
        use('read_submission', { number: 4 }),
        use('open_entry', { entry: 'x' }),
        use('open_submission', { number: 4 }),
        use('show_own_work', {}),
        use('rename_draft', { name: 'Fest' }),
        use('save', {}),
        use('discard_unsaved', {}),
        use('take_back', { entry: 'x' }),
        use('delete_entry', {}),
        use('rename_entry', { name: 'Neu' }),
        use('move_entry', { entry: 'a', folder: 'gummern/sonstige' }),
        use('submit_draft', {}),
        use('accept_submission', { number: 4 }),
        use('close_submission', { number: 5 }),
        use('comment_submission', { number: 4, text: 'Danke!' }),
      ],
    })
    expect(calls[0]).toEqual({ tool: 'search', query: 'Gasthof', type: 'place', id: 'a1' })
    expect(calls[1]).toEqual({ tool: 'search', query: 'x', type: undefined, id: 'a2' })
    expect(calls[2]).toEqual({ tool: 'read_entry', entry: 'holtorf/gasthof', id: 'a3' })
    expect(calls.slice(3).map((c) => c.tool)).toEqual(['list_changes', 'read_submission', 'open_entry', 'open_submission', 'show_own_work', 'rename_draft', 'save', 'discard_unsaved', 'take_back', 'delete_entry', 'rename_entry', 'move_entry', 'submit_draft', 'accept_submission', 'close_submission', 'comment_submission'])
    expect(calls.find((c) => c.tool === 'move_entry')).toEqual({ tool: 'move_entry', entry: 'a', folder: 'gummern/sonstige' })
    expect(calls.find((c) => c.tool === 'comment_submission')).toEqual({ tool: 'comment_submission', number: 4, text: 'Danke!' })
  })

  it('drops those whose input makes no sense', () => {
    const calls = toToolCalls({
      content: [
        use('search', { query: '' }),
        use('read_entry', {}),
        use('read_submission', { number: 'vier' }),
        use('accept_submission', {}),
        use('comment_submission', { number: 4 }),
        use('rename_entry', { name: '?' }),
        use('move_entry', {}),
        use('say', { text: '  ' }),
      ],
    })
    expect(calls).toEqual([{ tool: 'say', text: 'Das habe ich nicht verstanden. Magst du es anders sagen?' }])
  })

  it('has an answer even when nothing could be used', () => {
    expect(toToolCalls({ content: [] })).toEqual([{ tool: 'say', text: 'Das habe ich nicht verstanden. Magst du es anders sagen?' }])
    expect(toToolCalls(null)).toHaveLength(1)
  })
})

describe('POST /chat', () => {
  /** GitHub for the sign-in, and a model that answers with `answer` (and writes down what it was asked). */
  async function setup(answer: Response | (() => Response), withKey = true) {
    const gh = fakeGitHub()
    const cookie = await signIn(gh)
    const asked: { url: string; headers: Record<string, string>; body: any }[] = []
    const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).startsWith('https://api.anthropic.com/')) {
        asked.push({ url: String(input), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
        return typeof answer === 'function' ? answer() : answer
      }
      return gh.fn(input, init)
    }) as typeof fetch
    return { cookie, asked, fn, env: { ...env, ...(withKey ? { ANTHROPIC_API_KEY: 'sk-test' } : {}) } }
  }
  const post = (cookie: string | undefined, body: unknown) => request(cookie, '/api/chat', { method: 'POST', body: JSON.stringify(body) })
  const model = (...content: object[]) => new Response(JSON.stringify({ content }), { status: 200 })

  it('is for signed-in people only', async () => {
    const s = await setup(model())
    expect((await handle(post(undefined, base()), s.env, s.fn)).status).toBe(401)
    expect(s.asked).toHaveLength(0)
  })

  it('asks the model with the key and returns the calls', async () => {
    const s = await setup(model({ type: 'tool_use', name: 'patch', input: { field: 'description', value: 'Ein Platz.' } }))
    const response = await handle(post(s.cookie, base()), s.env, s.fn)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ calls: [{ tool: 'patch', field: 'description', value: 'Ein Platz.' }] })
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0].headers['x-api-key']).toBe('sk-test')
    expect(s.asked[0].body.model).toBe('claude-haiku-5-5')
    expect(s.asked[0].body.messages.at(-1).content).toContain('name: Sportplatz')
  })

  it('uses the model of the environment', async () => {
    const s = await setup(model())
    await handle(post(s.cookie, base()), { ...s.env, MODEL: 'claude-sonnet-5-5' }, s.fn)
    expect(s.asked[0].body.model).toBe('claude-sonnet-5-5')
  })

  it('refuses a request that is not right, without asking the model', async () => {
    const s = await setup(model())
    const response = await handle(post(s.cookie, { ...base(), message: '' }), s.env, s.fn)
    expect(response.status).toBe(400)
    expect(s.asked).toHaveLength(0)
    expect((await handle(request(s.cookie, '/api/chat', { method: 'POST', body: 'nope' }), s.env, s.fn)).status).toBe(400)
  })

  it('tells when the server has no key', async () => {
    const s = await setup(model(), false)
    const response = await handle(post(s.cookie, base()), s.env, s.fn)
    expect(response.status).toBe(500)
    expect(((await response.json()) as any).error).toContain('Schlüssel')
  })

  it('passes on what went wrong with the model, without the key', async () => {
    const s = await setup(new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 }))
    const response = await handle(post(s.cookie, base()), s.env, s.fn)
    expect(response.status).toBe(502)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('529')
    expect(text).toContain('overloaded')
    expect(text).not.toContain('sk-test')
  })

  it('says so when the model cannot be reached', async () => {
    const s = await setup(() => {
      throw new Error('down')
    })
    expect((await handle(post(s.cookie, base()), s.env, s.fn)).status).toBe(502)
  })
})

describe('what the Worker looks up itself', () => {
  const lookup = (name: string, input: object) => ({ type: 'tool_use', id: 'toolu_1', name, input })
  const reply = (...content: object[]) => new Response(JSON.stringify({ content }), { status: 200 })

  /** A model that answers from `answers` one after the other, OpenStreetMap with `places`, and the search of the web with `web`. */
  async function setup(answers: Response[], places: () => Response = () => new Response('[]'), web?: () => Response) {
    const gh = fakeGitHub()
    const cookie = await signIn(gh)
    const asked: any[] = []
    const places_: string[] = []
    const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url.startsWith('https://nominatim.openstreetmap.org/')) {
        places_.push(url)
        expect((init.headers as Record<string, string>)['user-agent']).toContain('editor')
        return places()
      }
      if (url.startsWith('https://api.anthropic.com/')) {
        const body = JSON.parse(String(init.body))
        asked.push(body)
        if (body.tools?.[0]?.type === 'web_search_20250305') return web!()
        return answers.shift()!
      }
      return gh.fn(input, init)
    }) as typeof fetch
    const post = () => handle(request(cookie, '/api/chat', { method: 'POST', body: JSON.stringify(base()) }), { ...env, ANTHROPIC_API_KEY: 'sk-test' }, fn)
    return { asked, places: places_, post }
  }

  it('looks coordinates up near Schnackenburg and lets the model go on with them', async () => {
    const s = await setup(
      [reply(lookup('find_coordinates', { query: 'Aussichtsturm Schnackenburg' })), reply({ type: 'tool_use', id: 'toolu_2', name: 'patch', input: { field: 'location', value: { lat: 52.9921, lon: 11.5612 } } })],
      () => new Response(JSON.stringify([{ display_name: 'Aussichtsturm, Schnackenburg', category: 'tourism', type: 'viewpoint', lat: '52.9921', lon: '11.5612' }])),
    )
    const response = await s.post()
    expect(await response.json()).toEqual({ calls: [{ tool: 'patch', field: 'location', value: { lat: 52.9921, lon: 11.5612 }, id: 'toolu_2' }] })
    expect(s.places).toHaveLength(1)
    expect(s.places[0]).toContain('bounded=1')
    expect(s.places[0]).toContain('Aussichtsturm+Schnackenburg')
    // The second round has what was found.
    const second = s.asked[1].messages.slice(-2)
    expect(second[0]).toEqual({ role: 'assistant', content: [lookup('find_coordinates', { query: 'Aussichtsturm Schnackenburg' })] })
    expect(second[1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(second[1].content[0].content).toContain('lat 52.9921, lon 11.5612')
  })

  it('searches everywhere when asked to, and tells when nothing was found', async () => {
    const s = await setup([reply(lookup('find_coordinates', { query: 'Eiffelturm', anywhere: true })), reply({ type: 'text', text: 'Ich finde nichts.' })])
    await s.post()
    expect(s.places[0]).not.toContain('bounded')
    expect(s.asked[1].messages.at(-1).content[0].content).toContain('Nothing found')
  })

  it('goes on when the place search is down', async () => {
    const s = await setup([reply(lookup('find_coordinates', { query: 'x' })), reply({ type: 'text', text: 'Das geht gerade nicht.' })], () => new Response('no', { status: 503 }))
    expect(await (await s.post()).json()).toEqual({ calls: [{ tool: 'say', text: 'Das geht gerade nicht.' }] })
    expect(s.asked[1].messages.at(-1).content[0].content).toContain('not available')
  })

  it('searches the web with what the sources say and where they are', async () => {
    const s = await setup(
      [reply(lookup('web_search', { query: 'Öffnungszeiten Heimatmuseum Schnackenburg' })), reply({ type: 'text', text: 'Dienstags 10 Uhr.' })],
      undefined,
      () => reply({ type: 'text', text: 'Das Museum ist dienstags offen.' }, { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.org/museum', title: 'Museum' }] }),
    )
    await s.post()
    const search = s.asked.find((b) => b.tools?.[0]?.type === 'web_search_20250305')
    expect(search.messages).toEqual([{ role: 'user', content: 'Öffnungszeiten Heimatmuseum Schnackenburg' }])
    const result = s.asked.at(-1).messages.at(-1).content[0].content
    expect(result).toContain('dienstags offen')
    expect(result).toContain('https://example.org/museum')
  })

  it('goes on when the web search is not allowed', async () => {
    const s = await setup([reply(lookup('web_search', { query: 'x' })), reply({ type: 'text', text: 'Ich kann nicht suchen.' })], undefined, () => new Response(JSON.stringify({ error: { message: 'web search is not enabled' } }), { status: 400 }))
    expect(await (await s.post()).json()).toEqual({ calls: [{ tool: 'say', text: 'Ich kann nicht suchen.' }] })
  })

  it('looks up only so many times in one answer', async () => {
    const answers = Array.from({ length: 10 }, () => reply(lookup('find_coordinates', { query: 'x' })))
    const s = await setup(answers)
    const response = await s.post()
    expect(response.status).toBe(200)
    expect(s.asked).toHaveLength(5)
  })

  it('does not hand these tools to the app', () => {
    expect(toToolCalls({ content: [lookup('find_coordinates', { query: 'x' })] })).toEqual([{ tool: 'say', text: 'Das habe ich nicht verstanden. Magst du es anders sagen?' }])
  })
})

