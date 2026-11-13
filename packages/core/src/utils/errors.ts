/**
 * @module
 * Error utilities.
 */

import { fileURLToPath } from 'node:url'

/** Where the framework's own files are: `src/` from sources, `dist/` once built. */
const FRAMEWORK = fileURLToPath(new URL('../', import.meta.url))

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
