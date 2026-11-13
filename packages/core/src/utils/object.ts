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

/**
 * Public method names along the prototype chain, most derived first, without duplicates.
 */
export const methodNames = (instance: object): string[] => {
  const names: string[] = []
  const seen = new Set<string>(['constructor'])

  for (
    let prototype: object | null = Object.getPrototypeOf(instance);
    prototype !== null && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (!seen.has(name)) {
        seen.add(name)
        names.push(name)
      }
    }
  }

  return names
}
