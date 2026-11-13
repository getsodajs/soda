import { afterAll, describe, expect, test } from 'bun:test'
import { createApp, provide } from '@getsoda/core'
import { AppModule } from './app.module.ts'
import { AppConfig } from './config.ts'

// Tests do not depend on .env: the configuration is replaced.
const app = await createApp(AppModule, {
  logger: false,
  overrides: [provide(AppConfig, { useValue: { PORT: 0, CORS_ORIGIN: '*', JWT_SECRET: 'a-test-secret-of-at-least-32-characters' } })],
})
const server = await app.listen(0)
const url = (path: string) => new URL(path, server.url)

afterAll(() => app.close())

const login = async (name: string) => {
  const response = await fetch(url('/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  return { response, token: ((await response.json()) as { token: string }).token }
}

describe('auth', () => {
  test('signs in with a token in the body and an httpOnly cookie', async () => {
    const { response, token } = await login('ann')
    const cookie = response.headers.getSetCookie()[0]!

    expect(response.status).toBe(201)
    expect(cookie).toStartWith(`token=${token};`)
    expect(cookie).toContain('HttpOnly')
    expect(await (await fetch(url('/auth/me'), { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ name: 'ann' })
    expect(await (await fetch(url('/auth/me'), { headers: { cookie: `token=${token}` } })).json()).toEqual({ name: 'ann' })
  })

  test('refuses requests without a valid token', async () => {
    const anonymous = await fetch(url('/auth/me'))
    const forged = await fetch(url('/auth/me'), { headers: { authorization: 'Bearer a.b.c' } })

    expect([anonymous.status, forged.status]).toEqual([401, 401])
  })
})

describe('users', () => {
  test('are created by signed-in users, and read by anyone', async () => {
    const { token } = await login('ann')
    const created = await fetch(url('/users'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo' }),
    })

    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ id: 1, name: 'Bo', createdBy: 'ann' })
    expect(await (await fetch(url('/users/1'))).json()).toEqual({ id: 1, name: 'Bo', createdBy: 'ann' })
  })

  test('refuses anonymous writes, invalid bodies and unknown users', async () => {
    const { token } = await login('ann')
    const anonymous = await fetch(url('/users'), { method: 'POST', body: '{}' })
    const invalid = await fetch(url('/users'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    expect(anonymous.status).toBe(401)
    expect(invalid.status).toBe(400)
    expect((await fetch(url('/users/999'))).status).toBe(404)
  })
})
