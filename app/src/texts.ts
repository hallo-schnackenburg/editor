// The texts of entries kept on this computer, each under its version (the sha of its file): a version never changes, so what is kept
// is never out of date, and the editor needs to read from the server only what it has not got. Filled in the background from the
// bundle of CI and by reading what is missing (workspace.svelte.ts).

export interface TextStore {
  /** The versions that are kept. */
  keys(): Promise<Set<string>>
  /** The texts of those of the versions that are kept. */
  get(shas: string[]): Promise<Map<string, string>>
  put(items: { sha: string; text: string }[]): Promise<void>
  clear(): Promise<void>
}

export class MemoryTextStore implements TextStore {
  readonly #texts = new Map<string, string>()

  async keys(): Promise<Set<string>> {
    return new Set(this.#texts.keys())
  }

  async get(shas: string[]): Promise<Map<string, string>> {
    return new Map(shas.flatMap((sha) => (this.#texts.has(sha) ? [[sha, this.#texts.get(sha)!] as const] : [])))
  }

  async put(items: { sha: string; text: string }[]): Promise<void> {
    for (const { sha, text } of items) this.#texts.set(sha, text)
  }

  async clear(): Promise<void> {
    this.#texts.clear()
  }
}

const DB = 'contents-editor-texts'
const STORE = 'texts'

/** The texts in the browser's IndexedDB, one record for each version. */
export class BrowserTextStore implements TextStore {
  #db: Promise<IDBDatabase> | undefined

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return this.#db
  }

  async #run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>[]): Promise<T[]> {
    const db = await this.#open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const requests = work(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(requests.map((r) => r.result))
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  }

  async keys(): Promise<Set<string>> {
    const [keys] = await this.#run<IDBValidKey[]>('readonly', (s) => [s.getAllKeys()])
    return new Set(keys.map(String))
  }

  async get(shas: string[]): Promise<Map<string, string>> {
    const found = await this.#run<unknown>('readonly', (s) => shas.map((sha) => s.get(sha)))
    return new Map(shas.flatMap((sha, i) => (typeof found[i] === 'string' ? [[sha, found[i] as string] as const] : [])))
  }

  async put(items: { sha: string; text: string }[]): Promise<void> {
    if (items.length > 0) await this.#run('readwrite', (s) => items.map(({ sha, text }) => s.put(text, sha)))
  }

  async clear(): Promise<void> {
    await this.#run('readwrite', (s) => [s.clear()])
  }
}

/** The store of the browser if it has one, else one that forgets with the page. */
export const defaultTextStore = (): TextStore => (typeof indexedDB === 'undefined' ? new MemoryTextStore() : new BrowserTextStore())
