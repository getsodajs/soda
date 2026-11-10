/**
 * @module
 * Which providers a module can reach for a token.
 *
 * A module sees, in this order of priority:
 *
 * 1. its own provider;
 * 2. the providers exported by the modules it imports;
 * 3. the providers exported by global modules.
 *
 * An explicit import wins over a global module exporting the same token, so a
 * `forFeature()` import is never overridden by a global `forRoot()` (Nest fixed
 * the same bug). Two imports exporting different providers for a token make it
 * ambiguous; Nest silently takes the first one, we report it when resolved.
 *
 * Exports are followed as a graph: a module exports a token if it provides and
 * lists it, or lists it and an import exports it, or re-exports a whole
 * imported module that exports it. One depth-first walk with a visited set per
 * query handles diamonds and cycles between modules.
 */

import type { ModuleNode, ProviderNode } from './graph'
import type { Token } from './token'

const collectFromModule = (
  node: ModuleNode,
  token: Token<unknown>,
  visited: Set<ModuleNode>,
  found: Set<ProviderNode>
): void => {
  if (visited.has(node)) {
    return
  }

  visited.add(node)

  const imports = node.imports

  if (node.exportedTokens.has(token)) {
    const own = node.providers.get(token)

    if (own !== undefined) {
      found.add(own)

      return
    }

    for (let i = 0, len = imports.length; i < len; i++) {
      collectFromModule(imports[i]!, token, visited, found)
    }

    return
  }

  for (let i = 0, len = imports.length; i < len; i++) {
    const imported = imports[i]!

    if (node.exportedModules.has(imported.moduleClass)) {
      collectFromModule(imported, token, visited, found)
    }
  }
}

/**
 * Providers that `modules`, taken together, export for `token`.
 */
export const exportedProviders = (modules: readonly ModuleNode[], token: Token<unknown>): Set<ProviderNode> => {
  const found = new Set<ProviderNode>()
  const visited = new Set<ModuleNode>()

  for (let i = 0, len = modules.length; i < len; i++) {
    collectFromModule(modules[i]!, token, visited, found)
  }

  return found
}

/**
 * Providers `node` can reach for `token`: one, none (empty set), or several when ambiguous.
 * Cached per module: the graph does not change once built.
 */
export const visibleProviders = (
  node: ModuleNode,
  token: Token<unknown>,
  globals: readonly ModuleNode[]
): ReadonlySet<ProviderNode> => {
  const cached = node.visibility.get(token)

  if (cached !== undefined) {
    return cached
  }

  const own = node.providers.get(token)
  let providers: ReadonlySet<ProviderNode>

  if (own !== undefined) {
    providers = new Set([own])
  } else {
    const imported = exportedProviders(node.imports, token)

    providers = imported.size > 0 ? imported : exportedProviders(globals, token)
  }

  node.visibility.set(token, providers)

  return providers
}
