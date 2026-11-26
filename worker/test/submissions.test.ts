import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { env, fakeGitHub, request, signIn } from './support.js'

const BRANCH = 'submission/anna/fest'
const PERSON = 'id: erika\ntype: person\nname: Erika\n'
const PLACE = 'id: haus\ntype: place\nname: Haus\n'

async function setup() {
  const gh = fakeGitHub({ 'entities/people/erika.yaml': PERSON })
  return { gh, cookie: await signIn(gh) }
}
/** A submission called "Fest" with a new place, as a draft. */
async function started() {
  const s = await setup()
  await handle(request(s.cookie, '/api/repo/entry', { method: 'PUT', body: JSON.stringify({ branch: BRANCH, name: 'Fest', path: 'entities/places/haus.yaml', text: PLACE }) }), env, s.gh.fn)
  return s
}
const get = async (s: { gh: ReturnType<typeof fakeGitHub>; cookie: string }, path: string) => {
  const response = await handle(request(s.cookie, `/api/repo/submissions${path}`), env, s.gh.fn)
  return { status: response.status, body: (await response.json()) as any }
}
const post = async (s: { gh: ReturnType<typeof fakeGitHub>; cookie: string }, path: string, data?: unknown) => {
  const response = await handle(request(s.cookie, `/api/repo/submissions${path}`, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }), env, s.gh.fn)
  return { status: response.status, body: (await response.json()) as any }
}

describe('the list', () => {
  it('has the pull requests from submission branches, with the state, and whose they are', async () => {
    const s = await started()
    const { status, body } = await get(s, '')
    expect(status).toBe(200)
    expect(body.submissions).toEqual([{ number: 1, name: 'Fest', branch: BRANCH, author: 'anna', state: 'draft', url: 'https://github.com/o/r/pull/1', updated: '2026-01-01T00:00:00Z', head: `head-${BRANCH}` }])
  })

  it('leaves out pull requests that are not submissions', async () => {
    const s = await started()
    s.gh.pulls.push({ ...s.gh.pulls[0], number: 2, head: { ref: 'dependabot/x', sha: 'x', repo: { full_name: 'o/r' } } })
    s.gh.pulls.push({ ...s.gh.pulls[0], number: 3, head: { ref: BRANCH, sha: 'x', repo: { full_name: 'fork/r' } } })
    expect((await get(s, '')).body.submissions.map((c: any) => c.number)).toEqual([1])
  })

  it('tells the four states', async () => {
    const s = await started()
    const states = () => get(s, '').then((r) => r.body.submissions[0].state)
    expect(await states()).toBe('draft')
    s.gh.pulls[0].draft = false
    expect(await states()).toBe('submitted')
    s.gh.pulls[0].state = 'closed'
    expect(await states()).toBe('closed')
    s.gh.pulls[0].merged_at = 'x'
    expect(await states()).toBe('merged')
  })
})

describe('one submission', () => {
  it('shows what it adds, changes and removes, before and after', async () => {
    const s = await started()
    s.gh.branches.get(BRANCH)!.set('entities/people/erika.yaml', PERSON + 'links:\n  - label: a\n    url: https://a.example\n')
    s.gh.branches.get(BRANCH)!.set('README.md', 'not an entry')
    const { status, body } = await get(s, '/1')
    expect(status).toBe(200)
    expect(body.items).toEqual([
      { path: 'entities/people/erika.yaml', kind: 'modified', before: PERSON, after: PERSON + 'links:\n  - label: a\n    url: https://a.example\n' },
      { path: 'entities/places/haus.yaml', kind: 'added', after: PLACE },
    ])
    expect(body.truncated).toBe(false)
    s.gh.branches.get(BRANCH)!.delete('entities/people/erika.yaml')
    expect((await get(s, '/1')).body.items[0]).toEqual({ path: 'entities/people/erika.yaml', kind: 'removed', before: PERSON })
  })

  it('says how the checks stand', async () => {
    const s = await started()
    for (const checks of ['success', 'failure', 'pending', 'none'] as const) {
      s.gh.options.checks = checks
      expect((await get(s, '/1')).body.checks).toBe(checks)
    }
  })

  it('knows no pull request that is not a submission, or does not exist', async () => {
    const s = await started()
    s.gh.pulls.push({ ...s.gh.pulls[0], number: 2, head: { ref: 'dependabot/x', sha: 'x', repo: { full_name: 'o/r' } } })
    expect((await get(s, '/2')).status).toBe(404)
    expect((await get(s, '/9')).status).toBe(404)
  })
})

