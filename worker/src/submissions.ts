// The submissions: a submission is a pull request from a branch `submission/<login>/<slug>`. What there is to do with them:
//
//   GET  /repo/submissions                 all of them (open, drafts, accepted, closed), newest first
//   GET  /repo/submissions/<n>             one, with the entries it adds, changes and removes (before and after) and how its checks stand
//   POST /repo/submissions/<n>/submit      the draft is ready for review
//   POST /repo/submissions/<n>/merge       accept it: squashed into the base branch, the branch removed
//   POST /repo/submissions/<n>/close       close it without accepting
//   POST /repo/submissions/<n>/rename      {name}: the title of the pull request (draft or waiting for review)
//   GET  /repo/submissions/<n>/comments    the comments on it, oldest first
//   POST /repo/submissions/<n>/comments    {body}
//   PATCH  /repo/submissions/<n>/comments/<id>   {body}: change a comment (only the person's own)
//   DELETE /repo/submissions/<n>/comments/<id>   remove a comment (only the person's own)
//
// There are no roles of our own: GitHub decides who may do what (collaborators, branch protection, required checks).

import { authorOf, isSubmissionBranch } from '@editor/core'
import { ENTRY_PATH, Refused, failure, json, readBlobs, readBody, refPath } from './common.js'
import { GitHubError, call } from './github.js'
import type { GithubEnv } from './github.js'
import type { Auth } from './session.js'

type Env = GithubEnv

export type State = 'draft' | 'submitted' | 'merged' | 'closed'

interface RawPull {
  number: number
  node_id: string
  title: string
  state: 'open' | 'closed'
  draft?: boolean
  merged_at: string | null
  html_url: string
  updated_at: string
  head: { ref: string; sha: string; repo?: { full_name?: string } | null }
  base: { ref: string; sha: string }
}

export interface Submission {
  number: number
  name: string
  branch: string
  author: string
  state: State
  url: string
  updated: string
  /** The newest commit of the branch. */
  head: string
}

const stateOf = (p: RawPull): State => (p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'submitted')

const submissionOf = (p: RawPull): Submission => ({ number: p.number, name: p.title, branch: p.head.ref, author: authorOf(p.head.ref), state: stateOf(p), url: p.html_url, updated: p.updated_at, head: p.head.sha })

/** Only pull requests from a submission branch of the data repository itself are submissions. */
const isSubmission = (p: RawPull, repo: string): boolean => isSubmissionBranch(p.head.ref) && p.head.repo?.full_name === repo

const MAX_ITEMS = 100
const MAX_COMMENT = 10_000
const MAX_NAME = 100

/** The newest pull request whose head is this branch, if there is one. */
export async function pullFor(token: string, repo: string, branch: string, fetchFn: typeof fetch): Promise<RawPull | undefined> {
  const [owner] = repo.split('/')
  const found = await call<RawPull[]>(fetchFn, token, 'GET', `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=created&direction=desc&per_page=5`)
  return found.find((p) => p.head.ref === branch)
}

/** Opens the pull request of a submission as a draft. Undefined if GitHub finds nothing to propose yet (the branch does not differ from the base). */
export async function createPull(token: string, repo: string, base: string, branch: string, name: string, fetchFn: typeof fetch): Promise<RawPull | undefined> {
  try {
    return await call<RawPull>(fetchFn, token, 'POST', `/repos/${repo}/pulls`, { title: name, head: branch, base, draft: true, body: '' })
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) return undefined
    throw error
  }
}

async function pull(token: string, repo: string, number: number, fetchFn: typeof fetch): Promise<RawPull> {
  const found = await call<RawPull>(fetchFn, token, 'GET', `/repos/${repo}/pulls/${number}`)
  if (!isSubmission(found, repo)) throw new Refused('Das ist keine Einreichung dieses Editors.', 404)
  return found
}

type Item = { path: string; kind: 'added' | 'modified' | 'removed'; before?: string; after?: string }
type Checks = 'none' | 'pending' | 'success' | 'failure'

