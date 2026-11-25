import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { env, fakeGitHub, request, signIn } from './support.js'

describe('the bundle', () => {
  it('is passed on as it is from the branch of the index', async () => {
    const gh = fakeGitHub({ 'entities/people/e.yaml': 'id: e\ntype: person\nname: E\n' })
    const cookie = await signIn(gh)
    const bundle = '{"version":1,"commit":"abc"}\n'
    gh.branches.set('index', new Map([['index.json', '{}'], ['entries.ndjson.gz', bundle]]))
    const response = await handle(request(cookie, '/api/repo/bundle'), env, gh.fn)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(await response.text()).toBe(bundle)
  })

  it('is not there (404) as long as CI has made none', async () => {
    const gh = fakeGitHub({ 'entities/people/e.yaml': 'id: e\ntype: person\nname: E\n' })
    const cookie = await signIn(gh)
    expect((await handle(request(cookie, '/api/repo/bundle'), env, gh.fn)).status).toBe(404)
    gh.branches.set('index', new Map([['index.json', '{}']]))
    expect((await handle(request(cookie, '/api/repo/bundle'), env, gh.fn)).status).toBe(404)
  })
})
