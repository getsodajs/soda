/**
 * @module
 * Helpers shared by the container and the module graph.
 */

import type { ProviderNode } from './graph.ts'
import { tokenName } from './token.ts'
import type { Token } from './token.ts'

/**
 * Resolution path ending with `token`, for error messages.
 *
 * ```ts
 * chainOf([usersController, usersService], Database) // 'UsersController → UsersService → Database'
 * ```
 */
export const chainOf = (stack: readonly ProviderNode[], token: Token<unknown>): string => {
  let chain = ''

  for (let i = 0, len = stack.length; i < len; i++) {
    chain += `${tokenName(stack[i]!.token)} → `
  }

  return chain + tokenName(token)
}

/**
 * Explains an `undefined` entry of a module list, the usual symptom of a circular file import.
 */
export const undefinedEntry = (owner: string, list: string, index: number): string =>
  `${list}[${index}] of ${owner} is undefined: usually a circular file import (often through an index.ts)`

/**
 * Names of the modules owning `providers`, for ambiguity errors.
 */
export const ownersOf = (providers: ReadonlySet<ProviderNode>): string => {
  const owners: string[] = []

  for (const provider of providers) {
    owners.push(provider.module.name)
  }

  return owners.join(', ')
}