async function itemsOf(token: string, repo: string, p: RawPull, fetchFn: typeof fetch): Promise<{ items: Item[]; truncated: boolean }> {
  const compare = await call<{ merge_base_commit: { sha: string }; files?: { filename: string; status: string; previous_filename?: string }[] }>(fetchFn, token, 'GET', `/repos/${repo}/compare/${p.base.sha}...${p.head.sha}`)
  const items: { path: string; kind: Item['kind'] }[] = []
  for (const f of compare.files ?? []) {
    if (f.status === 'renamed' && f.previous_filename) {
      if (ENTRY_PATH.test(f.previous_filename)) items.push({ path: f.previous_filename, kind: 'removed' })
      if (ENTRY_PATH.test(f.filename)) items.push({ path: f.filename, kind: 'added' })
      continue
    }
    if (!ENTRY_PATH.test(f.filename)) continue
    items.push({ path: f.filename, kind: f.status === 'added' || f.status === 'copied' ? 'added' : f.status === 'removed' ? 'removed' : 'modified' })
  }
  items.sort((a, b) => a.path.localeCompare(b.path))
  const shown = items.slice(0, MAX_ITEMS)
  // One request for both sides: every round trip to GitHub counts.
  const both = await readBlobs(token, repo, [...shown.map((i) => `${compare.merge_base_commit.sha}:${i.path}`), ...shown.map((i) => `${p.head.sha}:${i.path}`)], fetchFn)
  const before = both.slice(0, shown.length)
  const after = both.slice(shown.length)
  return {
    items: shown.map((i, n) => ({ ...i, ...(before[n] ? { before: before[n]!.text } : {}), ...(after[n] ? { after: after[n]!.text } : {}) })),
    truncated: items.length > shown.length,
  }
}

async function checksOf(token: string, repo: string, sha: string, fetchFn: typeof fetch): Promise<Checks> {
  try {
    const { check_runs } = await call<{ check_runs: { status: string; conclusion: string | null }[] }>(fetchFn, token, 'GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)
    if (check_runs.length === 0) return 'none'
    if (check_runs.some((c) => c.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'action_required'].includes(c.conclusion ?? ''))) return 'failure'
    if (check_runs.some((c) => c.status !== 'completed')) return 'pending'
    return 'success'
  } catch (error) {
    if (error instanceof GitHubError) return 'none' // the app may not be allowed to read checks; GitHub's own rules still hold at merging
    throw error
  }
}

