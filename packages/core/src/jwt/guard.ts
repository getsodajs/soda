/**
 * @module
 * `JwtGuard`: lets in requests carrying a valid token, the way
 * `AuthGuard('jwt')` of `@nestjs/passport` does.
 */

import { inject } from '../di/index.ts'
import type { Context } from '../http/context.ts'
import { ContextKey } from '../http/context-key.ts'
import type { CanActivate } from '../http/enhancers.ts'
import { UnauthorizedException } from '../http/exceptions.ts'
import { ApiBearerAuth, ApiResponses } from '../openapi/decorators.ts'
import { JwtError } from './errors.ts'
import { JWT_OPTIONS } from './module.ts'
import { JwtService } from './service.ts'
import type { JwtPayload } from './service.ts'

/** Payload of the token `JwtGuard` accepted: `ctx.get(JWT_PAYLOAD)` or `value(JWT_PAYLOAD)`. */
export const JWT_PAYLOAD = new ContextKey<JwtPayload>('jwtPayload')

const BEARER = /^Bearer +(\S+) *$/i

/** A 401 with the `WWW-Authenticate` challenge of RFC 6750. */
const unauthorized = (message: string, challenge: string, cause?: unknown): UnauthorizedException =>
  new UnauthorizedException(message, { cause, headers: { 'www-authenticate': challenge } })

/**
 * Accepts a request whose token `JwtService` verifies, read from
 * `Authorization: Bearer <token>` or, without that header, from the cookie
 * named by the `cookie` option of `JwtModule`. The payload goes to
 * {@link JWT_PAYLOAD}; anything else is a `401`.
 *
 * ```ts
 * @Get('me', [value(JWT_PAYLOAD)])
 * @UseGuards(JwtGuard)
 * me(payload: JwtPayload) {}
 * ```
 *
 * Needs `JwtModule` imported in the controller's module, or registered as global.
 * In the OpenAPI document, the routes it guards need a bearer token and may answer `401`.
 */
@ApiBearerAuth()
@ApiResponses({ 401: { description: 'Missing or invalid token' } })
export class JwtGuard implements CanActivate {
  readonly #jwt = inject(JwtService)
  readonly #cookie = inject(JWT_OPTIONS).cookie

  async canActivate(ctx: Context): Promise<boolean> {
    const header = ctx.header('authorization')
    let token: string | undefined

    if (header !== undefined) {
      token = BEARER.exec(header)?.[1]

      if (token === undefined) {
        throw unauthorized('Authorization is not a bearer token', 'Bearer error="invalid_request"')
      }
    } else if (this.#cookie !== undefined) {
      token = ctx.cookie(this.#cookie)
    }

    if (token === undefined) {
      throw unauthorized('Missing token', 'Bearer')
    }

    try {
      ctx.set(JWT_PAYLOAD, await this.#jwt.verify(token))
    } catch (error) {
      if (error instanceof JwtError) {
        throw unauthorized(error.message, 'Bearer error="invalid_token"', error)
      }

      throw error
    }

    return true
  }
}
