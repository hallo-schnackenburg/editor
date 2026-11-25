import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { env, fakeGitHub, request, signIn } from './support.js'

const fixture = (path: string) => readFileSync(new URL(`../../core/test/fixtures/examples/${path}`, import.meta.url), 'utf8')
const PERSON = fixture('entities/people/erika-mustermann.yaml')
const PLACE = 'id: feuerwehrhaus\ntype: place\nname: Feuerwehrhaus\n'
const BRANCH = 'submission/anna/fest'

async function setup(initial: Record<string, string> = { 'entities/people/erika-mustermann.yaml': PERSON, 'README.md': '# not an entry' }) {
  const gh = fakeGitHub(initial)
  return { gh, cookie: await signIn(gh) }
}
const get = async (gh: ReturnType<typeof fakeGitHub>, cookie: string, url: string) => {
  const response = await handle(request(cookie, url), env, gh.fn)
  return { status: response.status, data: (await response.json()) as any }
}
/** What CI would have put on the branch `index`. */
const stored = (gh: ReturnType<typeof fakeGitHub>, commit: string, entries: unknown[]) => gh.branches.set('index', new Map([['index.json', JSON.stringify({ version: 1, commit, entries })]]))

describe('the index', () => {
  it('is made from everything when CI has not made one yet', async () => {
    const { gh, cookie } = await setup()
    const { status, data } = await get(gh, cookie, '/api/repo/index')
    expect(status).toBe(200)
    expect(data).toMatchObject({ base: 'main', branch: null, exists: false, commit: 'head-main', head: 'head-main' })
    expect(data.entries).toEqual([{ path: 'entities/people/erika-mustermann.yaml', sha: gh.blob(PERSON), id: 'erika-mustermann', type: 'person', title: expect.any(String) }])
  })

  it('is the one of CI, without reading the entries, if it is current', async () => {
    const { gh, cookie } = await setup()
    const entry = { path: 'entities/people/erika-mustermann.yaml', sha: gh.blob(PERSON), id: 'erika-mustermann', type: 'person', title: 'Aus dem Index' }
    stored(gh, 'head-main', [entry])
    const { data } = await get(gh, cookie, '/api/repo/index')
    expect(data.entries).toEqual([entry])
    expect(gh.calls.some((c) => c.url === '/graphql')).toBe(false)
  })

  it('adds what is newer than the index of CI: new, changed and removed files', async () => {
    const { gh, cookie } = await setup({ 'entities/people/erika-mustermann.yaml': PERSON, 'entities/places/alt.yaml': 'id: alt\ntype: place\nname: Alt\n' })
    const old = [
      { path: 'entities/people/erika-mustermann.yaml', sha: 'old', id: 'erika-mustermann', type: 'person', title: 'Alt' },
      { path: 'entities/places/alt.yaml', sha: 'x', id: 'alt', type: 'place', title: 'Alt' },
    ]
    stored(gh, 'base-snapshot', old)
    // main moves on: a place is new, the person is changed, `alt` is gone
    const main = gh.branches.get('main')!
    main.set('entities/places/feuerwehrhaus.yaml', PLACE)
    main.set('entities/people/erika-mustermann.yaml', PERSON + '# geändert\n')
    main.delete('entities/places/alt.yaml')
    const { data } = await get(gh, cookie, '/api/repo/index')
    expect(data.entries.map((e: any) => e.path)).toEqual(['entities/people/erika-mustermann.yaml', 'entities/places/feuerwehrhaus.yaml'])
    expect(data.entries[0].sha).toBe(gh.blob(PERSON + '# geändert\n'))
    expect(data.entries[1]).toMatchObject({ id: 'feuerwehrhaus', title: 'Feuerwehrhaus' })
  })

  it('is the base plus what the branch of a submission changes', async () => {
    const { gh, cookie } = await setup()
    gh.branches.set(BRANCH, new Map(gh.branches.get('main')!))
    gh.branches.get(BRANCH)!.set('entities/places/feuerwehrhaus.yaml', PLACE)
    const { data } = await get(gh, cookie, `/api/repo/index?branch=${BRANCH}`)
    expect(data).toMatchObject({ branch: BRANCH, exists: true, commit: 'head-main', head: `head-${BRANCH}` })
    expect(data.entries.map((e: any) => e.path)).toEqual(['entities/people/erika-mustermann.yaml', 'entities/places/feuerwehrhaus.yaml'])
  })

  it('is the base while the submission has no branch, and takes only the branch of a submission', async () => {
    const { gh, cookie } = await setup()
    const before = await get(gh, cookie, `/api/repo/index?branch=${BRANCH}`)
    expect(before.data).toMatchObject({ exists: false, head: 'head-main' })
    expect((await get(gh, cookie, '/api/repo/index?branch=main')).status).toBe(400)
  })
})

describe('one entry', () => {
  it('is read with its sha, from the branch of the submission if it has it, else from the base branch', async () => {
    const { gh, cookie } = await setup()
    gh.branches.set(BRANCH, new Map(gh.branches.get('main')!))
    gh.branches.get(BRANCH)!.set('entities/places/feuerwehrhaus.yaml', PLACE)
    const path = 'entities/places/feuerwehrhaus.yaml'
    expect((await get(gh, cookie, `/api/repo/entry?path=${path}`)).status).toBe(404)
    expect((await get(gh, cookie, `/api/repo/entry?path=${path}&branch=${BRANCH}`)).data).toEqual({ path, sha: gh.blob(PLACE), text: PLACE })
    const person = await get(gh, cookie, `/api/repo/entry?path=entities/people/erika-mustermann.yaml&branch=${BRANCH}`)
    expect(person.data.text).toBe(PERSON)
  })

  it('takes only the path of an entry', async () => {
    const { gh, cookie } = await setup()
    expect((await get(gh, cookie, '/api/repo/entry?path=README.md')).status).toBe(400)
    expect((await get(gh, cookie, '/api/repo/entry')).status).toBe(400)
  })
})
