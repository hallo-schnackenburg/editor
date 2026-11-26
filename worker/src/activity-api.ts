// The activity stream for the browser (the hub keeps it, activity.ts):
//   GET  /activity[?before=<id>&limit=<n>]   the newest lines (50 by default) and the id up to which this person has read
//   POST /activity/seen                      {upto}: this person has read up to this id (it never moves back)

import { hubOf, type HubNamespace } from './hub.js'
import type { Auth } from './session.js'

export interface ActivityEnv {
  HUB?: HubNamespace
}

export async function handleActivity(request: Request, route: string, session: Auth, env: ActivityEnv): Promise<Response | null> {
  if (route !== '/activity' && route !== '/activity/seen') return null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!env.HUB) return json({ error: 'The server has no hub (HUB).' }, 503)
  const hub = hubOf(env.HUB)
  const login = encodeURIComponent(session.login)

  if (route === '/activity' && request.method === 'GET') {
    const params = new URL(request.url).searchParams
    const query = new URLSearchParams({ login: session.login })
    for (const name of ['before', 'limit']) if (params.has(name)) query.set(name, params.get(name)!)
    return hub.fetch(new Request(`http://hub/activity?${query}`))
  }
  if (route === '/activity/seen' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { upto?: unknown }
    if (typeof body.upto !== 'number' || !Number.isInteger(body.upto) || body.upto < 0) return json({ error: 'upto has to be the id of a line.' }, 400)
    return hub.fetch(new Request(`http://hub/activity?login=${login}&seen=${body.upto}`, { method: 'POST' }))
  }
  return null
}
