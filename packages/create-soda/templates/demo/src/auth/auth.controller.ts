import { body, Controller, context, Get, HttpCode, inject, Post, UseGuards, value } from '@getsoda/core'
import type { Context } from '@getsoda/core'
import { JWT_PAYLOAD, JwtGuard, JwtService } from '@getsoda/core/jwt'
import type { JwtPayload } from '@getsoda/core/jwt'
import { z } from 'zod'
import { TOKEN_COOKIE, TOKEN_LIFETIME } from './token.ts'

const Login = z.object({ name: z.string().trim().min(1) })

@Controller('auth')
export class AuthController {
  readonly #jwt = inject(JwtService)

  /**
   * Signs anyone in by name: check a password or another credential here.
   * The token is returned for API clients and set as a cookie for browsers,
   * where scripts cannot read it.
   */
  @Post('login', [body(Login), context()])
  async login(input: z.infer<typeof Login>, ctx: Context): Promise<{ token: string }> {
    const token = await this.#jwt.sign({ sub: input.name })

    ctx.cookies.set(TOKEN_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: TOKEN_LIFETIME })

    return { token }
  }

  @Post('logout', [context()])
  @HttpCode(204)
  logout(ctx: Context): void {
    ctx.cookies.delete(TOKEN_COOKIE)
  }

  @Get('me', [value(JWT_PAYLOAD)])
  @UseGuards(JwtGuard)
  me(payload: JwtPayload): { name: string | undefined } {
    return { name: payload.sub }
  }
}
