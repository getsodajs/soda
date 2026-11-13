/**
 * @module
 * Typed keys for values attached to a request: what a guard found (the user,
 * the tenant), read later by interceptors and the handler.
 *
 * Like Angular's `HttpContextToken`: the key is an object, so two keys can
 * never collide, and it carries the value type. Unlike it, a default is
 * optional: reading a key nobody set and that has no default is a programming
 * error (a guard missing on the route), reported as such.
 *
 * ```ts
 * export const USER = new ContextKey<User>('user')
 *
 * // guard
 * ctx.set(USER, await this.#auth.verify(ctx.header('authorization')))
 *
 * // handler
 * const user = ctx.get(USER)
 * ```
 */

/**
 * Key of a value attached to a request.
 */
export class ContextKey<T> {
  constructor(
    readonly description: string,
    /** Value of the key when nothing was set. Without it, reading an unset key throws. */
    readonly defaultValue?: () => T
  ) {}

  toString(): string {
    return `ContextKey(${this.description})`
  }
}
