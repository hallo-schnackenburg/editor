import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SignedOut, type Api } from '../src/api.js'
import { FakeApi } from '../src/fake.js'
import { titleOf } from '../src/logic.js'
import { MemoryTextStore, type TextStore } from '../src/texts.js'
import { POLL_MS, Workspace, defaultName } from '../src/workspace.svelte.js'

const ERIKA = 'entities/people/erika-mustermann.yaml'
const FEST = 'submission/anna/fest'

async function started(api: Api = new FakeApi(), mirror = false, texts?: TextStore) {
  const ws = new Workspace(api, undefined, undefined, texts)
  ws.mirror = mirror
  ws.bundleFrom = 0
  await ws.start()
  ws.stopLive() // no timers left behind
  return ws
}
/** Makes a change to Erika and a new place, so that there is something to make a submission of. */
async function someChanges(ws: Workspace) {
  await ws.select(ERIKA)
  ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
  ws.create('place', 'Alte Fähre')
}

describe('starting', () => {
  it('loads the database and the submissions once somebody is signed in; changes can be made at once', async () => {
    const ws = await started()
    expect(ws.user?.login).toBe('anna')
    expect(ws.entries).toHaveLength(7)
    expect(ws.submissions.map((c) => [c.name, c.author, c.state])).toEqual([['Feuerwehr Texte', 'bernd', 'submitted']])
    expect(ws.branch).toBeUndefined()
    expect(ws.editable).toBe(true)
    expect(ws.changes).toEqual([])
  })

  it('stays at the sign-in when nobody is', async () => {
    const api = new FakeApi()
    api.me = async () => null
    const ws = await started(api)
    expect(ws.user).toBeNull()
    expect(ws.entries).toEqual([])
    expect(ws.editable).toBe(false)
  })
})

describe('the changes', () => {
  it('are the difference to the base: what was made, changed and deleted; the server gets to know when the entry is finished', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    await someChanges(ws)
    expect(ws.changes).toEqual([]) // typed, not finished: no change, nothing at the server
    expect((await api.submissions()).length).toBe(1)
    await ws.select('entities/events/osterfeuer.yaml')
    expect(await ws.remove()).toBe(true) // deleting saves, with everything that is waiting
    expect(ws.changes.map((e) => [e.kind, e.entry.path])).toEqual([
      ['new', 'entities/places/alte-faehre.yaml'],
      ['changed', 'contents/traditionen/osterfeuer-tradition.yaml'], // the references to the deleted entry are taken out
      ['changed', ERIKA],
      ['changed', 'objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml'],
      ['removed', 'entities/events/osterfeuer.yaml'],
    ])
    expect(ws.entries.some((e) => e.path === 'entities/events/osterfeuer.yaml')).toBe(false)
    expect(ws.selected).toBeUndefined()
    expect(ws.dirty).toEqual([])
    expect(ws.draft).toMatchObject({ author: 'anna', state: 'draft' })
  })

  it('can be taken back one by one (each is saved): a new entry disappears, a changed one is as the base has it, a deleted one is back', async () => {
    const ws = await started()
    await someChanges(ws)
    await ws.select('entities/events/osterfeuer.yaml')
    await ws.remove()
    await ws.discard('entities/places/alte-faehre.yaml')
    await ws.discard(ERIKA)
    expect(ws.draft).toBeDefined()
    await ws.discard('entities/events/osterfeuer.yaml')
    expect(ws.changes).toEqual([])
    expect(ws.entries).toHaveLength(7)
    expect(titleOf(ws.entries.find((e) => e.path === ERIKA)!)).toBe('Erika Mustermann')
    expect(ws.draft).toBeUndefined() // nothing left to propose: the draft is closed
  })

  it('are made for the open entry again and again: revert takes back what was typed and not saved', async () => {
    const ws = await started()
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# x\n')
    expect(ws.dirty).toHaveLength(1)
    ws.revert()
    expect(ws.dirty).toHaveLength(0)
    ws.create('person', 'Neu')
    ws.revert()
    expect(ws.selected).toBeUndefined()
    expect(ws.entries).toHaveLength(7)
  })

  it('say what is wrong while it is wrong', async () => {
    const ws = await started()
    await ws.select(ERIKA)
    ws.edit('id: erika-mustermann\ntype: person\n')
    expect(ws.issues.map((i) => i.message)).toEqual(['missing field "name"'])
    expect([...ws.problems.keys()]).toEqual([]) // only what is saved in the draft counts as unfinished
    expect(await ws.finish()).toBe(true) // and it can be saved
    expect(ws.problems.get(ERIKA)).toEqual(['Name fehlt'])
    expect(ws.unfinished.map((u) => u.entry.path)).toEqual([ERIKA])
  })

  it('make entries in a folder with a parent, numbered when the id is in use', async () => {
    const ws = await started()
    ws.create('place', 'Haus', 'gummern', { parent: 'gummern', kind: 'building', numbered: true })
    expect(ws.selected?.path).toBe('entities/places/gummern/haus.yaml')
    ws.create('place', 'Haus', 'gummern', { parent: 'gummern', kind: 'building', numbered: true })
    expect(ws.selected?.path).toBe('entities/places/gummern/haus-2.yaml')
    expect(ws.selected?.text).toContain('parent: gummern')
  })

  it('cannot make an entry with an id that is in use', async () => {
    const ws = await started()
    expect(() => ws.create('person', 'Erika Mustermann')).toThrow(/schon einen Eintrag/)
  })

  it('stay when the entries are loaded again (what is typed is not lost to news)', async () => {
    const ws = await started()
    await someChanges(ws)
    await ws.load()
    expect(ws.dirty.map((e) => e.path).sort()).toEqual([ERIKA, 'entities/places/alte-faehre.yaml'])
    expect(ws.changes).toEqual([])
  })
})

