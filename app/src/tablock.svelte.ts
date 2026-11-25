// Only one tab works on the browser's data at a time. Two tabs would each keep their own copy in memory, write to the same
// storage and save to the same branch: they would overwrite each other and run into their own conflicts. The first tab holds
// a lock (Web Locks API); any other tab says so and offers to take over.

const LOCK = 'contents-editor-workspace'

type Locks = Pick<LockManager, 'request'>

export class TabLock {
  /** `checking` until the answer is there; `owner` works; `other` waits because another tab is working. */
  state = $state<'checking' | 'owner' | 'other'>('checking')
  #locks: Locks | undefined
  #reload: () => void

  constructor(locks: Locks | undefined = typeof navigator === 'undefined' ? undefined : navigator.locks, reload: () => void = () => location.reload()) {
    this.#locks = locks
    this.#reload = reload
  }

  /** Tries to become the working tab. Without the Web Locks API (old browsers) every tab works, as before. */
  start() {
    if (!this.#locks) {
      this.state = 'owner'
      return
    }
    this.#locks
      .request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          this.state = 'other'
          return
        }
        this.state = 'owner'
        return new Promise<void>(() => {}) // held until the tab is closed (or the lock is taken)
      })
      // The lock was taken by another tab: this one stops working.
      .catch(() => (this.state = 'other'))
  }

  /** Takes over from the other tab, which stops working. The page is loaded anew, so that it starts from what the other tab stored. */
  take() {
    if (!this.#locks) return
    void this.#locks
      .request(LOCK, { steal: true }, () => {
        this.state = 'owner'
        this.#reload()
        return new Promise<void>(() => {})
      })
      .catch(() => {})
  }
}
