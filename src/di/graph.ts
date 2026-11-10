/**
 * @module
 * Module graph: modules, their providers, imports and exports.
 *
 * Built once by `createContainer`, before anything is created. What a module
 * can see is decided in `visibility.ts`.
 */

import { nameOf } from '../utils/name'
import { getInjectableOptions, getModuleDefinition } from './decorators'
import type { DynamicModule, ModuleClass, ModuleDefinition, ModuleImport } from './decorators'
import { DiError } from './errors'
import { assertConstructible, isProviderRecord } from './provider'
import type { Provider, ProviderDefinition, Scope } from './provider'
import { describeInvalidToken, isToken, tokenName } from './token'
import type { Token } from './token'
import { undefinedEntry } from './utils'
import { exportedProviders } from './visibility'

/**
 * Lifecycle of a provider node while the container creates it.
 *
 * - `idle`: not created, or creation failed and can be retried.
 * - `pending`: an async factory is running.
 * - `resolved`: `value` holds the singleton.
 */
export type NodeState = 'idle' | 'pending' | 'resolved'

/**
 * A provider inside its module. Mutable: the container stores the created value here.
 */
export interface ProviderNode {
  readonly token: Token<unknown>
  readonly module: ModuleNode
  readonly definition: ProviderDefinition
  readonly scope: Scope
  state: NodeState
  value: unknown
  promise: Promise<unknown> | undefined
}

export class ModuleNode {
  /** The module class itself, created for its lifecycle hooks; not injectable. */
  readonly instance: ProviderNode
  readonly providers = new Map<Token<unknown>, ProviderNode>()
  readonly controllers: ProviderNode[] = []
  readonly imports: ModuleNode[] = []
  /** Tokens listed in `exports`: own providers or re-exported from imports. */
  readonly exportedTokens = new Set<Token<unknown>>()
  /** Imported modules listed in `exports`, re-exported entirely. */
  readonly exportedModules = new Set<ModuleClass>()
  /** Cache of `visibleProviders`, filled while the container resolves. */
  readonly visibility = new Map<Token<unknown>, ReadonlySet<ProviderNode>>()

  constructor(
    /** Class name, for messages; dynamic modules are marked as such. */
    readonly name: string,
    readonly moduleClass: ModuleClass,
    readonly global: boolean,
    readonly definition: ModuleDefinition
  ) {
    this.instance = createNode(moduleClass, this, {
      kind: 'class',
      useClass: assertConstructible(moduleClass, moduleClass),
      scope: 'singleton',
    })
  }
}

export interface ModuleGraph {
  readonly root: ModuleNode
  /** Every module, imports before importers. */
  readonly modules: readonly ModuleNode[]
  readonly globals: readonly ModuleNode[]
  /** Providers of every module, in module order. */
  readonly providers: readonly ProviderNode[]
  /** Controllers of every module, in module order. */
  readonly controllers: readonly ProviderNode[]
}

function createNode(token: Token<unknown>, module: ModuleNode, definition: ProviderDefinition): ProviderNode {
  let scope: Scope = 'singleton'

  if (definition.kind === 'class') {
    scope = definition.scope ?? getInjectableOptions(definition.useClass)?.scope ?? 'singleton'
  } else if (definition.kind === 'factory') {
    scope = definition.scope
  }

  return { token, module, definition, scope, state: 'idle', value: undefined, promise: undefined }
}

const normalizeProvider = (owner: string, provider: Provider, index: number): [Token<unknown>, ProviderDefinition] => {
  if (provider === undefined) {
    throw new DiError('INVALID_PROVIDER', undefinedEntry(owner, 'providers', index))
  }

  if (isProviderRecord(provider)) {
    return [provider.token, provider.definition]
  }

  if (typeof provider !== 'function') {
    throw new DiError(
      'INVALID_PROVIDER',
      `providers[${index}] of ${owner} is neither a class nor a provide() result: ${nameOf(provider)}`
    )
  }

  if (getModuleDefinition(provider) !== undefined) {
    throw new DiError('INVALID_PROVIDER', `${provider.name} is a module: list it in imports of ${owner}, not in providers`)
  }

  return [provider, { kind: 'class', useClass: assertConstructible(provider, provider), scope: undefined }]
}

