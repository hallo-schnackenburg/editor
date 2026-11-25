import { describe, expect, it, vi } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { Workspace } from '../src/workspace.svelte.js'

const ERIKA = 'entities/people/erika-mustermann.yaml'

async function started(api = new FakeApi()) {
  const ws = new Workspace(api)
  await ws.start()
  ws.stopLive()
  return { api, ws, review: ws.review }
}

/** Bernd has a draft called "Fest" that changes Erika. */
async function withDraft() {
  const s = await started()
  await s.ws.ensure([ERIKA])
  const text = s.ws.entries.find((e) => e.path === ERIKA)!.text.replace('Erika Mustermann', 'Erika M.')
  await s.api.commit([{ path: ERIKA, text }], [], { branch: 'submission/bernd/fest', name: 'Fest' })
  await s.ws.loadSubmissions()
  return { ...s, number: s.ws.submissions.find((c) => c.name === 'Fest')!.number }
}

describe('the list', () => {
  it('lists the own draft too', async () => {
    const { ws, review } = await started()
    ws.create('place', 'Alte Fähre')
    await ws.finish()
    expect(ws.draft).toBeDefined()
    expect(review.shown.map((c) => c.state).sort()).toEqual(['draft', 'submitted'])
  })

  it('does not list what was closed', async () => {
    const { api, ws, review } = await started()
    await api.close(1)
    await ws.loadSubmissions()
    expect(review.shown).toEqual([])
  })

  it('is one list of what can still be changed, the newest first', async () => {
    const { review } = await started()
    expect(review.shown.map((c) => c.name)).toEqual(['Feuerwehr Texte'])
  })

  it('follows the submissions that are started and accepted', async () => {
    const { review, number } = await withDraft()
    expect(review.shown).toHaveLength(2)
    await review.select(number)
    await review.act('submit')
    await review.act('merge')
    expect(review.shown.map((c) => c.name)).toEqual(['Feuerwehr Texte'])
  })
})

describe('looking at a submission', () => {
  it('loads what it does and its comments', async () => {
    const { review } = await started()
    await review.select(1)
    expect(review.detailState).toBe('ready')
    expect(review.detail?.items.map((i) => [i.path, i.kind])).toEqual([['entities/organizations/feuerwehr-schnackenburg.yaml', 'modified']])
    expect(review.detail?.checks).toBe('success')
    expect(review.blocked).toBeUndefined()
  })

  it('takes only the newest of several requests', async () => {
    const { api, review } = await started()
    const slow = api.submission.bind(api)
    api.submission = async (n) => {
      if (n === 1) await new Promise((r) => setTimeout(r, 20))
      return slow(n)
    }
    const first = review.select(1)
    await review.select(2).catch(() => undefined)
    await first
    expect(review.selected).toBe(2)
    expect(review.detail?.submission.number).not.toBe(1)
  })

  it('cannot be accepted while the check fails or an entry is not valid', async () => {
    const { api, review } = await started()
    const detail = await api.submission(1)
    api.submission = async () => ({ ...detail, checks: 'failure' })
    await review.select(1)
    expect(review.blocked).toMatch(/Prüfung ist fehlgeschlagen/)
    api.submission = async () => ({ ...detail, items: [{ path: 'entities/people/x.yaml', kind: 'added', after: 'id: x\ntype: person\n' }] })
    await review.select(1)
    expect(review.blocked).toMatch(/nicht gültig/)
    expect([...review.problems.keys()]).toEqual(['entities/people/x.yaml'])
  })
})

describe('doing something with a submission', () => {
  it('submits a draft, accepts it, and the database has it', async () => {
    const { ws, review, number } = await withDraft()
    await review.select(number)
    expect(await review.act('merge')).toBe(false) // still a draft
    expect(review.error).toMatch(/erst einreichen/)
    expect(await review.act('submit')).toBe(true)
    expect(review.submission?.state).toBe('submitted')
    expect(await review.act('merge')).toBe(true)
    expect(review.submission?.state).toBe('merged')
    expect(review.acting).toBeUndefined()
    await ws.ensure([ERIKA])
    expect(ws.entries.find((e) => e.path === ERIKA)!.text).toContain('Erika M.')
  })

  it('still shows what an accepted submission did', async () => {
    const { review, number } = await withDraft()
    await review.select(number)
    await review.act('submit')
    await review.act('merge')
    expect(review.detail?.items.map((i) => i.path)).toEqual([ERIKA])
  })

  it('closes a submission without taking it over', async () => {
    const { ws, review } = await started()
    await review.select(1)
    expect(await review.act('close')).toBe(true)
    expect(review.submission?.state).toBe('closed')
    expect(ws.entries.find((e) => e.path === 'entities/organizations/feuerwehr-schnackenburg.yaml')!.text).not.toContain('e. V.')
  })

  it('says what the server refused and looks at the list again', async () => {
    const { api, review } = await started()
    await review.select(1)
    await api.close(1) // somebody else was faster
    expect(await review.act('merge')).toBe(false)
    expect(review.error).toMatch(/abgeschlossen/)
    expect(review.submission?.state).toBe('closed')
  })
})

describe('renaming', () => {
  it('gives a draft another name, in the list and at the server; a finished one keeps its name', async () => {
    const { api, ws, review, number } = await withDraft()
    await review.select(number)
    expect(await review.rename('  Fest   2027 ')).toBe(true)
    expect(ws.submissions.find((c) => c.number === number)!.name).toBe('Fest 2027')
    expect((await api.submissions()).find((c) => c.number === number)!.name).toBe('Fest 2027')
    expect(await review.rename('   ')).toBe(false)
    await review.act('close')
    expect(await review.rename('Anders')).toBe(false)
    expect(review.error).toMatch(/abgeschlossen/)
    expect(ws.submissions.find((c) => c.number === number)!.name).toBe('Fest 2027')
  })
})

describe('comments', () => {
  it('are written and shown, and an empty one is not sent', async () => {
    const { api, review } = await started()
    await review.select(1)
    const send = vi.spyOn(api, 'comment')
    expect(await review.comment('   ')).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(await review.comment('Bitte prüfen.')).toBe(true)
    expect(review.comments.map((c) => c.body)).toEqual(['Bitte prüfen.'])
  })

  it('come with the news of a comment, for the submission that is open only', async () => {
    const { api, review } = await started()
    await review.select(1)
    const comments = vi.spyOn(api, 'comments')
    await review.news({ type: 'comment', number: 2 })
    expect(comments).not.toHaveBeenCalled()
    await api.comment(1, 'von bernd')
    await review.news({ type: 'comment', number: 1 })
    expect(review.comments.map((c) => c.body)).toEqual(['von bernd'])
  })
})
