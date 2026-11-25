import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { checkBeforeSaving } from '../src/repo.js'
import { env, fakeGitHub, request, signIn } from './support.js'

const fixture = (path: string) => readFileSync(new URL(`../../core/test/fixtures/examples/${path}`, import.meta.url), 'utf8')
const PERSON = fixture('entities/people/erika-mustermann.yaml')

async function setup(initial: Record<string, string> = { 'entities/people/erika-mustermann.yaml': PERSON, 'README.md': '# not an entry' }) {
  const gh = fakeGitHub(initial)
  return { gh, cookie: await signIn(gh) }
}
const BRANCH = 'submission/anna/fest'
/** A save of a submission called "Fest"; `data` adds to or replaces what is sent. */
const put = (cookie: string, data: Record<string, unknown>, headers: Record<string, string> = {}) => request(cookie, '/api/repo/entry', { method: 'PUT', body: JSON.stringify({ branch: BRANCH, name: 'Fest', ...data }), headers })

describe('the entries (as the index lists them)', () => {
  it('lists the entries of the base branch, and only entries', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(request(cookie, '/api/repo/index'), env, gh.fn)
    const data = await response.json() as any
    expect(response.status).toBe(200)
    expect(data).toMatchObject({ base: 'main', branch: null, exists: false })
    expect(data.entries).toEqual([{ path: 'entities/people/erika-mustermann.yaml', sha: gh.blob(PERSON), id: 'erika-mustermann', type: 'person', title: expect.any(String) }])
  })

  it('delivers the .folder.yaml of a topic folder too, and a commit may write it (checked), but not the single-entry route', async () => {
    const folder = 'title: Kunst\n'
    const { gh, cookie } = await setup({ 'entities/people/erika-mustermann.yaml': PERSON, 'contents/kunst/.folder.yaml': folder })
    const data = await (await handle(request(cookie, '/api/repo/index'), env, gh.fn)).json() as any
    expect(data.entries.map((e: { path: string }) => e.path)).toEqual(['contents/kunst/.folder.yaml', 'entities/people/erika-mustermann.yaml'])
    const refused = await handle(put(cookie, { path: 'contents/kunst/.folder.yaml', text: folder }), env, gh.fn)
    expect(refused.status).toBe(400)
  })

  it('commits a new topic folder, and refuses one without a title', async () => {
    const { gh, cookie } = await setup({ 'entities/people/erika-mustermann.yaml': PERSON })
    const post = (writes: unknown[]) => handle(request(cookie, '/api/repo/commit', { method: 'POST', body: JSON.stringify({ writes, removals: [], branch: 'submission/anna/fest', name: 'Fest' }) }), env, gh.fn)
    const bad = await post([{ path: 'contents/kunst/.folder.yaml', text: 'name: Kunst\n' }])
    expect(bad.status).toBe(422)
    const good = await post([{ path: 'contents/kunst/.folder.yaml', text: 'title: Kunst\n' }])
    expect(good.status).toBe(200)
  })

  it('asks GitHub for the texts with variables, not by putting paths into the query', async () => {
    const { gh, cookie } = await setup()
    await handle(request(cookie, '/api/repo/index'), env, gh.fn)
    const query = gh.calls.find((c) => c.url === '/graphql')!.body
    expect(query.query).not.toContain('erika')
    expect(query.variables.e0).toBe('head-main:entities/people/erika-mustermann.yaml')
  })
})

describe('reading a submission', () => {
  it('reads the base branch while the submission has no branch, and the branch once it has', async () => {
    const { gh, cookie } = await setup()
    const before = await (await handle(request(cookie, `/api/repo/index?branch=${BRANCH}`), env, gh.fn)).json() as any
    expect(before).toMatchObject({ branch: BRANCH, exists: false })
    expect(before.entries).toHaveLength(1)
    await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: 'id: feuerwehrhaus\ntype: place\nname: Feuerwehrhaus\n' }), env, gh.fn)
    const after = await (await handle(request(cookie, `/api/repo/index?branch=${BRANCH}`), env, gh.fn)).json() as any
    expect(after.exists).toBe(true)
    expect(after.entries.map((e: any) => e.path)).toEqual(['entities/people/erika-mustermann.yaml', 'entities/places/feuerwehrhaus.yaml'])
  })

  it('takes only the branch of a submission', async () => {
    const { gh, cookie } = await setup()
    for (const branch of ['main', 'edit/anna', 'submission/anna', 'submission/anna/A b']) {
      const response = await handle(request(cookie, `/api/repo/index?branch=${encodeURIComponent(branch)}`), env, gh.fn)
      expect(response.status, branch).toBe(400)
    }
  })
})