const mergeDefinitions = (base: ModuleDefinition, dynamic: DynamicModule): ModuleDefinition => ({
  imports: [...(base.imports ?? []), ...(dynamic.imports ?? [])],
  providers: [...(base.providers ?? []), ...(dynamic.providers ?? [])],
  controllers: [...(base.controllers ?? []), ...(dynamic.controllers ?? [])],
  exports: [...(base.exports ?? []), ...(dynamic.exports ?? [])],
  global: dynamic.global ?? base.global,
})

/**
 * Reads module definitions into nodes, one module at a time.
 */
class GraphBuilder {
  readonly #replacements = new Map<Token<unknown>, ProviderDefinition>()
  readonly #usedReplacements = new Set<Token<unknown>>()
  /** Keyed by module class for static modules, by object for dynamic ones. */
  readonly #nodes = new Map<object, ModuleNode>()
  readonly #queue: ModuleNode[] = []

  constructor(overrides: readonly Provider[]) {
    for (let i = 0, len = overrides.length; i < len; i++) {
      const [token, definition] = normalizeProvider('overrides', overrides[i]!, i)

      this.#replacements.set(token, definition)
    }
  }

  async build(root: ModuleImport): Promise<ModuleGraph> {
    const rootNode = await this.#module(root, 'createContainer()', 0)

    // The queue grows while modules are read: breadth-first over imports.
    for (let i = 0; i < this.#queue.length; i++) {
      await this.#read(this.#queue[i]!)
    }

    this.#assertReplacementsUsed()

    const modules = orderModules(rootNode)
    const globals: ModuleNode[] = []
    const providers: ProviderNode[] = []
    const controllers: ProviderNode[] = []

    for (let i = 0, len = modules.length; i < len; i++) {
      const node = modules[i]!

      assertExportsProvided(node)

      if (node.global) {
        globals.push(node)
      }

      providers.push(...node.providers.values())
      controllers.push(...node.controllers)
    }

    return { root: rootNode, modules, globals, providers, controllers }
  }

  /** Node for an `imports` entry, created on first sight. */
  async #module(entry: ModuleImport | undefined, importer: string, index: number): Promise<ModuleNode> {
    if (entry === undefined) {
      throw new DiError('INVALID_MODULE', undefinedEntry(importer, 'imports', index))
    }

    const resolved: ModuleClass | DynamicModule = entry instanceof Promise ? await entry : entry

    if (resolved === undefined || resolved === null) {
      throw new DiError('INVALID_MODULE', `imports[${index}] of ${importer} resolved to ${String(resolved)}`)
    }

    const known = this.#nodes.get(resolved)

    if (known !== undefined) {
      return known
    }

    const dynamic = typeof resolved === 'object' ? resolved : undefined
    const moduleClass = dynamic === undefined ? (resolved as ModuleClass) : dynamic.module
    const base = getModuleDefinition(moduleClass)

    if (base === undefined) {
      throw new DiError('INVALID_MODULE', `${importer} imports ${nameOf(moduleClass)}, which is not a @Module class`)
    }

    const definition = dynamic === undefined ? base : mergeDefinitions(base, dynamic)
    const name = dynamic === undefined ? moduleClass.name : `${moduleClass.name} (dynamic)`
    const node = new ModuleNode(name, moduleClass, definition.global === true, definition)

    this.#nodes.set(resolved, node)
    this.#queue.push(node)

