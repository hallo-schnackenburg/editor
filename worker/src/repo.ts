// The entries of the data repository: reading them, saving one, removing one, always as the signed-in person.
//
//   GET    /repo/entries[?branch=submission/…]   every entry of that submission's branch (or of the base branch, if there is no branch yet)
//   PUT    /repo/entry                       saves one entry as a commit on a submission's branch
//   DELETE /repo/entry                       removes one entry the same way
//   POST   /repo/commit                      {branch, name, message, writes: [{path, text}], removals: [path]}: several entries in ONE commit
//                                            (a renaming moves files and rewrites references: the branch must never be half renamed)
//
// A submission is a branch `submission/<login>/<slug>` with a pull request (submissions.ts). The first save makes the branch from the
// base branch and opens the pull request as a draft, with the name the person gave the submission as its title.
// Nothing invalid is written: an entry has to pass the checks of core (schema, path, files, text) first.

import { FOLDER_PATH, checkPath, isSubmissionBranch, readObject, validateEntryYaml, validateFolderYaml, type Issue } from '@contents-editor/core'
import { ENTRY_PATH, Refused, ensureBranch, failure, headOf, json, readBody, readEntries, refPath } from './common.js'
import { call } from './github.js'
import { Repo } from './repository.js'
import type { GithubEnv } from './github.js'
import { pullFor } from './submissions.js'
import type { Auth } from './session.js'

type Env = GithubEnv

/** The most entries one commit holds (a renaming with everything below it and every reference to it). */
const MAX_COMMIT = 300

const message = (given: unknown, fallback: string) => (typeof given === 'string' && given.trim() ? given.trim().slice(0, 200) : fallback)

function entryPath(value: unknown): string {
  if (typeof value !== 'string' || !ENTRY_PATH.test(value)) throw new Refused('Not the path of an entry (entities/…, contents/… or objects/…, ending in .yaml).')
  return value
}

/** What a commit may hold: an entry, or the .folder.yaml of a topic (which names the topic and lets it exist while it is empty). */
function storedPath(value: unknown): string {
  if (typeof value === 'string' && FOLDER_PATH.test(value)) return value
  return entryPath(value)
}

function branchOf(value: unknown): string {
  if (!isSubmissionBranch(value)) throw new Refused('Not the branch of a submission (submission/<login>/<name>).')
  return value
}

/**
 * Checks what would be written. A submission may hold unfinished entries (a name missing, a reference to nothing): that is for the
 * person to see when handing in, and for the automatic check to hold back at the merge. What is refused here: text that is not
 * YAML (the form could not open it any more), and a file that is not where its id and type say.
 */
export function checkBeforeSaving(path: string, text: string): Issue[] {
  if (FOLDER_PATH.test(path)) return validateFolderYaml(text)
  const object = readObject(text)
  if (!object) return validateEntryYaml(text)
  return checkPath(path, object)
}

