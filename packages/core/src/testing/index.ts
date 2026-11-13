/**
 * @module
 * Testing an application over HTTP, as Nest's `Test.createTestingModule()`
 * with supertest does, on a real Bun server bound to a free port.
 *
 * ```ts
 * import { createTestApp } from '@getsoda/core/testing'
 *
 * const app = await createTestApp(AppModule, {
 *   overrides: [provide(UsersRepository, { useValue: new MemoryUsersRepository() })],
 * })
 *
 * afterAll(() => app.close())
 *
 * test('creates a user', async () => {
 *   const response = await app.request('/users', { method: 'POST', json: { name: 'Bo' } })
 *
 *   expect(response.status).toBe(201)
 * })
 * ```
 *
 * A single service needs no server: `createContainer(Module, { overrides })`.
 */

import { createApp } from '../app/app.ts'
import type { App, AppOptions } from '../app/app.ts'
import type { ModuleImport, Token } from '../di/index.ts'

export interface TestRequestInit extends RequestInit {
  /** Sent as the JSON body, with `Content-Type: application/json`. */
  readonly json?: unknown
}

/** A started application, closed by `close()` or at the end of an `await using` block. */
export interface TestApp extends AsyncDisposable {
  readonly app: App
  /** Where the application listens, on a free port of localhost. */
  readonly url: URL
  /** `app.container.get()`: a provider as the root module sees it. */
  get<T>(token: Token<T>): T
  /** Sends a request to `path`, relative to the application. */
  request(path: string, init?: TestRequestInit): Promise<Response>
  close(): Promise<void>
}

/**
 * Creates `root` and serves it on a free port. Options are those of
 * `createApp`: `overrides` replace providers; the logger is silent unless one is given.
 */
export const createTestApp = async (root: ModuleImport, options: AppOptions = {}): Promise<TestApp> => {
  const app = await createApp(root, { logger: false, ...options })
  const server = await app.listen({ port: 0, hostname: '127.0.0.1' })
  const close = () => app.close()

  return {
    app,
    url: server.url,
    get: (token) => app.container.get(token),
    request: (path, { json, ...init } = {}) => {
      if (json === undefined) {
        return fetch(new URL(path, server.url), init)
      }

      const headers = new Headers(init.headers)

      headers.set('content-type', 'application/json')

      return fetch(new URL(path, server.url), { ...init, headers, body: JSON.stringify(json) })
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