    return node
  }

  async #read(node: ModuleNode): Promise<void> {
    const imports = node.definition.imports ?? []

    for (let i = 0, len = imports.length; i < len; i++) {
      node.imports.push(await this.#module(imports[i], node.name, i))
    }

    this.#readProviders(node)
    this.#readControllers(node)
    this.#readExports(node)
  }

  #readProviders(node: ModuleNode): void {
    const providers = node.definition.providers ?? []

    for (let i = 0, len = providers.length; i < len; i++) {
      const [token, own] = normalizeProvider(node.name, providers[i]!, i)

      if (node.providers.has(token)) {
        throw new DiError('DUPLICATE_PROVIDER', `${node.name} provides ${tokenName(token)} more than once`)
      }

      const replacement = this.#replacements.get(token)

      if (replacement !== undefined) {
        this.#usedReplacements.add(token)
      }

      node.providers.set(token, createNode(token, node, replacement ?? own))
    }
  }

  #readControllers(node: ModuleNode): void {
    const controllers = node.definition.controllers ?? []
    const seen = new Set<unknown>()

    for (let i = 0, len = controllers.length; i < len; i++) {
      const controller = controllers[i]

      if (controller === undefined) {
        throw new DiError('INVALID_PROVIDER', undefinedEntry(node.name, 'controllers', i))
      }

      if (seen.has(controller)) {
        throw new DiError('DUPLICATE_PROVIDER', `${node.name} lists controller ${controller.name} more than once`)
      }

      seen.add(controller)
      node.controllers.push(
        createNode(controller, node, {
          kind: 'class',
          useClass: assertConstructible(controller, controller),
          scope: 'singleton',
        })
      )
    }
  }

  /** Sorts `exports` into tokens and re-exported modules; must run after imports are read. */
  #readExports(node: ModuleNode): void {
    const entries = node.definition.exports ?? []

    for (let i = 0, len = entries.length; i < len; i++) {
      const entry = entries[i]

      if (entry === undefined) {
        throw new DiError('INVALID_EXPORT', undefinedEntry(node.name, 'exports', i))
      }

      if (!isToken(entry)) {
        throw new DiError('INVALID_EXPORT', `exports[${i}] of ${node.name} is ${describeInvalidToken(entry)}`)
      }

      if (getModuleDefinition(entry) === undefined) {
        node.exportedTokens.add(entry)
        continue
      }

      if (!importsModule(node, entry)) {
        throw new DiError('INVALID_EXPORT', `${node.name} exports module ${nameOf(entry)} without importing it`)
      }

      node.exportedModules.add(entry as ModuleClass)
    }
  }

  #assertReplacementsUsed(): void {
    for (const token of this.#replacements.keys()) {
      if (!this.#usedReplacements.has(token)) {
        throw new DiError('INVALID_PROVIDER', `Override for ${tokenName(token)} matches no provider in the graph`)
      }
    }
  }
}

const importsModule = (node: ModuleNode, moduleClass: unknown): boolean => {
  for (let i = 0, len = node.imports.length; i < len; i++) {
    if (node.imports[i]!.moduleClass === moduleClass) {
      return true
    }
  }

  return false
}

/** Every exported token must come from an own provider or from an import. */
const assertExportsProvided = (node: ModuleNode): void => {
  for (const token of node.exportedTokens) {
    if (!node.providers.has(token) && exportedProviders(node.imports, token).size === 0) {
      throw new DiError('INVALID_EXPORT', `${node.name} exports ${tokenName(token)}, which it neither provides nor imports`)
    }
  }
}

/** Modules reachable from `root`, each after the modules it imports. */
const orderModules = (root: ModuleNode): ModuleNode[] => {
  const ordered: ModuleNode[] = []
  const visited = new Set<ModuleNode>()

  const visit = (node: ModuleNode): void => {
    if (visited.has(node)) {
      return
    }

    visited.add(node)

    for (let i = 0, len = node.imports.length; i < len; i++) {
      visit(node.imports[i]!)
    }

    ordered.push(node)
  }

  visit(root)

  return ordered
}

/**
 * Builds the module graph rooted at `root`.
 *
 * `overrides` replace the provider of their token in every module providing it (for tests).
 */
export const buildGraph = (root: ModuleImport, overrides: readonly Provider[]): Promise<ModuleGraph> =>
  new GraphBuilder(overrides).build(root)