describe('saving an entry', () => {
  const NEW = 'id: feuerwehrhaus\ntype: place\nname: Feuerwehrhaus\n'

  it('makes the branch of the submission on the first save and commits there, never on the base branch', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)
    expect(await response.json()).toMatchObject({ path: 'entities/places/feuerwehrhaus.yaml', branch: BRANCH, commit: 'commit-put', pull: 1 })
    expect(gh.branches.get(BRANCH)!.get('entities/places/feuerwehrhaus.yaml')).toBe(NEW)
    expect(gh.branches.get('main')!.has('entities/places/feuerwehrhaus.yaml')).toBe(false)
    const created = gh.calls.find((c) => c.method === 'POST' && c.url === '/repos/o/r/git/refs')!.body
    expect(created).toEqual({ ref: `refs/heads/${BRANCH}`, sha: 'head-main' })
  })

  it('opens the pull request as a draft with the name of the submission, once', async () => {
    const { gh, cookie } = await setup()
    await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW, name: 'Feuerwehr & Fest' }), env, gh.fn)
    expect(gh.pulls).toHaveLength(1)
    expect(gh.pulls[0]).toMatchObject({ title: 'Feuerwehr & Fest', draft: true, head: { ref: BRANCH }, base: { ref: 'main' } })
    const sha = gh.blob(NEW)
    const second = await (await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW + '# x\n', sha, name: 'Something else' }), env, gh.fn)).json() as any
    expect(gh.pulls).toHaveLength(1)
    expect(second.pull).toBe(1)
  })

  it('needs a name for the first save, but not for the next', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW, name: undefined }), env, gh.fn)
    expect(response.status).toBe(400)
    expect(gh.branches.has(BRANCH)).toBe(false)
    await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)
    const next = await handle(put(cookie, { path: 'entities/places/zweites.yaml', text: NEW.replace('feuerwehrhaus', 'zweites'), name: undefined }), env, gh.fn)
    expect(next.status).toBe(200)
  })

  it('has no pull request while the submission does not differ from the base, and opens it on the save that does', async () => {
    const { gh, cookie } = await setup()
    const same = await (await handle(put(cookie, { path: 'entities/people/erika-mustermann.yaml', text: PERSON, sha: gh.blob(PERSON) }), env, gh.fn)).json() as any
    expect(same.pull).toBeUndefined()
    expect(gh.pulls).toHaveLength(0)
    const changed = await (await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)).json() as any
    expect(changed.pull).toBe(1)
  })

  it('does not take a save to a submission that is accepted or closed', async () => {
    const { gh, cookie } = await setup()
    await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)
    gh.pulls[0].state = 'closed'
    const response = await handle(put(cookie, { path: 'entities/places/zweites.yaml', text: NEW.replace('feuerwehrhaus', 'zweites') }), env, gh.fn)
    expect(response.status).toBe(409)
    expect(((await response.json()) as any).error).toMatch(/abgeschlossen/)
  })

  it('takes a new submission of a name whose branch is gone (the earlier one was accepted)', async () => {
    const { gh, cookie } = await setup()
    await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)
    gh.pulls[0].state = 'closed'
    gh.pulls[0].merged_at = 'x'
    gh.branches.delete(BRANCH)
    const response = await handle(put(cookie, { path: 'entities/places/zweites.yaml', text: NEW.replace('feuerwehrhaus', 'zweites') }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(gh.pulls).toHaveLength(2)
  })

  it('does not make a second branch, and a submission needs the sha it is based on', async () => {
    const { gh, cookie } = await setup()
    await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)
    const sha = gh.blob(NEW)
    const changed = NEW.replace('Feuerwehrhaus', 'Feuerwehrhaus Schnackenburg')
    const ok = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: changed, sha }), env, gh.fn)
    expect(ok.status).toBe(200)
    expect(gh.calls.filter((c) => c.url === '/repos/o/r/git/refs')).toHaveLength(1)
    const stale = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW, sha }), env, gh.fn)
    expect(stale.status).toBe(409) // somebody (here: the first submission) has changed it since
  })

  it('refuses text that is not YAML, with the issues, and writes nothing', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: 'id: [feuerwehrhaus\ntype: place\n' }), env, gh.fn)
    expect(response.status).toBe(422)
    expect(((await response.json()) as any).issues[0].message).toMatch(/YAML syntax error/)
    expect(gh.calls.some((c) => c.method === 'PUT')).toBe(false)
    expect(gh.branches.has(BRANCH)).toBe(false)
  })

  it('takes an unfinished entry (a required field is missing): that is held back at the merge, not at the save', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: 'id: feuerwehrhaus\ntype: place\n' }), env, gh.fn)
    expect(response.status).toBe(200)
  })

  it('refuses an entry that is not where its id and type say', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(put(cookie, { path: 'entities/people/feuerwehrhaus.yaml', text: NEW }), env, gh.fn)
    expect(response.status).toBe(422)
    expect(((await response.json()) as any).issues[0].message).toMatch(/belongs in entities\/places/)
  })

  it('only takes paths of entries', async () => {
    const { gh, cookie } = await setup()
    for (const path of ['.github/workflows/validate.yml', 'entities/../x.yaml', 'README.md', 'entities/places/Haus.yaml', '/entities/places/a.yaml', 'other/a.yaml']) {
      const response = await handle(put(cookie, { path, text: NEW }), env, gh.fn)
      expect(response.status, path).toBe(400)
    }
    expect(gh.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('does not take a submission from another origin', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(put(cookie, { path: 'entities/places/feuerwehrhaus.yaml', text: NEW }, { origin: 'https://evil.example' }), env, gh.fn)
    expect(response.status).toBe(403)
  })
})