describe('the draft', () => {
  it('is made with the first thing that is finished, named after the day, and every finish is a commit on it', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    expect(ws.draft).toBeUndefined()
    ws.create('place', 'Alte Fähre')
    expect(await ws.finish()).toBe(true)
    expect(ws.draft).toMatchObject({ name: defaultName(), author: 'anna', state: 'draft' })
    const branch = ws.draft!.branch
    expect((await api.entries(branch)).entries.map((e) => e.path)).toContain('entities/places/alte-faehre.yaml')
    // the base has nothing of it
    expect((await api.entries()).entries.map((e) => e.path)).not.toContain('entities/places/alte-faehre.yaml')
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# x\n')
    expect(ws.changes.map((c) => c.kind)).toEqual(['new'])
    expect(await ws.finish()).toBe(true)
    expect(ws.submissions.filter((c) => c.author === 'anna')).toHaveLength(1)
    expect((await api.entries(branch)).entries.find((e) => e.path === ERIKA)!.text).toContain('# x')
    expect(ws.changes.map((c) => c.kind)).toEqual(['new', 'changed'])
  })

  it('has the name the person gave it before it was made, and can be renamed afterwards', async () => {
    const ws = await started()
    await ws.rename('  Fest   am Elbufer ')
    expect(ws.draft).toBeUndefined() // nothing to name yet
    ws.create('place', 'Alte Fähre')
    await ws.finish()
    expect(ws.draft?.name).toBe('Fest am Elbufer')
    await ws.rename('Elbfest')
    expect(ws.draft?.name).toBe('Elbfest')
    expect(ws.submissions.find((c) => c.author === 'anna')?.name).toBe('Elbfest')
  })

  it('is not written while its YAML is broken, and the entry is opened', async () => {
    const ws = await started()
    await ws.select(ERIKA)
    ws.edit('id: [erika-mustermann\ntype: person\n')
    await ws.select(undefined)
    expect(await ws.finish()).toBe(false)
    expect(ws.error).toMatch(/kaputt/)
    expect(ws.selectedPath).toBe(ERIKA)
    expect(ws.draft).toBeUndefined()
  })

  it('shows what the server refused with, and keeps what was typed', async () => {
    const api = new FakeApi()
    api.commit = async () => {
      throw new ApiError('Der Eintrag ist nicht gültig.', 422, [{ path: '/name', message: 'zu kurz' }])
    }
    const ws = await started(api)
    await someChanges(ws)
    expect(await ws.finish()).toBe(false)
    expect(ws.refused).toEqual([{ path: '/name', message: 'zu kurz' }])
    expect(ws.dirty.length).toBe(2)
  })

  it('is proposed: it is not a draft any more, and it stays the one that is worked on', async () => {
    const ws = await started()
    await someChanges(ws)
    expect(await ws.submit()).toBe(true)
    const submitted = ws.submissions.find((c) => c.author === 'anna')!
    expect(submitted.state).toBe('submitted')
    expect(ws.draft).toBeUndefined()
    expect(ws.active).toMatchObject({ number: submitted.number, state: 'submitted' })
    expect(ws.dirty).toEqual([])
    // the base does not have it before it is accepted: it is still a change against it
    expect(ws.changes).toHaveLength(2)
    // and the person can get back to the base
    await ws.switchTo(undefined)
    expect(ws.changes).toEqual([])
    expect(titleOf(ws.entries.find((e) => e.path === ERIKA)!)).toBe('Erika Mustermann')
  })

  it('sees what was done to it elsewhere', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    await someChanges(ws)
    await ws.finish()
    const own = ws.draft!
    await api.commit([{ path: 'entities/places/zweite-faehre.yaml', text: 'id: zweite-faehre\ntype: place\nname: Zweite Fähre\n' }], [], { branch: own.branch, name: own.name })
    await ws.news({ type: 'pull', number: own.number })
    expect(ws.entries.map((e) => e.path)).toContain('entities/places/zweite-faehre.yaml')
    await api.submit(own.number)
    await ws.news({ type: 'pull', number: own.number })
    // It is handed in now, but it is still the one worked on (anybody may change it until it is accepted).
    expect(ws.draft).toBeUndefined()
    expect(ws.active?.state).toBe('submitted')
    expect(ws.editable).toBe(true)
    expect(ws.entries.map((e) => e.path)).toContain('entities/places/alte-faehre.yaml')
  })

  it('ends at the sign-in when the session is over', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    api.index = async () => {
      throw new SignedOut()
    }
    await ws.load()
    expect(ws.user).toBeNull()
    expect(ws.branch).toBeUndefined()
  })
})