const contentsUrl = (repo: string, path: string) => `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * What a save needs of the submission before it commits: that it is not finished, that there is a name if the pull request has to
 * be opened, and the branch. Returns what to do after the commit.
 */
async function prepare(data: Record<string, unknown>, session: Auth, repo: string, base: string, fetchFn: typeof fetch, makeBranch = true) {
  const branch = branchOf(data.branch)
  const exists = !!(await headOf(session.access, repo, branch, fetchFn))
  const latest = exists ? await pullFor(session.access, repo, branch, fetchFn) : undefined
  if (latest && latest.state !== 'open') throw new Refused('Diese Einreichung ist schon abgeschlossen. Lege eine neue an.', 409)
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 200) : ''
  if (!latest && !name) throw new Refused('The name of the submission is missing.')
  if (!exists && makeBranch) await ensureBranch(session.access, repo, base, branch, fetchFn)
  return { branch, name, pull: latest?.number }
}

/** Opens the pull request after the first commit. A submission that does not differ from the base (yet) has none: the next save tries again. */
async function afterCommit(prepared: Awaited<ReturnType<typeof prepare>>, repository: Repo): Promise<number | undefined> {
  if (prepared.pull !== undefined) return prepared.pull
  return (await repository.draft(prepared.branch, prepared.name, ''))?.number
}

export async function handleRepo(request: Request, route: string, session: Auth, env: Env, fetchFn: typeof fetch): Promise<Response | null> {
  if (route !== '/repo/entries' && route !== '/repo/entry' && route !== '/repo/commit') return null
  const repo = env.DATA_REPO
  const base = env.BASE_BRANCH ?? 'main'
  if (!repo) return json({ error: 'The server has no DATA_REPO.' }, 500)

  try {
    if (route === '/repo/entries' && request.method === 'GET') {
      const given = new URL(request.url).searchParams.get('branch')
      const branch = given === null ? undefined : branchOf(given)
      const exists = branch !== undefined && !!(await headOf(session.access, repo, branch, fetchFn))
      return json({ base, branch: branch ?? null, exists, entries: await readEntries(session.access, repo, exists ? branch! : base, fetchFn) })
    }

    if (route === '/repo/entry' && request.method === 'PUT') {
      const data = await readBody(request)
      const path = entryPath(data.path)
      if (typeof data.text !== 'string') throw new Refused('The text of the entry is missing.')
      const issues = checkBeforeSaving(path, data.text)
      if (issues.length > 0) throw new Refused('The entry is not valid.', 422, issues)
      const prepared = await prepare(data, session, repo, base, fetchFn)
      const saved = await call<{ content: { sha: string }; commit: { sha: string } }>(fetchFn, session.access, 'PUT', contentsUrl(repo, path), {
        message: message(data.message, `${typeof data.sha === 'string' ? 'Update' : 'Add'} ${path}`),
        content: btoa(String.fromCharCode(...new TextEncoder().encode(data.text))),
        branch: prepared.branch,
        ...(typeof data.sha === 'string' ? { sha: data.sha } : {}),
      })
      return json({ path, sha: saved.content.sha, commit: saved.commit.sha, branch: prepared.branch, pull: await afterCommit(prepared, new Repo(session.access, repo, base, fetchFn)) })
    }

    if (route === '/repo/commit' && request.method === 'POST') {
      const data = await readBody(request)
      const writes = Array.isArray(data.writes) ? data.writes : []
      const removals = Array.isArray(data.removals) ? data.removals : []
      if (writes.length + removals.length === 0) throw new Refused('There is nothing to commit.')
      if (writes.length + removals.length > MAX_COMMIT) throw new Refused(`A commit can hold ${MAX_COMMIT} entries at most.`, 413)
      const files = writes.map((w: unknown) => {
        const { path, text } = (w ?? {}) as { path?: unknown; text?: unknown }
        const checked = storedPath(path)
        if (typeof text !== 'string') throw new Refused(`The text of ${checked} is missing.`)
        const issues = checkBeforeSaving(checked, text)
        if (issues.length > 0) throw new Refused(`${checked} is not valid.`, 422, issues)
        return { path: checked, text }
      })
      const gone = removals.map(storedPath)
      if (new Set([...files.map((f) => f.path), ...gone]).size !== files.length + gone.length) throw new Refused('A path is there twice.')
      const prepared = await prepare(data, session, repo, base, fetchFn, false)
      const repository = new Repo(session.access, repo, base, fetchFn)
      // One commit; the branch is made from the base if it is not there yet. Nothing differs (everything written is there already): no commit.
      const commit = await repository.save(prepared.branch, files.map((f) => ({ path: f.path, content: f.text })), gone, message(data.message, `Update ${files.length + gone.length} entries`))
      return json({ ...(commit ? { commit } : {}), branch: prepared.branch, pull: await afterCommit(prepared, repository) })
    }

    if (route === '/repo/entry' && request.method === 'DELETE') {
      const data = await readBody(request)
      const path = entryPath(data.path)
      if (typeof data.sha !== 'string') throw new Refused('The sha of the entry to remove is missing.')
      const prepared = await prepare(data, session, repo, base, fetchFn)
      const removed = await call<{ commit: { sha: string } }>(fetchFn, session.access, 'DELETE', contentsUrl(repo, path), {
        message: message(data.message, `Remove ${path}`),
        sha: data.sha,
        branch: prepared.branch,
      })
      return json({ path, commit: removed.commit.sha, branch: prepared.branch, pull: await afterCommit(prepared, new Repo(session.access, repo, base, fetchFn)) })
    }
  } catch (error) {
    return failure(error)
  }
  return json({ error: 'Method not allowed.' }, 405)
}
