import { describe, expect, it } from 'vitest'
import { handle } from '../src/index.js'
import { env, fakeGitHub, request, signIn } from './support.js'

describe('sign-in', () => {
  it('sends the browser to GitHub with state and PKCE', async () => {
    const response = await handle(request(undefined, '/api/auth/login'), env, fakeGitHub().fn)
    const to = new URL(response.headers.get('location')!)
    expect(response.status).toBe(302)
    expect(`${to.origin}${to.pathname}`).toBe('https://github.com/login/oauth/authorize')
    expect(to.searchParams.get('client_id')).toBe('cid')
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:5174/api/auth/callback')
    expect(to.searchParams.get('code_challenge_method')).toBe('S256')
    const cookie = response.headers.getSetCookie()[0]
    expect(cookie).toContain('contents_editor_login=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Secure') // plain http on localhost
  })

  it('signs a collaborator in and says who they are, without the token', async () => {
    const gh = fakeGitHub()
    const cookie = await signIn(gh)
    expect(cookie).toBeTruthy()
    expect(cookie).not.toContain('ghu_')
    const me = await handle(request(cookie, '/api/auth/me'), env, gh.fn)
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ login: 'anna', name: 'Anna', avatar: 'https://avatars.example/anna', role: 'write' })
  })

  it('refuses somebody who may not write to the repository, and takes the token back', async () => {
    const gh = fakeGitHub({}, { push: false, admin: false })
    const login = await handle(request(undefined, '/api/auth/login'), env, gh.fn)
    const state = new URL(login.headers.get('location')!).searchParams.get('state')
    const waiting = login.headers.getSetCookie()[0].split(';')[0]
    const back = await handle(request(waiting, `/api/auth/callback?code=good&state=${state}`), env, gh.fn)
    expect(back.headers.get('location')).toBe('http://localhost:5174/?login=denied&user=anna')
    expect(back.headers.getSetCookie().some((c) => c.startsWith('contents_editor_session=') && !c.includes('Max-Age=0'))).toBe(false)
    expect(gh.calls.some((c) => c.method === 'DELETE' && c.url.startsWith('/applications/'))).toBe(true)
  })

  it('fails on a wrong state or a bad code', async () => {
    const gh = fakeGitHub()
    const login = await handle(request(undefined, '/api/auth/login'), env, gh.fn)
    const waiting = login.headers.getSetCookie()[0].split(';')[0]
    const state = new URL(login.headers.get('location')!).searchParams.get('state')
    expect((await handle(request(waiting, '/api/auth/callback?code=good&state=wrong'), env, gh.fn)).headers.get('location')).toContain('login=failed')
    expect((await handle(request(waiting, `/api/auth/callback?code=bad&state=${state}`), env, gh.fn)).headers.get('location')).toContain('login=failed')
  })

  it('has nobody signed in without the cookie, and ends the session on request', async () => {
    const gh = fakeGitHub()
    expect((await handle(request(undefined, '/api/auth/me'), env, gh.fn)).status).toBe(401)
    expect((await handle(request(undefined, '/api/repo/index'), env, gh.fn)).status).toBe(401)
    const out = await handle(request(await signIn(gh), '/api/auth/logout', { method: 'POST' }), env, gh.fn)
    expect(out.headers.getSetCookie().find((c) => c.startsWith('contents_editor_session='))).toContain('Max-Age=0')
  })

  it('says what is missing when the server is not set up', async () => {
    const response = await handle(request(undefined, '/api/auth/login'), { ...env, SESSION_SECRET: undefined }, fakeGitHub().fn)
    expect(response.status).toBe(500)
  })
})