describe('switching to another submission', () => {
  const BERND = 'submission/bernd/feuerwehr-texte'
  const FEUERWEHR = 'entities/organizations/feuerwehr-schnackenburg.yaml'

  it('works without asking when nothing is unsaved, and anybody may change what is there', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    expect(await ws.switchTo(BERND)).toBe(true)
    expect(ws.editable).toBe(true)
    await ws.ensure([FEUERWEHR])
    expect(ws.entries.find((e) => e.path === FEUERWEHR)!.text).toContain('e. V.')
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# fixed\n')
    expect(await ws.finish()).toBe(true)
    // It went to bernd's branch, and the submission is still his.
    expect((await api.entries(BERND)).entries.find((e) => e.path === ERIKA)!.text).toContain('# fixed')
    expect(ws.active).toMatchObject({ branch: BERND, author: 'bernd' })
    expect(ws.submissions.filter((c) => c.author === 'anna')).toEqual([])
  })

  it('asks first about what is unsaved, and stays where it is if the person does not want to switch', async () => {
    const ws = await started()
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# open\n')
    expect(await ws.switchTo(BERND)).toBe(false)
    expect(ws.switching).toEqual({ branch: BERND })
    await ws.answerSwitch('stay')
    expect(ws.switching).toBeUndefined()
    expect(ws.branch).toBeUndefined()
    expect(ws.dirty).toHaveLength(1)
  })

  it('throws away what is unsaved when the person says so', async () => {
    const ws = await started()
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# open\n')
    await ws.switchTo(BERND)
    await ws.answerSwitch('discard')
    expect(ws.branch).toBe(BERND)
    expect(ws.dirty).toHaveLength(0)
    await ws.ensure([ERIKA])
    expect(ws.entries.find((e) => e.path === ERIKA)!.text).not.toContain('# open')
  })

  it('saves what is unsaved to the branch that was worked on, and then switches', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# kept\n')
    await ws.switchTo(BERND)
    await ws.answerSwitch('save')
    expect(ws.branch).toBe(BERND)
    const mine = ws.submissions.find((c) => c.author === 'anna')!
    expect((await api.entries(mine.branch)).entries.find((e) => e.path === ERIKA)!.text).toContain('# kept')
    expect(ws.dirty).toHaveLength(0)
  })

  it('does not ask about a new entry that still has only its placeholder', async () => {
    const ws = await started()
    ws.create('event', 'Neu', 'ereignisse', { numbered: true, placeholder: true })
    expect(await ws.switchTo(BERND)).toBe(true)
  })

  it('keeps several drafts apart: a new draft starts from the base, the other one stays as it was', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    await someChanges(ws)
    await ws.finish()
    const first = ws.active!
    await ws.switchTo(undefined)
    expect(ws.branch).toBeUndefined()
    expect(ws.entries.map((e) => e.path)).not.toContain('entities/places/alte-faehre.yaml')
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.finish()
    const second = ws.active!
    expect(second.branch).not.toBe(first.branch)
    expect(ws.submissions.filter((c) => c.author === 'anna' && c.state === 'draft')).toHaveLength(2)
    await ws.switchTo(first.branch)
    expect(ws.entries.map((e) => e.path)).toContain('entities/places/alte-faehre.yaml')
  })

  it('comes back to the newest own draft when the page is opened again', async () => {
    const api = new FakeApi()
    const first = await started(api)
    await someChanges(first)
    await first.finish()
    const again = await started(api)
    expect(again.branch).toBe(first.branch)
    expect(again.entries.map((e) => e.path)).toContain('entities/places/alte-faehre.yaml')
  })
})