export async function handleSubmissions(request: Request, route: string, session: Auth, env: Env, fetchFn: typeof fetch): Promise<Response | null> {
  const match = route.match(/^\/repo\/submissions(?:\/(\d+)(?:\/(submit|merge|close|rename|comments)(?:\/(\d+))?)?)?$/)
  if (!match) return null
  const repo = env.DATA_REPO
  if (!repo) return json({ error: 'The server has no DATA_REPO.' }, 500)
  const token = session.access
  const number = match[1] ? Number(match[1]) : undefined
  const action = match[2]
  const commentId = match[3] ? Number(match[3]) : undefined

  try {
    if (number === undefined) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405)
      const all = await call<RawPull[]>(fetchFn, token, 'GET', `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`)
      return json({ submissions: all.filter((p) => isSubmission(p, repo)).map(submissionOf) })
    }

    if (action === undefined) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405)
      const p = await pull(token, repo, number, fetchFn)
      const [{ items, truncated }, checks] = await Promise.all([itemsOf(token, repo, p, fetchFn), checksOf(token, repo, p.head.sha, fetchFn)])
      return json({ submission: submissionOf(p), items, truncated, checks })
    }

    if (action === 'comments' && commentId !== undefined) {
      if (request.method !== 'PATCH' && request.method !== 'DELETE') return json({ error: 'Method not allowed.' }, 405)
      await pull(token, repo, number, fetchFn)
      // Only the person's own comments are changed or removed here, and only those of this submission.
      const own = await call<{ user: { login: string } | null; issue_url: string }>(fetchFn, token, 'GET', `/repos/${repo}/issues/comments/${commentId}`).catch((error) => {
        if (error instanceof GitHubError && error.status === 404) return undefined
        throw error
      })
      if (!own || !own.issue_url.endsWith(`/issues/${number}`)) return json({ error: 'Diesen Kommentar gibt es nicht.' }, 404)
      if (own.user?.login !== session.login) return json({ error: 'Du kannst nur deine eigenen Kommentare ändern.' }, 403)
      if (request.method === 'DELETE') {
        await call(fetchFn, token, 'DELETE', `/repos/${repo}/issues/comments/${commentId}`)
        return new Response(null, { status: 204 })
      }
      const data = await readBody(request)
      const text = typeof data.body === 'string' ? data.body.trim() : ''
      if (!text) throw new Refused('Der Kommentar ist leer.')
      if (text.length > MAX_COMMENT) throw new Refused('Der Kommentar ist zu lang.', 413)
      const c = await call<{ id: number; body: string; created_at: string; user: { login: string; avatar_url: string } }>(fetchFn, token, 'PATCH', `/repos/${repo}/issues/comments/${commentId}`, { body: text })
      return json({ id: c.id, author: c.user.login, avatar: c.user.avatar_url, body: c.body, created: c.created_at })
    }

    if (action === 'comments') {
      await pull(token, repo, number, fetchFn)
      if (request.method === 'GET') {
        const comments = await call<{ id: number; body: string; created_at: string; user: { login: string; avatar_url: string } | null }[]>(fetchFn, token, 'GET', `/repos/${repo}/issues/${number}/comments?per_page=100`)
        return json({ comments: comments.map((c) => ({ id: c.id, author: c.user?.login ?? '', avatar: c.user?.avatar_url ?? '', body: c.body, created: c.created_at })) })
      }
      if (request.method === 'POST') {
        const data = await readBody(request)
        const text = typeof data.body === 'string' ? data.body.trim() : ''
        if (!text) throw new Refused('Der Kommentar ist leer.')
        if (text.length > MAX_COMMENT) throw new Refused('Der Kommentar ist zu lang.', 413)
        const c = await call<{ id: number; body: string; created_at: string; user: { login: string; avatar_url: string } }>(fetchFn, token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: text })
        return json({ id: c.id, author: c.user.login, avatar: c.user.avatar_url, body: c.body, created: c.created_at }, 201)
      }
      return json({ error: 'Method not allowed.' }, 405)
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
    const p = await pull(token, repo, number, fetchFn)
    const state = stateOf(p)

    if (action === 'rename') {
      if (state === 'merged' || state === 'closed') throw new Refused('Diese Einreichung ist schon abgeschlossen.', 409)
      const data = await readBody(request)
      const title = typeof data.name === 'string' ? data.name.replace(/\s+/g, ' ').trim() : ''
      if (!title) throw new Refused('Der Name fehlt.')
      if (title.length > MAX_NAME) throw new Refused(`Der Name ist zu lang (höchstens ${MAX_NAME} Zeichen).`, 413)
      await call(fetchFn, token, 'PATCH', `/repos/${repo}/pulls/${number}`, { title })
      return json({ ...submissionOf(p), name: title })
    }

    if (action === 'submit') {
      if (state !== 'draft') throw new Refused(state === 'submitted' ? 'Die Einreichung ist schon eingereicht.' : 'Diese Einreichung ist abgeschlossen.', 409)
      const result = await call<{ errors?: { message: string }[] }>(fetchFn, token, 'POST', '/graphql', {
        query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
        variables: { id: p.node_id },
      })
      if (result.errors?.length) throw new GitHubError(result.errors[0].message, 422)
      return json({ ...submissionOf(p), state: 'submitted' })
    }

    if (action === 'merge') {
      if (state === 'draft') throw new Refused('Die Einreichung ist noch ein Entwurf: erst einreichen.', 409)
      if (state !== 'submitted') throw new Refused('Diese Einreichung ist schon abgeschlossen.', 409)
      await call(fetchFn, token, 'PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: 'squash', sha: p.head.sha })
      // The branch has done its work (best effort: a protected or already removed branch is no reason to fail).
      await call(fetchFn, token, 'DELETE', `/repos/${repo}/git/refs/heads/${refPath(p.head.ref)}`).catch(() => undefined)
      return json({ ...submissionOf(p), state: 'merged' })
    }

    // close
    if (state === 'merged' || state === 'closed') throw new Refused('Diese Einreichung ist schon abgeschlossen.', 409)
    await call(fetchFn, token, 'PATCH', `/repos/${repo}/pulls/${number}`, { state: 'closed' })
    // The branch is of no use any more (the pull request stays, with everything it held); a new submission starts from the base again.
    await call(fetchFn, token, 'DELETE', `/repos/${repo}/git/refs/heads/${refPath(p.head.ref)}`).catch(() => undefined)
    return json({ ...submissionOf(p), state: 'closed' })
  } catch (error) {
    return failure(error)
  }
}
