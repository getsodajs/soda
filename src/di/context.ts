/**
 * @module
 * Injection context and `inject()`.
 *
 * The container creates instances synchronously, so the current context is a
 * plain variable set for the duration of `new Class()`: field initializers and
 * the constructor can call `inject()`, nothing else can.
 */

import { DiError } from './errors'
import { describeInvalidToken, isToken, tokenName } from './token'
import type { Token } from './token'

/**
 * Context of the class being created: resolves tokens from its module.
 */
export interface InjectionContext {
  readonly resolve: (token: Token<unknown>, optional: boolean) => unknown
}

let current: InjectionContext | undefined

/**
 * Runs `create` with `context` as the injection context; `undefined` runs it outside any context.
 */
export const runInContext = <T>(context: InjectionContext | undefined, create: () => T): T => {
  const previous = current

  current = context

  try {
    return create()
  } finally {
    current = previous
  }
}

/**
 * Options of `inject()`.
 */
export interface InjectOptions {
  /** Return `undefined` instead of throwing when no provider is visible. */
  readonly optional?: boolean
}

/**
 * Returns the dependency for `token`, from the module that provides the class being created.
 *
 * ```ts
 * class UsersService {
 *   readonly #db = inject(Database)
 *   readonly #logger = inject(Logger, { optional: true }) // Logger | undefined
 * }
 * ```
 */
export function inject<T>(token: Token<T>): T
export function inject<T>(token: Token<T>, options: InjectOptions & { readonly optional: true }): T | undefined
export function inject<T>(token: Token<T>, options?: InjectOptions): T | undefined
export function inject<T>(token: Token<T>, options?: InjectOptions): T | undefined {
  if (!isToken(token)) {
    throw new DiError('INVALID_PROVIDER', `inject() received a token that is ${describeInvalidToken(token)}`)
  }

  if (current === undefined) {
    throw new DiError(
      'OUTSIDE_INJECTION_CONTEXT',
      `inject(${tokenName(token)}) was called outside of an injection context. ` +
        'Call it in a field initializer or the constructor of a class created by the container, ' +
        'or inside container.runInContext(); factories receive their dependencies through `inject: [...]`.'
    )
  }

  return current.resolve(token, options?.optional === true) as T | undefined
}
