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
