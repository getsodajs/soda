import { afterAll, describe, expect, it } from 'bun:test'
import { createContainer, Module } from '../di/index.ts'
import { compileRoutes } from '../routing/index.ts'
import { cookie } from './arguments.ts'
import type { Context } from './context.ts'
import { CookieSigner, signed } from './cookies.ts'
import { Controller, Get, Post } from './decorators.ts'
import { UnauthorizedException } from './exceptions.ts'
import { int } from './parsers.ts'
import { controllerRoutes } from './routes.ts'

const signer = new CookieSigner(['new-secret', 'old-secret'])
const oldSigner = new CookieSigner('old-secret')

@Controller()
class SessionController {
  @Get('read', [cookie('theme'), cookie('visits', int({ optional: true }))])
  read(theme: string | undefined, visits: number | undefined) {
    return { theme: theme ?? null, visits: visits ?? null }
  }

  @Post('login')
  login(ctx: Context) {
    ctx.cookies.set('session', signer.sign('user 1'), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 3600 })

    return null
  }

  @Post('logout')
  logout(ctx: Context) {
    ctx.cookies.delete('session')

    throw new UnauthorizedException()
  }

  @Get('me', [cookie('session', signed(signer))])
  me(user: string) {
    return { user }
  }

  @Get('maybe', [cookie('session', signed(signer, { optional: true }))])
  maybe(user: string | undefined) {
    return { user: user ?? null }
  }
}

@Module({ controllers: [SessionController] })
class AppModule {}

const server = Bun.serve({ port: 0, ...compileRoutes(controllerRoutes(await createContainer(AppModule))) })

afterAll(() => server.stop(true))

const request = (method: string, path: string, cookies = '') =>
  fetch(server.url.origin + path, { method, headers: cookies === '' ? {} : { cookie: cookies } })

describe('cookies', () => {
  it('reads cookies decoded, through parsers', async () => {
    const response = await request('GET', '/read', 'theme=dark%20blue; visits=3')
    const missing = await request('GET', '/read')
    const invalid = await request('GET', '/read', 'visits=many')

    expect(await response.json()).toEqual({ theme: 'dark blue', visits: 3 })
    expect(await missing.json()).toEqual({ theme: null, visits: null })
    expect(invalid.status).toBe(400)
  })

  it('sends what the handler sets, with its attributes', async () => {
    const response = await request('POST', '/login')
    const [header] = response.headers.getSetCookie()

    expect(response.headers.getSetCookie()).toHaveLength(1)
    expect(header).toStartWith(`session=${encodeURIComponent(signer.sign('user 1'))};`)
    expect(header).toContain('Max-Age=3600')
    expect(header).toContain('Secure')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
  })

  it('sends deletions with error responses too', async () => {
    const response = await request('POST', '/logout', 'session=x')

    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toEqual(['session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'])
  })
})

describe('signed cookies', () => {
  it('accepts values signed by any of the secrets', async () => {
    const current = await request('GET', '/me', `session=${encodeURIComponent(signer.sign('user 1'))}`)
    const rotated = await request('GET', '/me', `session=${encodeURIComponent(oldSigner.sign('user 2'))}`)

    expect(await current.json()).toEqual({ user: 'user 1' })
    expect(await rotated.json()).toEqual({ user: 'user 2' })
  })

  it('refuses missing, unsigned and forged values', async () => {
    const forged = signer.sign('user 1').replace('user 1', 'user 2')
    const responses = await Promise.all([
      request('GET', '/me'),
      request('GET', '/me', 'session=user%201'),
      request('GET', '/me', `session=${encodeURIComponent(forged)}`),
      request('GET', '/me', `session=${encodeURIComponent(new CookieSigner('other').sign('user 1'))}`),
    ])

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400])
    expect(await responses[0]!.json()).toMatchObject({ message: 'Validation failed for "session" (signed cookie is expected)' })
  })

  it('gives undefined for a missing or forged optional value', async () => {
    const missing = await request('GET', '/maybe')
    const forged = await request('GET', '/maybe', 'session=user%201.AAAA')

    expect(await missing.json()).toEqual({ user: null })
    expect(await forged.json()).toEqual({ user: null })
  })

  it('signs as value.signature in base64url and refuses empty secrets', () => {
    expect(signer.sign('a.b')).toMatch(/^a\.b\.[\w-]{43}$/)
    expect(signer.unsign(signer.sign('a.b'))).toBe('a.b')
    expect(signer.unsign('no-dot')).toBeUndefined()
    expect(() => new CookieSigner([])).toThrow('CookieSigner needs at least one secret, and no empty ones')
    expect(() => new CookieSigner('')).toThrow(TypeError)
  })
})
