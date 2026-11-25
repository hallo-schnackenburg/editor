import { describe, expect, it } from 'vitest'
import { FakeApi } from '../src/fake.js'
import { Workspace } from '../src/workspace.svelte.js'

async function started() {
  const ws = new Workspace(new FakeApi())
  await ws.start()
  ws.stopLive()
  return ws
}

describe('making a topic', () => {
  it('writes its .folder.yaml to the draft at once, and the topic has its name', async () => {
    const ws = await started()
    expect(ws.draft).toBeUndefined()
    const folder = await ws.createTopic('  Natur &  Umwelt ')
    expect(folder).toBe('contents/natur-umwelt')
    expect(ws.folders[folder]).toBe('Natur & Umwelt') // there at once
    expect(ws.changes.map((c) => c.topic)).toEqual([true])
    await ws.sync() // waits for the write that follows in the background
    expect(ws.draft).toBeDefined() // the draft was made with it
    await ws.load({ quiet: true })
    expect(ws.folders[folder]).toBe('Natur & Umwelt') // and it is what the branch has
  })

  it('is taken back when the write fails', async () => {
    const api = new FakeApi()
    const ws = new Workspace(api)
    await ws.start()
    ws.stopLive()
    api.commit = async () => {
      throw new Error('Der Server ist nicht erreichbar.')
    }
    const folder = await ws.createTopic('Kunst')
    expect(ws.folders[folder]).toBe('Kunst')
    await ws.sync()
    expect(ws.folders[folder]).toBeUndefined()
    expect(ws.error).toMatch(/nicht erreichbar/)
  })

  it('refuses a name that is no folder name and a topic that is there', async () => {
    const ws = await started()
    await expect(ws.createTopic('???')).rejects.toThrow(/gültigen Ordnernamen/)
    const first = await ws.createTopic('Kunst')
    await expect(ws.createTopic('kunst')).rejects.toThrow(/gibt es schon/)
    expect(first).toBe('contents/kunst')
    const existing = ws.entries.find((e) => e.path.startsWith('contents/'))!.path.split('/')[1]
    await expect(ws.createTopic(existing)).rejects.toThrow(/gibt es schon/)
  })

  it('is saved to the submission of somebody else when that is the one worked on', async () => {
    const api = new FakeApi()
    const ws = new Workspace(api)
    await ws.start()
    ws.stopLive()
    const theirs = ws.submissions.find((s) => s.author !== ws.user!.login)!
    await ws.switchTo(theirs.branch)
    await ws.createTopic('Kunst')
    expect((await api.index(theirs.branch)).entries.map((e) => e.path)).toContain('contents/kunst/.folder.yaml')
    expect(ws.branch).toBe(theirs.branch)
  })
})

describe('a topic as a change', () => {
  it('is in the list of changes, can be taken back, and is not made twice under another spelling', async () => {
    const ws = await started()
    const folder = await ws.createTopic('Natur & Umwelt')
    expect(ws.changes.map((c) => [c.kind, c.entry.path, c.topic])).toEqual([['new', `${folder}/.folder.yaml`, true]])
    await expect(ws.createTopic('natur & umwelt')).rejects.toThrow(/gibt es schon/)
    await ws.discard(`${folder}/.folder.yaml`)
    expect(ws.folders[folder]).toBeUndefined()
    expect(ws.changes).toEqual([])
  })
})
