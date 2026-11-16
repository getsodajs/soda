/**
 * @module
 * Naming utilities for error messages.
 */

/**
 * Readable name of a value: the name of a class or function, `String(value)` otherwise.
 *
 * ```ts
 * nameOf(UsersService) // 'UsersService'
 * nameOf(class {})     // '<anonymous class>'
 * nameOf(undefined)    // 'undefined'
 * ```
 */
export const nameOf = (value: unknown): string =>
  typeof value === 'function' ? value.name || '<anonymous class>' : String(value)

/**
 * Name of a guard, interceptor or middleware as declared: a class, a function, or an instance.
 *
 * ```ts
 * labelOf(JwtGuard)       // 'JwtGuard'
 * labelOf(new JwtGuard()) // 'JwtGuard'
 * labelOf(() => true)     // 'anonymous'
 * labelOf({ canActivate }) // 'anonymous'
 * ```
 */
export const labelOf = (value: unknown): string => {
  if (typeof value === 'function') {
    return value.name || 'anonymous'
  }

  const constructor = (value as object | null)?.constructor

  return constructor === undefined || constructor === Object ? 'anonymous' : constructor.name || 'anonymous'
}
