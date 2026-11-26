import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { env as baseEnv } from './support.js'

const SECRET = 'hook-secret'

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`
}

/** A hub that writes down what it is told. */
function hub() {
  const told: unknown[] = []
  const activity: unknown[] = []
  return {
    told,
    activity,
    namespace: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const body = JSON.parse(await request.text())
          if (new URL(request.url).pathname === '/activity') activity.push(body)
          else told.push(body)
          return new Response(null, { status: 204 })
        },
      }),
    },
  }
}

async function send(event: string, payload: object, { secret = SECRET, signature }: { secret?: string; signature?: string } = {}) {
  const h = hub()
  const body = JSON.stringify({ repository: { full_name: 'o/r' }, ...payload })
  const response = await handle(
    new Request('http://worker/api/hook/github', { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? (await sign(body, secret)) } }),
    { ...baseEnv, WEBHOOK_SECRET: SECRET, HUB: h.namespace },
  )
  return { status: response.status, told: h.told, activity: h.activity }
}

describe('the webhook', () => {
  it('answers a ping, and only to a signed call', async () => {
    expect((await send('ping', {})).status).toBe(200)
    expect((await send('ping', {}, { secret: 'other' })).status).toBe(401)
    expect((await send('ping', {}, { signature: 'sha256=zz' })).status).toBe(401)
    expect((await send('push', { ref: 'refs/heads/main', after: 'abc' }, { signature: 'nonsense' })).told).toEqual([])
  })

  it('is not set up without its secret', async () => {
    const response = await handle(new Request('http://worker/api/hook/github', { method: 'POST', body: '{}' }), baseEnv)
    expect(response.status).toBe(503)
  })

  it('tells that the base branch moved', async () => {
    expect(await send('push', { ref: 'refs/heads/main', after: 'abc' })).toEqual({ status: 204, told: [{ type: 'push', ref: 'refs/heads/main', head: 'abc' }], activity: [] })
  })

  it('tells that a submission changed: commit, pull request, check, comment', async () => {
    expect((await send('push', { ref: 'refs/heads/submission/anna/fest', after: 'def' })).told).toEqual([{ type: 'pull', branch: 'submission/anna/fest', head: 'def' }])
    expect((await send('pull_request', { number: 4, pull_request: { head: { ref: 'submission/anna/fest', sha: 'def' } } })).told).toEqual([{ type: 'pull', number: 4, branch: 'submission/anna/fest', head: 'def' }])
    expect((await send('check_run', { check_run: { check_suite: { head_branch: 'submission/anna/fest' } } })).told).toEqual([{ type: 'pull', branch: 'submission/anna/fest' }])
    expect((await send('status', { branches: [{ name: 'submission/anna/fest' }] })).told).toEqual([{ type: 'pull', branch: 'submission/anna/fest' }])
    expect((await send('issue_comment', { issue: { number: 4, pull_request: {} } })).told).toEqual([{ type: 'comment', number: 4 }])
  })

  it('ignores what is not ours', async () => {
    for (const [event, payload] of [
      ['push', { ref: 'refs/heads/other' }],
      ['push', { ref: 'refs/heads/edit/anna' }],
      ['pull_request', { number: 1, pull_request: { head: { ref: 'dependabot/x' } } }],
      ['issue_comment', { issue: { number: 4 } }],
      ['star', {}],
    ] as const) {
      const result = await send(event, payload)
      expect(result, event).toEqual({ status: 202, told: [], activity: [] })
    }
    expect(await send('push', { repository: { full_name: 'x/y' }, ref: 'refs/heads/main', after: 'a' })).toEqual({ status: 202, told: [], activity: [] })
  })
})

describe('the live connection', () => {
  const live = (headers: Record<string, string>, h = hub()) => handle(new Request('http://worker/api/live', { headers }), { ...baseEnv, HUB: h.namespace })

  it('is for people who are signed in', async () => {
    expect((await live({ upgrade: 'websocket', origin: baseEnv.ALLOWED_ORIGIN! })).status).toBe(401)
  })
})
