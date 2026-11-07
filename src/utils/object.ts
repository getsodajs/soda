/**
 * @module
 * Object utilities.
 */

/**
 * Creates an object without prototype, safe as a dictionary: keys such as
 * `__proto__`, `constructor` or `toString` are plain keys.
 *
 * ```ts
 * const params = createNullObject<Record<string, string>>()
 * ```
 */
export const createNullObject = <T extends object>(): T => Object.create(null) as T