describe('removing an entry', () => {
  it('commits the removal on the branch of the submission and needs the sha', async () => {
    const { gh, cookie } = await setup()
    const path = 'entities/people/erika-mustermann.yaml'
    const without = await handle(request(cookie, '/api/repo/entry', { method: 'DELETE', body: JSON.stringify({ path, branch: BRANCH, name: 'Fest' }) }), env, gh.fn)
    expect(without.status).toBe(400)
    const response = await handle(request(cookie, '/api/repo/entry', { method: 'DELETE', body: JSON.stringify({ path, sha: gh.blob(PERSON), branch: BRANCH, name: 'Fest' }) }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(gh.branches.get(BRANCH)!.has(path)).toBe(false)
    expect(gh.branches.get('main')!.has(path)).toBe(true)
  })
})

describe('helpers', () => {
  it('checks what core checks', () => {
    expect(checkBeforeSaving('entities/people/erika-mustermann.yaml', PERSON)).toEqual([])
    expect(checkBeforeSaving('entities/people/x.yaml', PERSON)[0].message).toMatch(/id must be the path below entities\/people\//)
    expect(checkBeforeSaving('entities/people/erika-mustermann.yaml', 'id: erika-mustermann\ntype: person\n')).toEqual([]) // unfinished is not refused
  })
})

describe('committing several entries at once', () => {
  const NEW = 'id: feuerwehrhaus\ntype: place\nname: Feuerwehrhaus\n'
  const commit = (cookie: string, data: Record<string, unknown>) => request(cookie, '/api/repo/commit', { method: 'POST', body: JSON.stringify({ branch: BRANCH, name: 'Umbenennung', ...data }) })

  it('moves files and rewrites others in one commit on the branch, and opens the draft pull request', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(commit(cookie, { writes: [{ path: 'entities/places/feuerwehrhaus.yaml', text: NEW }], removals: ['entities/people/erika-mustermann.yaml'] }), env, gh.fn)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ branch: BRANCH, pull: 1 })
    const branch = gh.branches.get(BRANCH)!
    expect(branch.get('entities/places/feuerwehrhaus.yaml')).toBe(NEW)
    expect(branch.has('entities/people/erika-mustermann.yaml')).toBe(false)
    expect(gh.branches.get('main')!.has('entities/people/erika-mustermann.yaml')).toBe(true)
    expect(gh.calls.filter((c) => c.method === 'PATCH' && c.url.includes('/git/refs/heads/'))).toHaveLength(1)
    expect(gh.pulls[0]).toMatchObject({ title: 'Umbenennung', draft: true })
  })

  it('writes nothing if one of the entries is not valid', async () => {
    const { gh, cookie } = await setup()
    const response = await handle(commit(cookie, { writes: [{ path: 'entities/places/feuerwehrhaus.yaml', text: NEW }, { path: 'entities/places/kaputt.yaml', text: 'type: [place\n' }] }), env, gh.fn)
    expect(response.status).toBe(422)
    expect(gh.branches.has(BRANCH)).toBe(false)
  })

  it('refuses an empty commit and a path that is there twice', async () => {
    const { gh, cookie } = await setup()
    expect((await handle(commit(cookie, {}), env, gh.fn)).status).toBe(400)
    const twice = await handle(commit(cookie, { writes: [{ path: 'entities/places/feuerwehrhaus.yaml', text: NEW }], removals: ['entities/places/feuerwehrhaus.yaml'] }), env, gh.fn)
    expect(twice.status).toBe(400)
  })
})