describe('submitting, accepting, closing', () => {
  it('submits a draft, and only once', async () => {
    const s = await started()
    expect((await post(s, '/1/submit')).body.state).toBe('submitted')
    expect(s.gh.pulls[0].draft).toBe(false)
    expect((await post(s, '/1/submit')).status).toBe(409)
  })

  it('does not accept a draft', async () => {
    const s = await started()
    const { status, body } = await post(s, '/1/merge')
    expect(status).toBe(409)
    expect(body.error).toMatch(/erst einreichen/)
    expect(s.gh.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/merge'))).toBe(false)
  })

  it('accepts a submitted submission by squashing it into the base branch, and removes the branch', async () => {
    const s = await started()
    await post(s, '/1/submit')
    const { status, body } = await post(s, '/1/merge')
    expect(status).toBe(200)
    expect(body.state).toBe('merged')
    const merge = s.gh.calls.find((c) => c.url.endsWith('/pulls/1/merge'))!
    expect(merge.body).toEqual({ merge_method: 'squash', sha: `head-${BRANCH}` })
    expect(s.gh.branches.get('main')!.get('entities/places/haus.yaml')).toBe(PLACE)
    expect(s.gh.branches.has(BRANCH)).toBe(false)
    expect((await post(s, '/1/merge')).status).toBe(409)
  })

  it('passes on GitHubs refusal when a required check is missing', async () => {
    const s = await started()
    s.gh.options.protect = true
    s.gh.options.checks = 'failure'
    await post(s, '/1/submit')
    const { status, body } = await post(s, '/1/merge')
    expect(status).toBe(409)
    expect(body.error).toMatch(/Required status check/)
    expect(s.gh.branches.has(BRANCH)).toBe(true)
  })

  it('closes a submission without accepting it, and removes its branch', async () => {
    const s = await started()
    expect((await post(s, '/1/close')).body.state).toBe('closed')
    expect(s.gh.branches.has(BRANCH)).toBe(false)
    expect(s.gh.branches.get('main')!.has('entities/places/haus.yaml')).toBe(false)
    expect((await post(s, '/1/close')).status).toBe(409)
  })

  it('renames a submission that is not finished: the title of the pull request', async () => {
    const s = await started()
    const done = await post(s, '/1/rename', { name: '  Fähre   und Post ' })
    expect(done.status).toBe(200)
    expect(done.body.name).toBe('Fähre und Post')
    expect(s.gh.pulls[0].title).toBe('Fähre und Post')
    expect((await get(s, '')).body.submissions[0].name).toBe('Fähre und Post')
    expect((await post(s, '/1/rename', { name: '   ' })).status).toBe(400)
    expect((await post(s, '/1/rename', {})).status).toBe(400)
    expect((await post(s, '/1/rename', { name: 'x'.repeat(101) })).status).toBe(413)
    await post(s, '/1/close')
    expect((await post(s, '/1/rename', { name: 'Neu' })).status).toBe(409)
    expect(s.gh.pulls[0].title).toBe('Fähre und Post')
  })

  it('takes nothing from another origin', async () => {
    const s = await started()
    const response = await handle(request(s.cookie, '/api/repo/submissions/1/close', { method: 'POST', headers: { origin: 'https://evil.example' } }), env, s.gh.fn)
    expect(response.status).toBe(403)
  })
})

const send = async (s: { gh: ReturnType<typeof fakeGitHub>; cookie: string }, method: string, path: string, data?: unknown) => {
  const response = await handle(request(s.cookie, `/api/repo/submissions${path}`, { method, body: data === undefined ? undefined : JSON.stringify(data) }), env, s.gh.fn)
  return { status: response.status, body: response.status === 204 ? undefined : ((await response.json()) as any) }
}

describe('comments', () => {
  it('are changed and removed by their author', async () => {
    const s = await started()
    const { id } = (await post(s, '/1/comments', { body: 'Erster Stand.' })).body
    const changed = await send(s, 'PATCH', `/1/comments/${id}`, { body: '  Neuer Stand.  ' })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({ id, body: 'Neuer Stand.', author: 'anna' })
    expect((await send(s, 'PATCH', `/1/comments/${id}`, { body: ' ' })).status).toBe(400)
    expect((await send(s, 'DELETE', `/1/comments/${id}`)).status).toBe(204)
    expect((await get(s, '/1/comments')).body.comments).toEqual([])
    expect((await send(s, 'DELETE', `/1/comments/${id}`)).status).toBe(404)
  })

  it('are not changed or removed by somebody else', async () => {
    const s = await started()
    s.gh.options.commenter = 'ben'
    const { id } = (await post(s, '/1/comments', { body: 'Von Ben.' })).body
    expect((await send(s, 'PATCH', `/1/comments/${id}`, { body: 'x' })).status).toBe(403)
    expect((await send(s, 'DELETE', `/1/comments/${id}`)).status).toBe(403)
    expect((await get(s, '/1/comments')).body.comments.map((c: any) => c.body)).toEqual(['Von Ben.'])
  })

  it('are read and written, oldest first, and the author is the person', async () => {
    const s = await started()
    expect((await get(s, '/1/comments')).body.comments).toEqual([])
    const written = await post(s, '/1/comments', { body: '  Bitte noch das Datum prüfen.  ' })
    expect(written.status).toBe(201)
    expect(written.body).toMatchObject({ author: 'anna', body: 'Bitte noch das Datum prüfen.' })
    await post(s, '/1/comments', { body: 'Erledigt.' })
    expect((await get(s, '/1/comments')).body.comments.map((c: any) => c.body)).toEqual(['Bitte noch das Datum prüfen.', 'Erledigt.'])
  })

  it('are not empty and not endless', async () => {
    const s = await started()
    expect((await post(s, '/1/comments', { body: '   ' })).status).toBe(400)
    expect((await post(s, '/1/comments', { body: 'x'.repeat(10_001) })).status).toBe(413)
    expect((await post(s, '/1/comments', {})).status).toBe(400)
  })
})
