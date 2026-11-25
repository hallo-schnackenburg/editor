// The Worker. Routes (an optional /api in front is ignored, so the app can reach it under /api):
//   /auth/*       sign in with GitHub, who am I, sign out (auth.ts). Open to everyone.
//   POST /hook/github  GitHub tells that something changed; passed on to everybody who has the app open (webhook.ts).
// and only for a signed-in person who may write to the data repository:
//   /repo/entries, /repo/entry   read the entries, save and remove one (repo.ts).
//   /repo/submissions/*              the submissions (pull requests): list, look at, submit, accept, close, comments (submissions.ts).
//   POST /chat                   passes a chat message to the model and returns tool calls; the Anthropic key stays here (chat.ts).
//   GET /live                    a WebSocket on which the browser hears that something changed (hub.ts).
//
// NOT YET THERE: upload of files (S3), a limit per person for the chat (until then the spending cap is set in the Anthropic workspace).

import { handleAuth, readSession, type AuthEnv } from './auth.js'
import { handleChat, type ChatEnv } from './chat.js'
import { handleSubmissions } from './submissions.js'
import { hubOf, type HubNamespace } from './hub.js'
import { handleRepo } from './repo.js'
import type { Auth } from './session.js'
import { handleHook } from './webhook.js'

export { Hub } from './hub.js'

export interface Env extends AuthEnv, ChatEnv {
  ALLOWED_ORIGIN?: string
  /** The secret of the GitHub App's webhook. */
  WEBHOOK_SECRET?: string
  /** The hub that tells every open browser (a Durable Object). */
  HUB?: HubNamespace
}

function json(body: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': env.ALLOWED_ORIGIN ?? '', vary: 'origin' },
  })
}

/** `fetchFn` is the network; tests pass a fake. */
export async function handle(request: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  const route = new URL(request.url).pathname.replace(/^\/api(?=\/)/, '')

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': env.ALLOWED_ORIGIN ?? '',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    })
  }

  const auth = await handleAuth(request, route, env, fetchFn)
  if (auth) return auth

  const hook = await handleHook(request, route, env)
  if (hook) return hook

  // Everything else is for a signed-in person only. A renewed token goes back to the browser as a new cookie.
  // (A WebSocket cannot carry one, and needs no token: its session is only read.)
  const signed = await readSession(request, env, fetchFn, { renew: route !== '/live' })
  if (!signed) return json({ error: 'Nicht angemeldet.' }, 401, env)
  // A request that changes something must come from our own app: a page of another origin (also another subdomain) is refused.
  // Without an Origin header it is not a browser page (the cookie is needed anyway).
  const origin = request.headers.get('origin')
  if (!['GET', 'HEAD'].includes(request.method) && origin && origin !== env.ALLOWED_ORIGIN && origin !== new URL(request.url).origin) {
    return json({ error: 'Wrong origin.' }, 403, env)
  }
  const response = await signedRoute(request, route, signed.session, env, fetchFn)
  if (signed.cookie) response.headers.append('set-cookie', signed.cookie)
  return response
}

async function signedRoute(request: Request, route: string, session: Auth, env: Env, fetchFn: typeof fetch): Promise<Response> {
  if (route === '/live' && request.method === 'GET') return live(request, env)
  const response =
    (await handleRepo(request, route, session, env, fetchFn)) ?? (await handleSubmissions(request, route, session, env, fetchFn)) ?? (await handleChat(request, route, env, fetchFn))
  return response ?? json({ error: 'Not found.' }, 404, env)
}

/** The WebSocket on which the browser hears that something changed (see hub.ts). */
async function live(request: Request, env: Env): Promise<Response> {
  if (!env.HUB) return json({ error: 'The server has no hub (HUB).' }, 503, env)
  if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426, env)
  // A WebSocket is not held back by the browser's cross-origin rules: only our own app may open one.
  if (!env.ALLOWED_ORIGIN || request.headers.get('origin') !== env.ALLOWED_ORIGIN) return json({ error: 'Wrong origin.' }, 403, env)
  return hubOf(env.HUB).fetch(request)
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
