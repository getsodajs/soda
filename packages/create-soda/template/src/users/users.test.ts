import { afterAll, expect, test } from 'bun:test'
import { createApp } from '@getsoda/core'
import { AppModule } from '../app.module.ts'

const app = await createApp(AppModule, { logger: false })
const server = await app.listen(0)
const url = (path: string) => new URL(path, server.url)

afterAll(() => app.close())

test('creates a user when authenticated', async () => {
  const response = await fetch(url('/users'), {
    method: 'POST',
    headers: { authorization: 'Bearer ann', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bo' }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ id: 1, name: 'Bo', createdBy: 'ann' })
  expect(await (await fetch(url('/users/1'))).json()).toEqual({ id: 1, name: 'Bo', createdBy: 'ann' })
})

test('refuses anonymous writes, invalid bodies and unknown users', async () => {
  const anonymous = await fetch(url('/users'), { method: 'POST', body: '{}' })
  const invalid = await fetch(url('/users'), {
    method: 'POST',
    headers: { authorization: 'Bearer ann', 'content-type': 'application/json' },
    body: JSON.stringify({ name: '' }),
  })

  expect(anonymous.status).toBe(403)
  expect(invalid.status).toBe(400)
  expect((await fetch(url('/users/999'))).status).toBe(404)
})