describe('a submission that is accepted', () => {
  it('is in the database after that', async () => {
    const ws = await started()
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text.replace('Erika Mustermann', 'Erika M.'))
    await ws.submit()
    const mine = ws.submissions.find((c) => c.author === 'anna')!
    await ws.review.select(mine.number)
    expect(await ws.review.act('merge')).toBe(true)
    expect(ws.branch).toBeUndefined()
    expect(titleOf(ws.entries.find((e) => e.path === ERIKA)!)).toBe('Erika M.')
    expect(ws.submissions.find((c) => c.number === mine.number)?.state).toBe('merged')
  })

  it('is noticed when it was accepted elsewhere', async () => {
    const api = new FakeApi()
    const ws = await started(api)
    await api.merge(1)
    await ws.news({ type: 'push' })
    expect(ws.submissions[0].state).toBe('merged')
    await ws.ensure(['entities/organizations/feuerwehr-schnackenburg.yaml'])
    expect(ws.entries.find((e) => e.path === 'entities/organizations/feuerwehr-schnackenburg.yaml')!.text).toContain('e. V.')
  })
})

describe('news', () => {
  it('are listened to: what changed is asked for again', async () => {
    const api = new FakeApi()
    const ws = new Workspace(api)
    await ws.start()
    expect(ws.liveOpen).toBe(true)
    await api.close(1)
    await vi.waitFor(() => expect(ws.submissions[0].state).toBe('closed'))
    ws.stopLive()
    expect(ws.liveOpen).toBe(false)
  })

  it('are asked for now and then while the live connection is not there', async () => {
    vi.useFakeTimers()
    try {
      const api = new FakeApi()
      api.listen = () => ({ stop: () => undefined, nudge: () => undefined })
      const ws = new Workspace(api)
      await ws.start()
      const submissions = vi.spyOn(api, 'submissions')
      await vi.advanceTimersByTimeAsync(POLL_MS)
      expect(submissions).toHaveBeenCalledTimes(1)
      ws.stopLive()
      await vi.advanceTimersByTimeAsync(POLL_MS * 2)
      expect(submissions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('saving in the background', () => {
  /** An api whose commits wait for the test to let them go (or fail), and that tells how often entries were asked for. */
  class Slow extends FakeApi {
    release: (() => void)[] = []
    failing = false
    asked: (string | undefined)[] = []
    async commit(...args: Parameters<FakeApi['commit']>) {
      await new Promise<void>((resolve) => this.release.push(resolve))
      if (this.failing) throw new ApiError('Der Server ist nicht erreichbar.', 502)
      return { ...(await super.commit(...args)), commit: 'abc' }
    }
    async index(branch?: string) {
      this.asked.push(branch)
      return super.index(branch)
    }
  }

  it('counts as saved at once: the editor is up to date while the commit is on its way', async () => {
    const api = new Slow()
    const ws = await started(api)
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# note\n')
    expect(await ws.finish(undefined, { wait: false })).toBe(true)
    expect(ws.dirty).toEqual([])
    expect(ws.changes).toHaveLength(1)
    expect(ws.saving).toBe(true)
    expect((await api.entries(ws.branch)).entries.find((e) => e.path === ERIKA)!.text).not.toContain('# note')
    api.release.shift()!()
    expect(await ws.sync()).toBe(true) // waits for what is on its way
    expect(ws.saving).toBe(false)
    expect((await api.entries(ws.branch)).entries.find((e) => e.path === ERIKA)!.text).toContain('# note')
  })

  it('takes it back when the commit fails: the entry is unsaved again, and the error is shown', async () => {
    const api = new Slow()
    const ws = await started(api)
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# note\n')
    await ws.finish(undefined, { wait: false })
    api.failing = true
    api.release.shift()!()
    await vi.waitFor(() => expect(ws.saving).toBe(false))
    expect(ws.error).toMatch(/nicht erreichbar/)
    expect(ws.dirty.map((e) => e.path)).toEqual([ERIKA])
    expect(ws.changes).toEqual([])
    // and saving once more works
    api.failing = false
    const again = ws.finish()
    await vi.waitFor(() => expect(api.release).toHaveLength(1))
    api.release.shift()!()
    expect(await again).toBe(true)
    expect(ws.dirty).toEqual([])
  })

  it('ignores the news about its own commits, and asks for the base only when it changed', async () => {
    const api = new Slow()
    const ws = await started(api)
    await ws.select(ERIKA)
    ws.edit(ws.selected!.text + '# note\n')
    const done = ws.finish()
    await vi.waitFor(() => expect(api.release).toHaveLength(1))
    api.release.shift()!()
    await done
    const branch = ws.branch!
    api.asked = []
    await ws.news({ type: 'pull', branch, head: 'abc' })
    expect(api.asked).toEqual([]) // its own commit
    await ws.news({ type: 'pull', branch, head: 'other' })
    expect(api.asked).toEqual([branch]) // somebody else's change to the submission: the base is as it was
    api.asked = []
    await ws.news({ type: 'push' })
    expect(api.asked.sort()).toEqual([undefined, branch].sort())
  })
})

describe('entries that are known from the index only', () => {
  const BERND = 'submission/bernd/feuerwehr-texte'
  const FEUERWEHR = 'entities/organizations/feuerwehr-schnackenburg.yaml'

  /** An api that tells which entries were read, and in how many requests. */
  class Reading extends FakeApi {
    asked: string[] = []
    requests = 0
    async read(paths: string[], branch?: string) {
      this.requests++
      this.asked.push(...paths)
      return super.read(paths, branch)
    }
  }

  it('are listed with their titles, but not read until they are opened', async () => {
    const api = new Reading()
    const ws = await started(api)
    expect(ws.entries.every((e) => e.unloaded)).toBe(true)
    expect(titleOf(ws.entries.find((e) => e.path === ERIKA)!)).toBe('Erika Mustermann')
    expect(ws.dirty).toEqual([])
    expect(ws.changes).toEqual([])
    expect(api.asked).toEqual([])
    await ws.select(ERIKA)
    expect(api.asked).toEqual([ERIKA])
    expect(ws.selected?.unloaded).toBeUndefined()
    expect(ws.selected?.text).toContain('Erika Mustermann')
    expect(ws.dirty).toEqual([])
  })

  it('are read once: opening an entry again, or on another visit, asks for nothing', async () => {
    const api = new Reading()
    const ws = await started(api)
    await ws.select(ERIKA)
    await ws.select(undefined)
    await ws.select(ERIKA)
    expect(api.asked).toEqual([ERIKA])
  })

  it('show what a submission changed without being read: the version tells', async () => {
    const api = new Reading()
    const ws = await started(api)
    await ws.switchTo(BERND)
    expect(ws.changes.map((c) => [c.kind, c.entry.path])).toEqual([['changed', FEUERWEHR]])
    expect(api.asked).toEqual([])
  })

  it('are read with what the base has of them, so that a change can be taken back', async () => {
    const api = new Reading()
    const ws = await started(api)
    await ws.switchTo(BERND)
    await ws.select(FEUERWEHR)
    expect(api.asked.sort()).toEqual([FEUERWEHR, FEUERWEHR])
    await ws.discard(FEUERWEHR)
    expect(ws.changes).toEqual([])
    expect(ws.entries.find((e) => e.path === FEUERWEHR)!.text).not.toContain('e. V.')
  })

  it('deleting an entry reads the entries that refer to it, and takes the references out', async () => {
    const api = new Reading()
    const ws = await started(api)
    await ws.select('entities/events/osterfeuer.yaml')
    expect(ws.referencesTo('entities/events/osterfeuer.yaml')).toBeGreaterThan(0)
    expect(await ws.remove()).toBe(true)
    const read = ws.entries.filter((e) => !e.unloaded).map((e) => e.path)
    expect(read).toContain('contents/traditionen/osterfeuer-tradition.yaml')
    expect(ws.entries.find((e) => e.path === 'contents/traditionen/osterfeuer-tradition.yaml')!.data?.about).not.toContain('osterfeuer')
    expect(api.requests).toBeLessThanOrEqual(2) // the entries that refer to it are read together, not one by one
  })
})

describe('the copy of all texts on this computer', () => {
  const settle = () => new Promise((r) => setTimeout(r, 50))

  it('is filled from the bundle (one download), and what it has is not asked for again', async () => {
    class Counting extends FakeApi {
      bundles = 0
      requests = 0
      async bundle() {
        this.bundles++
        return super.bundle()
      }
      async read(paths: string[], branch?: string) {
        this.requests++
        return super.read(paths, branch)
      }
    }
    const api = new Counting()
    const texts = new MemoryTextStore()
    const ws = await started(api, true, texts)
    await settle()
    expect((await texts.keys()).size).toBe(ws.entries.length)
    expect(api.requests).toBe(0)
    await ws.select(ERIKA)
    expect(api.requests).toBe(0)
    expect(ws.selected?.text).toContain('Erika Mustermann')
  })

  it('reads in blocks when there is no bundle', async () => {
    class NoBundle extends FakeApi {
      async bundle() {
        return null
      }
    }
    const texts = new MemoryTextStore()
    const ws = await started(new NoBundle(), true, texts)
    await settle()
    expect((await texts.keys()).size).toBe(ws.entries.length)
  })
})

describe('somebody else changes an entry on the branch while it is being typed in', () => {
  async function setup() {
    const api = new FakeApi()
    const ws = await started(api)
    await someChanges(ws)
    expect(await ws.finish()).toBe(true)
    const branch = ws.branch!
    await ws.select(ERIKA)
    return { api, ws, branch }
  }
  const theirs = async (api: FakeApi, branch: string, change: (text: string) => string) => {
    const remote = (await api.entry(ERIKA, branch))!
    await api.save(ERIKA, change(remote.text), remote.sha, { branch, name: 'x' })
  }

  it('is merged field by field: what they changed is taken, what was typed stays', async () => {
    const { api, ws, branch } = await setup()
    ws.edit(`${ws.selected!.text.trimEnd()}\ndescription: von mir\n`)
    await theirs(api, branch, (text) => text.replace('Erika M.', 'Erika Maria'))
    await ws.load({ quiet: true })
    expect(ws.selected!.text).toContain('description: von mir')
    expect(ws.selected!.text).toContain('Erika Maria')
    expect(ws.dirty.map((e) => e.path)).toEqual([ERIKA]) // the typed part is still to be saved
    expect(ws.chat.at(-1)?.text).toContain('zusammengeführt')
  })

  it('keeps the typed value of a field that both changed, and says what the other had', async () => {
    const { api, ws, branch } = await setup()
    ws.edit(ws.selected!.text.replace('Erika M.', 'Erika Muster'))
    await theirs(api, branch, (text) => text.replace('Erika M.', 'Erika Maria'))
    await ws.load({ quiet: true })
    expect(ws.selected!.text).toContain('name: Erika Muster')
    expect(ws.chat.at(-1)?.text).toContain('Erika Maria')
  })
})
