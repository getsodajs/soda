import { ContextKey } from '@getsoda/core'
import type { CanActivate, Context } from '@getsoda/core'

export interface CurrentUser {
  readonly name: string
}

/** The user the guard found; handlers read it with `ctx.get(CURRENT_USER)` or `value(CURRENT_USER)`. */
export const CURRENT_USER = new ContextKey<CurrentUser>('currentUser')

/**
 * Accepts `Authorization: Bearer <name>`. A placeholder: verify real tokens here.
 */
export class AuthGuard implements CanActivate {
  canActivate(ctx: Context): boolean {
    const header = ctx.header('authorization')

    if (header === undefined || !header.startsWith('Bearer ')) {
      return false
    }

    ctx.set(CURRENT_USER, { name: header.slice('Bearer '.length) })

    return true
  }
}
