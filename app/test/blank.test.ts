import { expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { Workspace } from '../src/workspace.svelte.js'

it('starts a new entry with an empty name, and drops it again when nothing was typed', async () => {
  const ws = new Workspace(new FakeApi())
  await ws.start()
  ws.stopLive()
  ws.create('event', 'Neu: Ereignis', '', { numbered: true, placeholder: true })
  const path = ws.selectedPath!
  expect(ws.selected!.data?.name ?? '').toBe('')
  expect(ws.isUntouched(path)).toBe(true)
  await ws.select(undefined)
  expect(ws.entries.some((e) => e.path === path)).toBe(false)
})
