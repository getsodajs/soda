import { afterAll, describe, expect, test } from 'bun:test'
import { provide } from '@getsoda/core'
import { createTestApp } from '@getsoda/core/testing'
import { AppModule } from './app.module.ts'
import { AppConfig } from './config.ts'

// Tests do not depend on .env: the configuration is replaced.
const app = await createTestApp(AppModule, {
  overrides: [provide(AppConfig, { useValue: { PORT: 0, CORS_ORIGIN: '*', JWT_SECRET: 'a-test-secret-of-at-least-32-characters' } })],
})

afterAll(() => app.close())

const login = async (name: string) => {
  const response = await app.request('/auth/login', { method: 'POST', json: { name } })

  return { response, token: ((await response.json()) as { token: string }).token }
}

describe('auth', () => {
  test('signs in with a token in the body and an httpOnly cookie', async () => {
    const { response, token } = await login('ann')
    const cookie = response.headers.getSetCookie()[0]!

    expect(response.status).toBe(201)
    expect(cookie).toStartWith(`token=${token};`)
    expect(cookie).toContain('HttpOnly')
    expect(await (await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ name: 'ann' })
    expect(await (await app.request('/auth/me', { headers: { cookie: `token=${token}` } })).json()).toEqual({ name: 'ann' })
  })

  test('refuses requests without a valid token', async () => {
    const anonymous = await app.request('/auth/me')
    const forged = await app.request('/auth/me', { headers: { authorization: 'Bearer a.b.c' } })

    expect([anonymous.status, forged.status]).toEqual([401, 401])
  })
})

describe('users', () => {
  test('are created by signed-in users, and read by anyone', async () => {
    const { token } = await login('ann')
    const created = await app.request('/users', { method: 'POST', headers: { authorization: `Bearer ${token}` }, json: { name: 'Bo' } })

    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ id: 1, name: 'Bo', createdBy: 'ann' })
    expect(await (await app.request('/users/1')).json()).toEqual({ id: 1, name: 'Bo', createdBy: 'ann' })
  })

  test('refuses anonymous writes, invalid bodies and unknown users', async () => {
    const { token } = await login('ann')
    const anonymous = await app.request('/users', { method: 'POST', json: {} })
    const invalid = await app.request('/users', { method: 'POST', headers: { authorization: `Bearer ${token}` }, json: { name: '' } })

    expect(anonymous.status).toBe(401)
    expect(invalid.status).toBe(400)
    expect((await app.request('/users/999')).status).toBe(404)
  })
})
