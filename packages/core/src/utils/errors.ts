/**
 * @module
 * Error utilities.
 */

import { fileURLToPath } from 'node:url'

/** Where the framework's own files are: `src/` from sources, `dist/` once built. */
export const FRAMEWORK = fileURLToPath(new URL('../', import.meta.url))

/**
 * Removes the frames of the framework from the stack of an error about the
 * application's code (a missing provider, an invalid route): the runtime then
 * points at the application, not at the framework, and the message says the rest.
 */
export const hideFrameworkFrames = (error: Error): void => {
  if (error.stack === undefined) {
    return
  }

  error.stack = error.stack
    .split('\n')
    .filter((line) => !(line.trimStart().startsWith('at ') && line.includes(FRAMEWORK)))
    .join('\n')
}

/**
 * Where an error about the application's code is, for `soda check` to find
 * it in the sources when the stack cannot tell (Bun gives no location to
 * frames of field initializers): the class, then the first of `text` in it.
 */
export interface SourceSite {
  readonly class?: string
  readonly text: readonly string[]
}

const sites = new WeakMap<Error, SourceSite>()

/** Attaches `site` to `error`, and returns the error. */
export const atSite = <E extends Error>(error: E, site: SourceSite): E => {
  sites.set(error, site)

  return error
}

export const siteOf = (error: Error): SourceSite | undefined => sites.get(error)

/** `'name'` and `"name"`, as an argument may be written. */
export const quoted = (prefix: string, name: string): string[] => [`${prefix}'${name}'`, `${prefix}"${name}"`, `${prefix}\`${name}\``]
