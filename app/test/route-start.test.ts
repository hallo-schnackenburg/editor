import { describe, expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import type { Route } from '../src/route.js'
import { Workspace } from '../src/workspace.svelte.js'

const BERND = 'submission/bernd/feuerwehr-texte'
const FEUERWEHR = 'entities/organizations/feuerwehr-schnackenburg.yaml'

async function startedAt(route: Route | undefined) {
  const ws = new Workspace(new FakeApi())
  ws.route = route
  await ws.start()
  ws.stopLive()
  return ws
}

describe('starting at an address', () => {
  it('shows the details of the submission it names', async () => {
    const ws = await startedAt({ submission: 1, view: 'details', focus: FEUERWEHR })
    expect(ws.branch).toBe(BERND)
    expect(ws.review.detailOpen).toBe(true)
    expect(ws.review.focus).toBe(FEUERWEHR)
    expect(ws.started).toBe(true)
  })

  it('opens the entry it names, in the submission or in the database', async () => {
    const inSubmission = await startedAt({ submission: 1, view: 'entry', path: FEUERWEHR })
    expect(inSubmission.branch).toBe(BERND)
    expect(inSubmission.selectedPath).toBe(FEUERWEHR)
    expect(inSubmission.review.detailOpen).toBe(false)
    const inDatabase = await startedAt({ view: 'entry', path: FEUERWEHR })
    expect(inDatabase.branch).toBeUndefined()
    expect(inDatabase.selectedPath).toBe(FEUERWEHR)
  })

  it('is the database for "#/", and takes the submission that is not there as none', async () => {
    expect((await startedAt({ view: 'none' })).branch).toBeUndefined()
    const gone = await startedAt({ submission: 99, view: 'details' })
    expect(gone.branch).toBeUndefined()
    expect(gone.review.detailOpen).toBe(false)
  })
})
