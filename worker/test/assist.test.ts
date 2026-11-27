import { describe, expect, it } from 'vitest'
import { BadAssist, buildAssistModelRequest, fillOf, handleAssist, locationQuery, parseAssistRequest, sanitizeFill, type AssistRequest } from '../src/assist.js'

const index = [
  { id: 'schnackenburg', type: 'place', name: 'Schnackenburg' },
  { id: 'gummern', type: 'place', name: 'Gummern' },
  { id: 'erika-mustermann', type: 'person', name: 'Erika Mustermann' },
]
const request = (over: Partial<AssistRequest> = {}): AssistRequest => ({ stage: 'fields', type: null, data: { name: 'Freiwillige Feuerwehr Schnackenburg' }, open: ['kind', 'places', 'tags', 'description'], index, ...over })

describe('parsing what the browser sends', () => {
  it('keeps the stage, the type, the open fields and a sane index', () => {
    const parsed = parseAssistRequest({ stage: 'location', type: 'place', data: { name: 'x' }, open: ['location', 3], index: [...index, { id: 1 }] })
    expect(parsed).toMatchObject({ stage: 'location', type: 'place', open: ['location'] })
    expect(parsed.index).toHaveLength(3)
  })
  it('refuses what is not an object, and too long an index', () => {
    expect(() => parseAssistRequest('x')).toThrow(BadAssist)
    expect(() => parseAssistRequest({ data: {}, index: Array(1600).fill({ id: 'a', type: 'place', name: 'a' }) })).toThrow(/Too many/)
  })
})

describe('what of the answer is entered', () => {
  const org = request({ type: 'organization' })
  it('takes the type when it was not known, and only known fields that are open', () => {
    const answer = sanitizeFill({ type: 'organization', fields: { places: ['schnackenburg'], name: 'Hacked', nonsense: 1, tags: ['Feuerwehr', '_stub'] } }, request({ open: ['places', 'tags'] }))
    expect(answer.type).toBe('organization')
    expect(answer.fields).toEqual({ places: ['schnackenburg'], tags: ['Feuerwehr'] })
  })
  it('drops references that are not in the index or of the wrong type, and invalid choices', () => {
    const answer = sanitizeFill({ fields: { places: ['nirgends', 'erika-mustermann', 'gummern'], kind: 'not-a-kind' } }, { ...org, open: ['places', 'kind'] })
    expect(answer.fields).toEqual({ places: ['gummern'] })
  })
  it('never takes coordinates, files or texts, even when they are open', () => {
    const answer = sanitizeFill({ fields: { location: { lat: 1, lon: 2 }, files: [], links: [] } }, { ...org, open: ['location', 'files', 'links'] })
    expect(answer.fields).toEqual({})
  })
  it('is empty for nonsense', () => {
    expect(sanitizeFill('x', org)).toEqual({ fields: {} })
    expect(sanitizeFill({ fields: 3 }, org)).toEqual({ fields: {} })
  })
})

describe('the request to the model', () => {
  it('forces the fill call, and puts the cached parts first', () => {
    const body = buildAssistModelRequest(request(), 'm')
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'fill' })
    expect(body.system.every((b) => b.cache_control.type === 'ephemeral')).toBe(true)
    expect(body.system[1].text).toContain('schnackenburg|place|Schnackenburg')
    expect(JSON.parse(body.messages[0].content).open).toContain('kind')
  })
  it('reads the arguments of the call', () => {
    expect(fillOf({ content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'fill', input: { fields: { a: 1 } } }] })).toEqual({ fields: { a: 1 } })
    expect(fillOf({ content: [] })).toBeUndefined()
  })
})

describe('the map search', () => {
  it('asks for the address, else the name with the place it lies in', () => {
    expect(locationQuery(request({ type: 'place', data: { name: 'Gummern 3', address: 'Gummern 3, 29493 Schnackenburg' } }))).toBe('Gummern 3, 29493 Schnackenburg')
    expect(locationQuery(request({ type: 'place', data: { name: 'Fähranleger', parent: 'gummern' } }))).toBe('Fähranleger, Gummern')
    expect(locationQuery(request({ data: { name: 'Feuerwehr Schnackenburg', parent: 'schnackenburg' } }))).toBe('Feuerwehr Schnackenburg')
  })
})

describe('handleAssist', () => {
  const env = { ANTHROPIC_API_KEY: 'k' }
  let n = 0
  const some = () => ({ login: `p${n++}` }) as never
  const post = (body: unknown) => new Request('https://x/assist', { method: 'POST', body: JSON.stringify(body) })
  const model = (input: unknown): typeof fetch => (async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'fill', input }] }))) as never
  let t = 1_000_000
  const clock = () => (t += 5000)

  it('answers with the checked fields', async () => {
    const response = await handleAssist(post({ type: 'organization', data: { name: 'Feuerwehr' }, open: ['places'], index }), '/assist', some(), env, model({ fields: { places: ['schnackenburg', 'zzz'] } }), clock)
    expect(await response!.json()).toEqual({ fields: { places: ['schnackenburg'] } })
  })
  it('finds coordinates by the map search, with the source, and never from the model', async () => {
    const map = (async () => new Response(JSON.stringify([{ display_name: 'Feuerwehr, Schnackenburg', lat: '52.9921', lon: '11.5551' }]))) as never
    const response = await handleAssist(post({ stage: 'location', type: 'place', data: { name: 'Feuerwehr Schnackenburg' }, open: ['location'], index }), '/assist', some(), env, map, clock)
    expect(await response!.json()).toEqual({ fields: { location: { lat: 52.9921, lon: 11.5551 } }, source: { location: 'OpenStreetMap: Feuerwehr, Schnackenburg' } })
  })
  it('finds nothing when the hits are not the same spot', async () => {
    const map = (async () => new Response(JSON.stringify([{ lat: '52.99', lon: '11.55' }, { lat: '52.95', lon: '11.60' }]))) as never
    const response = await handleAssist(post({ stage: 'location', type: 'place', data: { name: 'Kirche' }, open: ['location'], index }), '/assist', some(), env, map, clock)
    expect(await response!.json()).toEqual({ fields: {} })
  })
  it('holds back a person who asks again at once, and a body that is not valid', async () => {
    const fast = () => 1_000_000_000
    const same = some()
    await handleAssist(post({ data: {}, open: [], index }), '/assist', same, env, model({ fields: {} }), fast)
    expect((await handleAssist(post({ data: {}, open: [], index }), '/assist', same, env, model({ fields: {} }), fast))!.status).toBe(429)
    expect((await handleAssist(new Request('https://x/assist', { method: 'POST', body: 'nope' }), '/assist', some(), env, model({}), clock))!.status).toBe(400)
  })
  it('is none of its business for other routes', async () => {
    expect(await handleAssist(post({}), '/chat', some(), env, model({}), clock)).toBeUndefined()
  })
})
