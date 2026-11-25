// The index of the data repository for the editor (see core/src/index-build.ts): CI keeps one on the branch `index`; what is newer
// than it is added here, so the answer is never behind the base branch. A submission is the index of the base branch plus what its
// branch changes. Without an index (CI has not run yet) or with too many changes, everything is read and indexed once.

import { buildIndex, indexEntry, isStoredPath, type IndexEntry, type RepoIndex } from '@contents-editor/core'
import { Refused, headOf, readBlobs, readEntries } from './common.js'
import { call, raw } from './github.js'
import { Repo, type ChangedFile } from './repository.js'

export const INDEX_BRANCH = 'index'
const INDEX_FILE = 'index.json'
const BUNDLE_FILE = 'entries.ndjson.gz'

export interface IndexAnswer {
  /** The commit of the base branch the entries are as of. */
  commit: string
  /** The commit the entries of a submission are as of (the base commit for the base branch). */
  head: string
  entries: IndexEntry[]
}

/** The sha of a file on the branch `index`, or null if there is none. */
async function indexFile(token: string, repo: string, name: string, fetchFn: typeof fetch): Promise<string | null> {
  if (!(await headOf(token, repo, INDEX_BRANCH, fetchFn))) return null
  const tree = await call<{ tree: { path: string; type: string; sha: string }[] }>(fetchFn, token, 'GET', `/repos/${repo}/git/trees/${INDEX_BRANCH}`)
  return tree.tree.find((node) => node.type === 'blob' && node.path === name)?.sha ?? null
}

/** The bundle of the texts of all entries that CI made (gzip, passed on as it is), or null if there is none (yet). */
export async function readBundle(token: string, repo: string, fetchFn: typeof fetch): Promise<Response | null> {
  const sha = await indexFile(token, repo, BUNDLE_FILE, fetchFn)
  if (!sha) return null
  const upstream = await raw(fetchFn, token, `/repos/${repo}/git/blobs/${sha}`)
  return new Response(upstream.body, { headers: { 'content-type': 'application/gzip', 'cache-control': 'private, no-store' } })
}

/** The index CI made, or null if there is none (yet) or it is not one we can read. */
async function storedIndex(token: string, repo: string, fetchFn: typeof fetch): Promise<RepoIndex | null> {
  const sha = await indexFile(token, repo, INDEX_FILE, fetchFn)
  if (!sha) return null
  // The blob API (not the contents API) because the index may be larger than the contents API delivers.
  const blob = await call<{ content: string; encoding: string }>(fetchFn, token, 'GET', `/repos/${repo}/git/blobs/${sha}`)
  if (blob.encoding !== 'base64') return null
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(blob.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)))
    const data = JSON.parse(text) as Partial<RepoIndex>
    return data.version === 1 && typeof data.commit === 'string' && Array.isArray(data.entries) ? (data as RepoIndex) : null
  } catch {
    return null
  }
}

/** The entries with the changed files applied; the texts of the files that are there are read at `ref`. */
async function applied(token: string, repo: string, entries: IndexEntry[], files: ChangedFile[], ref: string, fetchFn: typeof fetch): Promise<IndexEntry[]> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const read: string[] = []
  for (const file of files) {
    if (file.previous_filename) byPath.delete(file.previous_filename)
    if (!isStoredPath(file.filename)) continue
    if (file.status === 'removed') byPath.delete(file.filename)
    else read.push(file.filename)
  }
  const blobs = await readBlobs(token, repo, read.map((path) => `${ref}:${path}`), fetchFn)
  read.forEach((path, i) => {
    const entry = blobs[i] ? indexEntry({ path, text: blobs[i]!.text }, blobs[i]!.oid) : undefined
    if (entry) byPath.set(path, entry)
    else byPath.delete(path)
  })
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Everything read and indexed: the way if there is no index to continue from. */
async function indexed(token: string, repo: string, commit: string, fetchFn: typeof fetch): Promise<IndexEntry[]> {
  const entries = await readEntries(token, repo, commit, fetchFn)
  const shas = new Map(entries.map((e) => [e.text, e.sha]))
  return buildIndex(entries.map((e) => ({ path: e.path, text: e.text })), commit, (text) => shas.get(text) ?? '').entries
}

/** The index of the base branch as of its newest commit. */
async function baseIndex(token: string, repo: string, base: string, fetchFn: typeof fetch): Promise<{ commit: string; entries: IndexEntry[] }> {
  const repository = new Repo(token, repo, base, fetchFn)
  const head = await headOf(token, repo, base, fetchFn)
  if (!head) throw new Refused(`The base branch "${base}" does not exist (is the repository empty?).`, 409)
  const stored = await storedIndex(token, repo, fetchFn)
  if (stored) {
    const since = stored.commit === head ? { head, files: [] } : await repository.changes(stored.commit)
    if (since) return { commit: since.head, entries: await applied(token, repo, stored.entries, since.files, since.head, fetchFn) }
  }
  return { commit: head, entries: await indexed(token, repo, head, fetchFn) }
}

/** The index of the base branch, or (with `branch`) of the base branch with the changes of that submission. A branch that is not there (yet) is the base. */
export async function readIndex(token: string, repo: string, base: string, branch: string | undefined, fetchFn: typeof fetch): Promise<IndexAnswer & { exists: boolean }> {
  const main = await baseIndex(token, repo, base, fetchFn)
  const head = branch === undefined ? undefined : await headOf(token, repo, branch, fetchFn)
  if (!head) return { ...main, head: main.commit, exists: false }
  const found = await new Repo(token, repo, base, fetchFn).compare(main.commit, head)
  const entries = found ? await applied(token, repo, main.entries, found.files, head, fetchFn) : await indexed(token, repo, head, fetchFn)
  return { commit: main.commit, head, entries, exists: true }
}

/** Many entries at once (a few requests of 100): from the submission's branch where it has the file, else from the base branch. What is not there is left out. */
export async function readMany(token: string, repo: string, base: string, branch: string | undefined, paths: string[], fetchFn: typeof fetch): Promise<{ path: string; sha: string; text: string }[]> {
  const found = new Map<string, { path: string; sha: string; text: string }>()
  for (const ref of branch ? [branch, base] : [base]) {
    const missing = paths.filter((p) => !found.has(p))
    if (missing.length === 0) break
    const blobs = await readBlobs(token, repo, missing.map((p) => `${ref}:${p}`), fetchFn)
    missing.forEach((path, i) => {
      const blob = blobs[i]
      if (blob) found.set(path, { path, sha: blob.oid, text: blob.text })
    })
  }
  return paths.flatMap((p) => found.get(p) ?? [])
}

/** One entry's text and sha: from the submission's branch if it has the file, else from the base branch. */
export async function readOne(token: string, repo: string, base: string, branch: string | undefined, path: string, fetchFn: typeof fetch): Promise<{ path: string; sha: string; text: string } | null> {
  for (const ref of branch ? [branch, base] : [base]) {
    const [blob] = await readBlobs(token, repo, [`${ref}:${path}`], fetchFn)
    if (blob) return { path, sha: blob.oid, text: blob.text }
  }
  return null
}
