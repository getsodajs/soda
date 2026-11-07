/**
 * @module
 * Promise utilities.
 */

/**
 * `true` for a promise or any object with a `then` method, as `await` treats it.
 */
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
