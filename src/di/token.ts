/**
 * @module
 * Injection tokens.
 */

declare const VALUE: unique symbol

/**
 * Token for a dependency that is not a class: an interface, a configuration object, a primitive.
 *
 * ```ts
 * interface Config { readonly url: string }
 * const CONFIG = new InjectionToken<Config>('CONFIG')
 * ```
 */
export class InjectionToken<T> {
  /** Carries `T` for type inference only, never set. */
  declare readonly [VALUE]?: T

  constructor(readonly description: string) {}

  toString(): string {
    return `InjectionToken(${this.description})`
  }
}

/**
 * Class usable as a token, abstract classes included: `abstract class Logger {}`.
 */
export type ClassToken<T> = abstract new (...args: never[]) => T

/**
 * Class the container can create: its dependencies come from `inject()`, not from arguments.
 */
export type Constructor<T> = new () => T

/**
 * Anything a dependency can be requested by.
 */
export type Token<T> = ClassToken<T> | InjectionToken<T>

/**
 * Value type behind a token.
 *
 * ```ts
 * TokenValue<typeof CONFIG> // Config
 * TokenValue<typeof Logger> // Logger
 * ```
 */
export type TokenValue<K> = K extends InjectionToken<infer T> ? T : K extends ClassToken<infer T> ? T : never

/**
 * Human-readable name of a token, for error messages.
 */
export const tokenName = (token: Token<unknown>): string =>
  token instanceof InjectionToken ? token.toString() : token.name || '<anonymous class>'

/**
 * `true` for a value usable as a token.
 *
 * A token that is `undefined` at runtime almost always comes from a circular
 * file import (often through a barrel `index.ts`) or from `import type`.
 */
export const isToken = (value: unknown): value is Token<unknown> =>
  typeof value === 'function' || value instanceof InjectionToken

/**
 * Explains why `value` is not a token, for error messages.
 */
export const describeInvalidToken = (value: unknown): string =>
  value === undefined
    ? 'undefined: usually a circular file import (often through an index.ts) or `import type` of a class'
    : `${String(value)}: tokens are classes or InjectionToken instances`
