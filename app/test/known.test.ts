import { describe, expect, it, vi } from 'vitest'
import type { RemoteEntry } from '../src/api.js'
import { FakeApi } from '../src/fake.js'
import { Known, MemoryStore, type Listed, applyDelta, deltaOf } from '../src/known.js'
import { Workspace } from '../src/workspace.svelte.js'

const BERND = 'submission/bernd/feuerwehr-texte'
const FEUERWEHR = 'entities/organizations/feuerwehr-schnackenburg.yaml'

const result = (files: Record<string, string>, branch: string | null = null): Listed<RemoteEntry> => ({
  base: 'main',
  branch,
  exists: true,
  entries: Object.entries(files).map(([path, text]) => ({ path, text, sha: `sha-${text}` })),
})

describe('what is known of a branch', () => {
  it('keeps only how it differs from the base, and gives the whole branch back', () => {
    const base = result({ a: '1', b: '2', c: '3' })
    const branch = result({ a: '1', b: 'two', d: '4' }, 'submission/x/y')
    const record = deltaOf(base, branch, 'h1')
    expect(record.changed.map((e) => e.path)).toEqual(['b', 'd'])
    expect(record.removed).toEqual(['c'])
    expect(applyDelta(base, record, 'submission/x/y')).toEqual({ ...branch, entries: [...branch.entries].sort((a, b) => a.path.localeCompare(b.path)) })
  })

  it('stays what it was when the base changes', () => {
    const known = new Known()
    known.setBase(result({ a: '1', b: '2' }))
    const branch = result({ a: '1', b: '2', c: 'new' }, 'submission/x/y')
    known.setBranch('submission/x/y', branch, 'h1')
    // main moved on (a changed, b went): the branch has what it had.
    known.setBase(result({ a: 'one' }))
    expect(known.recall('submission/x/y')!.entries.map((e) => [e.path, e.text])).toEqual([['a', '1'], ['b', '2'], ['c', 'new']])
    expect(known.recall(undefined)!.entries.map((e) => e.path)).toEqual(['a'])
  })

  it('is right for the head it was read at, and for no other', () => {
    const known = new Known()
    known.setBase(result({ a: '1' }))
    known.setBranch('submission/x/y', result({ a: '2' }, 'submission/x/y'), 'h1')
    expect(known.valid('submission/x/y', 'h1')).toBe(true)
    expect(known.valid('submission/x/y', 'h2')).toBe(false)
    expect(known.valid('submission/x/y', undefined)).toBe(false)
    known.setBranch('submission/x/z', result({ a: '2' }, 'submission/x/z'), undefined)
    expect(known.valid('submission/x/z', '')).toBe(false)
  })
})

