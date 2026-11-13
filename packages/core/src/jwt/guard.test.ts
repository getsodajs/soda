import { afterAll, describe, expect, it } from 'bun:test'
import { createApp } from '../app/app.ts'
import { InjectionToken, Module, provide } from '../di/index.ts'
import { value } from '../http/arguments.ts'
import { Controller, Get } from '../http/decorators.ts'
import { UseGuards } from '../http/enhancers.ts'
import { JWT_PAYLOAD, JwtGuard } from './guard.ts'
import { JwtModule } from './module.ts'
import { JwtService } from './service.ts'
import type { JwtPayload } from './service.ts'

const SECRET = 'a-secret-long-enough-for-hs256-tokens'
const CONFIG = new InjectionToken<{ readonly secret: string }>('CONFIG')

@Controller('me')
@UseGuards(JwtGuard)
class MeController {
  @Get([value(JWT_PAYLOAD)])
  me(payload: JwtPayload) {
    return { sub: payload.sub }
  }
}

@Module({ providers: [provide(CONFIG, { useValue: { secret: SECRET } })], exports: [CONFIG] })
class ConfigModule {}

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [CONFIG],
      useFactory: (config) => ({ secret: config.secret, expiresIn: 60, cookie: 'token' }),
    }),
  ],
  controllers: [MeController],
})
class AppModule {}

const app = await createApp(AppModule, { logger: false })
const server = await app.listen(0)
const jwt = app.container.get(JwtService)

afterAll(() => app.close())

const me = (headers: Record<string, string> = {}) => fetch(new URL('/me', server.url), { headers })

describe('JwtGuard', () => {
  it('lets in a bearer token, or the token cookie, passing the payload on', async () => {
    const token = await jwt.sign({ sub: 'user-1' })
    const bearer = await me({ authorization: `Bearer ${token}` })
    const cookie = await me({ cookie: `token=${token}` })

    expect(await bearer.json()).toEqual({ sub: 'user-1' })
    expect(await cookie.json()).toEqual({ sub: 'user-1' })
  })

  it('answers 401 with the RFC 6750 challenge', async () => {
    const expired = await jwt.sign({ sub: 'user-1' }, { expiresIn: -1 })
    const cases = [
      [{}, 'Missing token', 'Bearer'],
      [{ authorization: 'Basic dXNlcjpwYXNz' }, 'Authorization is not a bearer token', 'Bearer error="invalid_request"'],
      [{ authorization: `Bearer ${expired}` }, 'Token expired', 'Bearer error="invalid_token"'],
      [{ authorization: 'Bearer a.b.c' }, 'Token header is not a JSON object', 'Bearer error="invalid_token"'],
      // The header wins over the cookie: a bad header is not saved by a good cookie.
      [{ authorization: 'Bearer x', cookie: `token=${await jwt.sign({})}` }, 'Token is not three base64url parts', 'Bearer error="invalid_token"'],
    ] as const

    for (const [headers, message, challenge] of cases) {
      const response = await me(headers)

      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(challenge)
      expect(await response.json()).toMatchObject({ message })
    }
  })

  it('is configured by register() too, and shared as a global module', async () => {
    @Controller('other')
    @UseGuards(JwtGuard)
    class OtherController {
      @Get([value(JWT_PAYLOAD)])
      read(payload: JwtPayload) {
        return payload.sub
      }
    }

    @Module({ controllers: [OtherController] })
    class OtherModule {}

    @Module({ imports: [JwtModule.register({ secret: SECRET, global: true }), OtherModule] })
    class GlobalModule {}

    const other = await createApp(GlobalModule, { logger: false })
    const otherServer = await other.listen(0)
    const response = await fetch(new URL('/other', otherServer.url), {
      headers: { authorization: `Bearer ${await jwt.sign({ sub: 'user-2' })}` },
    })

    expect(await response.text()).toBe('user-2')
    await other.close()
  })
})
