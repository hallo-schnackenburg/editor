import { handle, type Env } from '../src/index.js'

export const env: Env = {
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'test-secret-test-secret',
  DATA_REPO: 'o/r',
  BASE_BRANCH: 'main',
  APP_URL: 'http://localhost:5174',
  ALLOWED_ORIGIN: 'http://localhost:5174',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A GitHub that knows one repository: a base branch, the branches made on it, what is committed, and the pull requests.
 * Commits are not modelled: the head of a branch is `head-<branch>`, the base the pull requests were opened against is
 * `base-snapshot` (the base branch as it was at the start), and both can be read like a branch.
 */
export function fakeGitHub(initial: Record<string, string> = {}, permissions = { push: true, admin: false }) {
  const files = new Map(Object.entries(initial))
  const branches = new Map<string, Map<string, string>>([['main', new Map(files)]])
  const snapshot = new Map(files)
  const calls: { method: string; url: string; body?: any }[] = []
  const blob = (text: string) => `sha-${text.length}-${text.slice(0, 6)}`
  const pulls: any[] = []
  const staged: unknown[] = []
  const comments = new Map<number, any[]>()
  /** How the checks of every head stand, and whether the base branch asks for them before a merge. */
  const options = { checks: 'success' as 'success' | 'failure' | 'pending' | 'none', protect: false }
  const tree = (ref: string) => (ref === 'base-snapshot' ? snapshot : ref.startsWith('head-') ? branches.get(ref.slice(5)) : branches.get(ref))
  const pullJson = (p: any) => ({ ...p, head: { ...p.head }, base: { ...p.base } })

  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url: `${url.pathname}${url.search}`, body })
    const path = decodeURIComponent(url.pathname)

    if (url.host === 'github.com' && path === '/login/oauth/access_token') {
      return body.code === 'good'
        ? json({ access_token: 'ghu_token', expires_in: 28800, refresh_token: 'ghr_token', refresh_token_expires_in: 15811200 })
        : json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
    }
    if (path === '/user') return json({ login: 'anna', name: 'Anna', avatar_url: 'https://avatars.example/anna' })
    if (path === '/repos/o/r') return json({ permissions })
    if (method === 'DELETE' && path.startsWith('/applications/')) return new Response(null, { status: 204 })

    let m = path.match(/^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/)
    if (m) return branches.has(m[1]) ? json({ object: { sha: `head-${m[1]}` } }) : json({ message: 'Not Found' }, 404)
    if (method === 'POST' && path === '/repos/o/r/git/refs') {
      branches.set(body.ref.replace('refs/heads/', ''), new Map(branches.get('main')))
      return json({ ref: body.ref }, 201)
    }
    m = path.match(/^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/)
    if (m && method === 'DELETE') {
      branches.delete(m[1])
      return new Response(null, { status: 204 })
    }
    // commits made of trees (the atomic commit): a tree is only the files it changes on top of its base, a commit points to one, and
    // moving the branch to the commit applies it
    m = path.match(/^\/repos\/o\/r\/git\/commits\/(.+)$/)
    if (m && method === 'GET') return json({ tree: { sha: `tree-of-${m[1]}` } })
    if (method === 'POST' && path === '/repos/o/r/git/trees') {
      staged.push(body.tree)
      return json({ sha: `tree-${staged.length - 1}` })
    }
    if (method === 'POST' && path === '/repos/o/r/git/commits') return json({ sha: `commit-${body.tree}` })
    m = path.match(/^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/)
    if (m && method === 'PATCH') {
      const branch = branches.get(m[1])
      if (!branch) return json({ message: 'Not Found' }, 404)
      for (const n of staged[Number(String(body.sha).replace('commit-tree-', ''))] as { path: string; content?: string; sha?: null }[]) {
        if (n.sha === null) branch.delete(n.path)
        else branch.set(n.path, n.content!)
      }
      return json({ ref: m[1] })
    }
    m = path.match(/^\/repos\/o\/r\/git\/blobs\/(.+)$/)
    if (m) {
      const wantsRaw = /raw/.test(new Headers(init.headers).get('accept') ?? '')
      for (const t of branches.values()) for (const text of t.values()) if (blob(text) === m[1]) return wantsRaw ? new Response(text) : json({ encoding: 'base64', content: btoa(String.fromCharCode(...new TextEncoder().encode(text))) })
      return json({ message: 'Not Found' }, 404)
    }
    m = path.match(/^\/repos\/o\/r\/git\/trees\/(.+)$/)
    if (m) {
      const files = [...(tree(m[1]) ?? new Map()).entries()].map(([p, t]) => ({ path: p, type: 'blob', sha: blob(t) }))
      return json({ tree: [{ path: 'entities', type: 'tree', sha: 'x' }, ...files], truncated: false })
    }
    if (method === 'POST' && path === '/graphql') {
      if (String(body.query).includes('markPullRequestReadyForReview')) {
        const p = pulls.find((x) => x.node_id === body.variables.id)
        if (!p) return json({ data: null, errors: [{ message: 'Could not resolve to a node' }] })
        p.draft = false
        return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })
      }
      const repository: Record<string, unknown> = {}
      Object.entries(body.variables as Record<string, string>).forEach(([k, v]) => {
        if (!/^e\d+$/.test(k)) return
        const [ref, ...p] = v.split(':')
        const text = tree(ref)?.get(p.join(':'))
        repository[`f${k.slice(1)}`] = text === undefined ? null : { oid: blob(text), text }
      })
      return json({ data: { repository } })
    }
    m = path.match(/^\/repos\/o\/r\/contents\/(.+)$/)
    // whether a file is in the tree of a commit (`head-<branch>`)
    if (m && method === 'GET') return tree(url.searchParams.get('ref') ?? '')?.has(m[1]) ? json({ path: m[1] }) : json({ message: 'Not Found' }, 404)
    if (m && (method === 'PUT' || method === 'DELETE')) {
      const branch = branches.get(body.branch)
      if (!branch) return json({ message: 'Branch not found' }, 404)
      const before = branch.get(m[1])
      if (before !== undefined && body.sha !== blob(before)) return json({ message: `${m[1]} does not match ${body.sha}` }, 409)
      if (method === 'DELETE') {
        branch.delete(m[1])
        return json({ commit: { sha: 'commit-delete' } })
      }
      const text = new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)))
      branch.set(m[1], text)
      return json({ content: { sha: blob(text) }, commit: { sha: 'commit-put' } })
    }

    // pull requests
    if (path === '/repos/o/r/pulls' && method === 'GET') {
      const head = url.searchParams.get('head')?.split(':')[1]
      const wanted = url.searchParams.get('state') ?? 'open'
      return json(pulls.filter((p) => (!head || p.head.ref === head) && (wanted === 'all' || p.state === wanted)).map(pullJson).reverse())
    }
    if (path === '/repos/o/r/pulls' && method === 'POST') {
      const branch = branches.get(body.head)
      const same = branch && [...branch].every(([k, v]) => tree('base-snapshot')!.get(k) === v) && branch.size === snapshot.size
      if (!branch || same) return json({ message: `Validation Failed: No commits between ${body.base} and ${body.head}` }, 422)
      const number = pulls.length + 1
      const pull = {
        number,
        node_id: `node-${number}`,
        title: body.title,
        state: 'open',
        draft: !!body.draft,
        merged_at: null,
        html_url: `https://github.com/o/r/pull/${number}`,
        updated_at: '2026-01-01T00:00:00Z',
        head: { ref: body.head, sha: `head-${body.head}`, repo: { full_name: 'o/r' } },
        base: { ref: body.base, sha: 'base-snapshot' },
      }
      pulls.push(pull)
      return json(pullJson(pull), 201)
    }
    m = path.match(/^\/repos\/o\/r\/pulls\/(\d+)(?:\/(merge))?$/)
    if (m) {
      const p = pulls.find((x) => x.number === Number(m![1]))
      if (!p) return json({ message: 'Not Found' }, 404)
      if (m[2] === 'merge' && method === 'PUT') {
        if (p.draft) return json({ message: 'Pull Request is still a draft' }, 405)
        if (options.protect && options.checks !== 'success') return json({ message: 'Required status check "validate" is expected.' }, 405)
        branches.set('main', new Map(branches.get(p.head.ref)))
        p.state = 'closed'
        p.merged_at = '2026-01-02T00:00:00Z'
        return json({ merged: true, sha: 'merge-commit' })
      }
      if (method === 'PATCH') {
        if (body.state !== undefined) p.state = body.state
        if (body.title !== undefined) p.title = body.title
        return json(pullJson(p))
      }
      if (method === 'GET') return json(pullJson(p))
    }
    m = path.match(/^\/repos\/o\/r\/compare\/(.+)\.\.\.(.+)$/)
    if (m) {
      const from = tree(m[1]) ?? new Map<string, string>()
      const to = tree(m[2]) ?? new Map<string, string>()
      const paths = [...new Set([...from.keys(), ...to.keys()])]
      const changed = paths.flatMap((p) => (from.get(p) === to.get(p) ? [] : [{ filename: p, status: !from.has(p) ? 'added' : !to.has(p) ? 'removed' : 'modified' }]))
      return json({ status: 'ahead', merge_base_commit: { sha: m[1] }, files: changed })
    }
    m = path.match(/^\/repos\/o\/r\/commits\/(.+)\/check-runs$/)
    if (m) {
      return json({ check_runs: options.checks === 'none' ? [] : [{ name: 'validate', status: options.checks === 'pending' ? 'in_progress' : 'completed', conclusion: options.checks === 'failure' ? 'failure' : options.checks === 'success' ? 'success' : null }] })
    }
    m = path.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/)
    if (m) {
      const list = comments.get(Number(m[1])) ?? []
      if (method === 'POST') {
        const c = { id: list.length + 1, body: body.body, created_at: '2026-01-01T10:00:00Z', user: { login: 'anna', avatar_url: 'https://avatars.example/anna' } }
        comments.set(Number(m[1]), [...list, c])
        return json(c, 201)
      }
      return json(list)
    }
    return json({ message: `unexpected ${method} ${path}` }, 500)
  }) as typeof fetch

  return { fn, calls, branches, blob, pulls, comments, options }
}

/** Signs Anna in through the whole flow and returns the cookie of her session. */
export async function signIn(gh = fakeGitHub()) {
  const login = await handle(new Request('http://worker/api/auth/login'), env, gh.fn)
  const state = new URL(login.headers.get('location')!).searchParams.get('state')
  const waiting = login.headers.getSetCookie()[0].split(';')[0]
  const back = await handle(new Request(`http://worker/api/auth/callback?code=good&state=${state}`, { headers: { cookie: waiting } }), env, gh.fn)
  return back.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('contents_editor_session='))!
}

export const request = (cookie: string | undefined, path: string, init: RequestInit = {}) =>
  new Request(`http://worker${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } })
