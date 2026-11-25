import { describe, expect, it } from 'vitest'
import { TabLock } from '../src/tablock.svelte.js'

/** A browser's lock manager, as far as the app uses it: one holder per name, `ifAvailable` and `steal`. */
function manager() {
  let holder: { reject: (reason: unknown) => void } | undefined
  const request = ((name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => unknown) => {
    if (holder && options.ifAvailable) return Promise.resolve(callback(null))
    const previous = holder
    return new Promise((resolve, reject) => {
      holder = { reject }
      previous?.reject(new DOMException('stolen', 'AbortError'))
      Promise.resolve(callback({ name })).then(resolve, reject)
    })
  }) as LockManager['request']
  return { request }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the tab lock', () => {
  it('lets the first tab work and holds the others back', async () => {
    const locks = manager()
    const first = new TabLock(locks, () => {})
    const second = new TabLock(locks, () => {})
    first.start()
    second.start()
    await settle()
    expect([first.state, second.state]).toEqual(['owner', 'other'])
  })

  it('hands over to the tab that takes it, which loads anew; the other one stops', async () => {
    const locks = manager()
    let reloaded = 0
    const first = new TabLock(locks, () => {})
    const second = new TabLock(locks, () => reloaded++)
    first.start()
    second.start()
    await settle()
    second.take()
    await settle()
    expect(first.state).toBe('other')
    expect(second.state).toBe('owner')
    expect(reloaded).toBe(1)
  })

  it('lets every tab work where the browser has no locks', () => {
    const tab = new TabLock(undefined, () => {})
    tab.start()
    expect(tab.state).toBe('owner')
  })
})