describe('nothing to wait for', () => {
  /** Waits until the background reading of bernd's submission is done. */
  const warmed = async (api: { asked: (string | undefined)[] }) => {
    await vi.waitFor(() => expect(api.asked).toContain(BERND))
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  /** An api that tells what was asked for. */
  class Counting extends FakeApi {
    asked: (string | undefined)[] = []
    details = 0
    async index(branch?: string) {
      this.asked.push(branch)
      return super.index(branch)
    }
    async submission(number: number) {
      this.details++
      return super.submission(number)
    }
  }

  async function started(api: FakeApi, store = new MemoryStore()) {
    const ws = new Workspace(api, undefined, store)
    await ws.start()
    ws.stopLive()
    return ws
  }

  it('reads the open submissions in the background, and then opens one without asking for its entries', async () => {
    const api = new Counting()
    const ws = await started(api)
    await warmed(api)
    api.asked = []
    expect(await ws.switchTo(BERND)).toBe(true)
    expect(api.asked).toEqual([])
    await ws.ensure([FEUERWEHR])
    expect(ws.entries.find((e) => e.path === FEUERWEHR)!.text).toContain('e. V.')
  })

  it('works out what a submission does from the entries it has: the details are there without GitHub', async () => {
    const api = new Counting()
    const ws = await started(api)
    await warmed(api)
    // Not waiting for what GitHub says: only the entries of the workspace are looked at.
    const select = ws.review.select(1)
    void ws.switchTo(BERND)
    await select
    await ws.switchTo(BERND)
    expect(ws.review.detail?.items.map((i) => [i.path, i.kind])).toEqual([[FEUERWEHR, 'modified']])
    expect(ws.review.detail?.items[0].before).not.toContain('e. V.')
    expect(ws.review.detail?.items[0].after).toContain('e. V.')
  })

  it('asks for a branch again when its head is not the one it was read at', async () => {
    const api = new Counting()
    const ws = await started(api)
    await warmed(api)
    // Somebody else saved on bernd's branch.
    await api.commit([{ path: FEUERWEHR, text: (await api.read([FEUERWEHR], BERND))[0].text + '# more\n' }], [], { branch: BERND, name: 'x' })
    await ws.loadSubmissions()
    api.asked = []
    await ws.switchTo(BERND)
    expect(api.asked).toEqual([BERND])
    await ws.ensure([FEUERWEHR])
    expect(ws.entries.find((e) => e.path === FEUERWEHR)!.text).toContain('# more')
  })

  it('shows what was kept in the store at once, before GitHub has answered', async () => {
    const store = new MemoryStore()
    const first = await started(new Counting(), store)
    await vi.waitFor(async () => expect(await store.load()).toBeDefined(), { timeout: 3000 })
    first.stopLive()

    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (open = resolve))
    class Waiting extends FakeApi {
      async submissions() {
        await gate
        return super.submissions()
      }
      async index(branch?: string) {
        await gate
        return super.index(branch)
      }
    }
    const ws = new Workspace(new Waiting(), undefined, store)
    const start = ws.start()
    await vi.waitFor(() => expect(ws.entries.length).toBeGreaterThan(0))
    expect(ws.submissions.map((c) => c.branch)).toEqual([BERND])
    open()
    await start
    ws.stopLive()
    expect(ws.entries).toHaveLength(7)
  })

  it('forgets what it kept when somebody else signs in, and when the person signs out', async () => {
    const store = new MemoryStore()
    await started(new Counting(), store)
    await vi.waitFor(async () => expect(await store.load()).toBeDefined(), { timeout: 3000 })
    const snapshot = (await store.load())!
    await store.save({ ...snapshot, login: 'someone-else' })
    let seen = -1
    class Watching extends FakeApi {
      async index(branch?: string) {
        if (seen < 0) seen = ws.entries.length // nothing of the other person's is shown while it is read
        return super.index(branch)
      }
    }
    const ws = new Workspace(new Watching(), undefined, store)
    await ws.start()
    ws.stopLive()
    expect(seen).toBe(0)
    await ws.logout()
    expect(await store.load()).toBeUndefined()
  })

  it('shows the details of the own draft when the page is loaded again', async () => {
    const api = new Counting()
    const first = await started(api)
    await first.select('entities/people/erika-mustermann.yaml')
    first.edit(first.selected!.text + '# note\n')
    await first.finish()
    const ws = await started(api)
    expect(ws.branch).toBe(first.branch)
    expect(ws.review.selected).toBe(ws.active!.number)
    expect(ws.review.detailOpen).toBe(true)
  })

  it('brings the person back to where they were when the page is loaded again', async () => {
    const store = new MemoryStore()
    const api = new Counting()
    const first = await started(api, store)
    // Own draft, and then back on the database: that is where the page comes back to, not to the draft.
    await first.select('entities/people/erika-mustermann.yaml')
    first.edit(first.selected!.text + '# note\n')
    await first.finish()
    await first.switchTo(undefined)
    first.rememberView()
    await vi.waitFor(async () => expect((await store.load())?.view).toMatchObject({ branch: null }), { timeout: 3000 })
    const onBase = await started(api, store)
    expect(onBase.branch).toBeUndefined()
    expect(onBase.review.detailOpen).toBe(false)

    // Somebody else's submission, with the entry that was open.
    await onBase.switchTo(BERND)
    await onBase.select(FEUERWEHR)
    onBase.rememberView()
    await vi.waitFor(async () => expect((await store.load())?.view).toMatchObject({ branch: BERND, path: FEUERWEHR }), { timeout: 3000 })
    const again = await started(api, store)
    expect(again.branch).toBe(BERND)
    expect(again.selectedPath).toBe(FEUERWEHR)
  })

  it('goes to the database when the submission it was at is not there any more', async () => {
    const store = new MemoryStore()
    const api = new Counting()
    const first = await started(api, store)
    await first.switchTo(BERND)
    first.rememberView()
    await vi.waitFor(async () => expect((await store.load())?.view).toMatchObject({ branch: BERND }), { timeout: 3000 })
    await api.close(1)
    const ws = await started(api, store)
    expect(ws.branch).toBeUndefined()
  })

  it('shows the page for the person who was there before it is known that they are still signed in', async () => {
    const store = new MemoryStore()
    await started(new Counting(), store)
    await vi.waitFor(async () => expect(await store.load()).toBeDefined(), { timeout: 3000 })
    let answer: (user: Awaited<ReturnType<FakeApi['me']>> | null) => void = () => undefined
    class Unsure extends FakeApi {
      me() {
        return new Promise<any>((resolve) => (answer = resolve))
      }
    }
    const ws = new Workspace(new Unsure(), undefined, store)
    const start = ws.start()
    await vi.waitFor(() => expect(ws.entries.length).toBeGreaterThan(0))
    expect(ws.user?.login).toBe('anna')
    // They are not signed in any more: the page says so.
    answer(null)
    await start
    expect(ws.user).toBeNull()
    expect(ws.entries).toEqual([])
  })
})
