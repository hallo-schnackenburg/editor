// What the routes of the data repository share: the answers, the refusals, reading a branch.

import { ENTRY_PATH, isStoredPath, type Issue } from '@editor/core'
import { GitHubError, call } from './github.js'

export { ENTRY_PATH }
export const MAX_ENTRIES = 3000
const CHUNK = 100
export const MAX_BODY = 400_000

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export class Refused extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly issues?: Issue[],
  ) {
    super(message)
  }
}

/** The answer to an error: what we refused, or what GitHub refused, or "not reachable". */
export function failure(error: unknown): Response {
  if (error instanceof Refused) return json({ error: error.message, ...(error.issues ? { issues: error.issues } : {}) }, error.status)
  if (error instanceof GitHubError) {
    // 409/422 from the contents API: somebody else changed the file (sha does not match). 405: a pull request that
    // cannot be merged (a check is missing, the branch changed). The editor shows the message and reloads.
    const status = error.status === 401 ? 401 : error.status === 404 ? 404 : error.status === 403 ? 403 : [405, 409, 422].includes(error.status) ? 409 : 502
    return json({ error: error.message }, status)
  }
  console.error('Repository error', (error as Error).message)
  return json({ error: 'The repository could not be reached.' }, 502)
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  if (raw.length > MAX_BODY) throw new Refused('Request too large.', 413)
  try {
    const data = JSON.parse(raw)
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data
  } catch {
    // fall through
  }
  throw new Refused('Body must be a JSON object.')
}

/** A branch or a commit in a URL: the slashes of a branch name stay. */
export const refPath = (ref: string) => encodeURIComponent(ref).replace(/%2F/g, '/')

/** The head commit of a branch, or undefined if there is no such branch. */
export async function headOf(token: string, repo: string, branch: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const ref = await call<{ object: { sha: string } }>(fetchFn, token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`)
    return ref.object.sha
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return undefined
    throw error
  }
}

/** Makes a branch from the base branch if it is not there yet. */
export async function ensureBranch(token: string, repo: string, base: string, branch: string, fetchFn: typeof fetch): Promise<void> {
  if (await headOf(token, repo, branch, fetchFn)) return
  const from = await headOf(token, repo, base, fetchFn)
  if (!from) throw new Refused(`The base branch "${base}" does not exist (is the repository empty?).`, 409)
  await call(fetchFn, token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: from })
}

export interface Blob {
  oid: string
  text: string
}

/** The texts of files, in as few requests as possible (GraphQL, 100 files each). `expressions` are `<branch or commit>:<path>`; a file that is not there gives null. */
export async function readBlobs(token: string, repo: string, expressions: string[], fetchFn: typeof fetch): Promise<(Blob | null)[]> {
  const [owner, name] = repo.split('/')
  const result: (Blob | null)[] = []
  for (let i = 0; i < expressions.length; i += CHUNK) {
    const part = expressions.slice(i, i + CHUNK)
    const variables: Record<string, string> = { owner, name }
    part.forEach((expression, j) => (variables[`e${j}`] = expression))
    const query = `query($owner:String!,$name:String!${part.map((_, j) => `,$e${j}:String!`).join('')}){repository(owner:$owner,name:$name){${part
      .map((_, j) => `f${j}:object(expression:$e${j}){...on Blob{oid text}}`)
      .join(' ')}}}`
    const data = await call<{ data?: { repository?: Record<string, { oid: string; text: string | null } | null> }; errors?: { message: string }[] }>(fetchFn, token, 'POST', '/graphql', { query, variables })
    if (data.errors?.length || !data.data?.repository) throw new GitHubError(data.errors?.[0]?.message ?? 'GitHub could not read the entries.', 502)
    part.forEach((_, j) => {
      const blob = data.data!.repository![`f${j}`]
      result.push(blob && typeof blob.text === 'string' ? { oid: blob.oid, text: blob.text } : null)
    })
  }
  return result
}

export interface Entry {
  path: string
  sha: string
  text: string
}

/** All entries of a branch (and the .folder.yaml of its topic folders): the file list, then the texts. */
export async function readEntries(token: string, repo: string, ref: string, fetchFn: typeof fetch): Promise<Entry[]> {
  const tree = await call<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(fetchFn, token, 'GET', `/repos/${repo}/git/trees/${refPath(ref)}?recursive=1`)
  const files = tree.tree.filter((n) => n.type === 'blob' && isStoredPath(n.path))
  if (tree.truncated || files.length > MAX_ENTRIES) throw new Refused('The repository has too many entries for this version of the editor.', 413)
  const blobs = await readBlobs(token, repo, files.map((f) => `${ref}:${f.path}`), fetchFn)
  const entries: Entry[] = []
  files.forEach((f, i) => {
    const blob = blobs[i]
    if (blob) entries.push({ path: f.path, sha: blob.oid, text: blob.text })
  })
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}
