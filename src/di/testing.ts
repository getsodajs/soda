/**
 * @module
 * Test helpers for the DI container. Not part of the public API.
 */

import { expect } from 'bun:test'
import { DiError } from './errors.ts'
import type { DiErrorCode } from './errors.ts'

/**
 * Asserts that `run` throws or rejects with a `DiError` of `code` whose message matches `message`.
 */
export const expectDiError = async (
  run: () => unknown,
  code: DiErrorCode,
  message: RegExp
): Promise<DiError> => {
  let error: unknown

  try {
    await run()
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(DiError)
  expect({ code: (error as DiError).code, message: (error as DiError).message }).toEqual({
    code,
    message: expect.stringMatching(message),
  })

  return error as DiError
}
