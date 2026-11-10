/**
 * @module
 * The container: creates every singleton at startup, runs lifecycle hooks, resolves tokens.
 *
 * Startup, in `createContainer`:
 *
 * 1. Build the module graph and validate it (awaiting `Promise<DynamicModule>` imports).
 * 2. Run singleton factories, awaiting async ones. Their dependencies are
 *    declared in `inject: [...]`, so the async part of the graph is static.
 * 3. Create every other singleton (providers, controllers, module classes),
 *    synchronously; `inject()` resolves dependencies, creating them on demand.
 * 4. Call `onInit` on everything created, dependencies first.
 *
 * Any failure destroys what was created, in reverse order, and rejects.
 * Nothing is resolved lazily on the request path: once the container is
 * returned, every singleton exists.
 */

import { isThenable } from '../utils/promise'
import { runInContext } from './context'
import type { InjectionContext } from './context'
import type { ModuleClass, ModuleImport } from './decorators'
import { DiError } from './errors'
import { buildGraph } from './graph'
import type { ModuleGraph, ModuleNode, ProviderNode } from './graph'
import { destroyAll, initializeAll } from './lifecycle'
import type { Provider, ProviderDefinition } from './provider'
import { tokenName } from './token'
import type { Constructor, Token } from './token'
import { chainOf, ownersOf } from './utils'
import { visibleProviders } from './visibility'

/**
 * Options of `createContainer`.
 */
export interface ContainerOptions {
  /**
   * Providers replacing those of the same token everywhere in the graph, for tests.
   * An override that matches no provider is an error.
   *
   * ```ts
   * await createContainer(AppModule, { overrides: [provide(Database, { useValue: fakeDatabase })] })
   * ```
   */
  readonly overrides?: readonly Provider[]
}

/**
 * Options of `container.get()` and `container.runInContext()`.
 */
export interface ResolveOptions {
  /** Module to resolve from, instead of the root module. */
  readonly from?: ModuleClass
}

/**
 * A controller created by the container, with the module that owns it.
 */
export interface ControllerEntry {
  readonly module: ModuleClass
  readonly controller: Constructor<unknown>
  readonly instance: unknown
  /**
   * Runs `fn` where `inject()` resolves from the controller's module, as Nest
   * resolves guards and interceptors from the module of their controller.
   */
  readonly runInContext: <R>(fn: () => R) => R
}

/**
 * A started container.
 */
export interface Container {
  /** Resolves `token` as `inject()` would inside the root module, or inside `options.from`. */
  get<T>(token: Token<T>, options?: ResolveOptions & { readonly optional?: false }): T
  get<T>(token: Token<T>, options: ResolveOptions & { readonly optional: true }): T | undefined
  /**
   * Runs `fn` where `inject()` works, as if it were created by the root module
   * (or `options.from`): for functional guards, middleware and the like.
   */
  runInContext<R>(fn: () => R, options?: ResolveOptions): R
  /** Every controller, in module order. */
  readonly controllers: readonly ControllerEntry[]
  /**
   * Calls `onDestroy` in reverse creation order, then releases every instance.
   * Calling it again, even from an `onDestroy` hook, returns the same promise.
   */
  close(): Promise<void>
}

type FactoryDefinition = Extract<ProviderDefinition, { readonly kind: 'factory' }>

/**
 * Creates instances and keeps the resolution stack used for cycle detection and messages.
 */
class Resolver {
  /** Values whose lifecycle the container owns, in creation order. */
  readonly created: unknown[] = []
  /** Async factories started; awaited before rolling back a failed startup. They never reject. */
  readonly started: Promise<unknown>[] = []
  /** Transient instances are lifecycle-managed only while starting up. */
  starting = true
  readonly #graph: ModuleGraph
  readonly #stack: ProviderNode[] = []

  constructor(graph: ModuleGraph) {
    this.#graph = graph
  }

  /** Provider for `token` as seen from `module`. */
  lookup(module: ModuleNode, token: Token<unknown>, optional: boolean): ProviderNode | undefined {
    const providers = visibleProviders(module, token, this.#graph.globals)

    if (providers.size === 1) {
      for (const provider of providers) {
        return provider
      }
    }

    if (providers.size > 1) {
      throw new DiError(
        'AMBIGUOUS_PROVIDER',
        `${tokenName(token)} is exported to ${module.name} by several imports with different providers ` +
          `(${ownersOf(providers)}; ${chainOf(this.#stack, token)}). Provide it in ${module.name} or import only one of them.`
      )
    }

    if (optional) {
      return undefined
    }

    throw new DiError(
      'NO_PROVIDER',
      `No provider for ${tokenName(token)} in ${module.name} (${chainOf(this.#stack, token)}).${this.#hint(module, token)}`
    )
  }

  /** Value of `token` for code running in `module`, created synchronously if needed. */
  resolve(module: ModuleNode, token: Token<unknown>, optional: boolean): unknown {
    const requester = this.#stack[this.#stack.length - 1]

    if (requester !== undefined && requester.token === token && requester.module === module) {
      throw new DiError(
        'CIRCULAR_DEPENDENCY',
        `${tokenName(token)} injects its own token (${chainOf(this.#stack, token)}). To wrap a provider from ` +
          'another module, provide the wrapper under a different token.'
      )
    }

    const node = this.lookup(module, token, optional)

    return node === undefined ? undefined : this.get(node)
  }

  /** Value of `node`, created synchronously if needed. */
  get(node: ProviderNode): unknown {
    if (node.state === 'resolved') {
      return node.value
    }

    if (node.state === 'pending') {
      throw new DiError(
        'ASYNC_DEPENDENCY',
        `${chainOf(this.#stack, node.token)}: ${tokenName(node.token)} comes from an async factory that has not ` +
          'finished yet. A factory needing this chain must list it in its `inject`.'
      )
    }

    const definition = node.definition

    if (definition.kind === 'value') {
      this.#store(node, definition.value)

      return definition.value
    }

    this.#enter(node)

    try {
      // Not cached: an alias of a transient provider yields a new instance each time.
      if (definition.kind === 'existing') {
        return this.resolve(node.module, definition.target, false)
      }

      const value =
        definition.kind === 'class' ? this.#construct(node, definition.useClass) : this.#callFactory(node, definition)

      if (node.scope === 'singleton') {
        this.#store(node, value)
      } else if (this.starting) {
        this.created.push(value)
      }

      return value
    } finally {
      this.#stack.pop()
    }
  }

  /** Runs a singleton factory, awaiting async dependencies and an async result. */
  async getAsync(node: ProviderNode): Promise<unknown> {
    const definition = node.definition

    if (definition.kind === 'existing') {
      return this.getAsync(this.#target(node))
    }

    if (definition.kind !== 'factory' || node.scope !== 'singleton' || node.state === 'resolved') {
      return this.get(node)
    }

    if (node.state === 'pending') {
      return node.promise
    }

    this.#enter(node)

    try {
      const values: unknown[] = []
      const dependencies = definition.dependencies

      for (let i = 0, len = dependencies.length; i < len; i++) {
        const { token, optional } = dependencies[i]!
        const dependency = this.lookup(node.module, token, optional)

        values.push(dependency === undefined ? undefined : await this.getAsync(dependency))
      }

      const result = runInContext(undefined, () => definition.useFactory(...values))

      if (!isThenable(result)) {
        this.#store(node, result)

        return result
      }

      return await this.#track(node, result)
    } finally {
      this.#stack.pop()
    }
  }

  /** Drops every instance so a closed container can be garbage-collected. */
  release(): void {
    this.created.length = 0
    this.started.length = 0

    const { providers, controllers, modules } = this.#graph

    for (let i = 0, len = providers.length; i < len; i++) {
      providers[i]!.value = undefined
    }

    for (let i = 0, len = controllers.length; i < len; i++) {
      controllers[i]!.value = undefined
    }

    for (let i = 0, len = modules.length; i < len; i++) {
      modules[i]!.instance.value = undefined
    }
  }

  /** Pushes `node` on the resolution stack, rejecting cycles. */
  #enter(node: ProviderNode): void {
    if (this.#stack.includes(node)) {
      throw new DiError('CIRCULAR_DEPENDENCY', `Circular dependency: ${chainOf(this.#stack, node.token)}`)
    }

    this.#stack.push(node)
  }

  #construct(node: ProviderNode, useClass: Constructor<unknown>): unknown {
    const context: InjectionContext = { resolve: (token, optional) => this.resolve(node.module, token, optional) }

    return runInContext(context, () => new useClass())
  }

  /** Calls a factory synchronously, for transient factories and singletons needed before their turn. */
  #callFactory(node: ProviderNode, definition: FactoryDefinition): unknown {
    const values: unknown[] = []
    const dependencies = definition.dependencies

    for (let i = 0, len = dependencies.length; i < len; i++) {
      const dependency = dependencies[i]!

      values.push(this.resolve(node.module, dependency.token, dependency.optional))
    }

    const value = runInContext(undefined, () => definition.useFactory(...values))

    if (!isThenable(value)) {
      return value
    }

    // Startup fails here, but the factory is running: track it so that the
    // rollback destroys its result (an open connection must not leak).
    void this.#track(node, value).catch(() => undefined)

    if (node.scope === 'transient') {
      throw new DiError(
        'INVALID_PROVIDER',
        `The transient factory of ${tokenName(node.token)} returned a promise; only singleton factories can be async`
      )
    }

    throw new DiError(
      'ASYNC_DEPENDENCY',
      `${chainOf(this.#stack, node.token)}: the factory of ${tokenName(node.token)} is async and a class needs ` +
        'it before async factories ran. List it in the `inject` of the factory that needs this chain.'
    )
  }

  /** Follows an async factory result: stores it when it settles, keeps startup able to wait for it. */
  #track(node: ProviderNode, result: PromiseLike<unknown>): Promise<unknown> {
    const singleton = node.scope === 'singleton'
    const promise = Promise.resolve(result).then(
      (value) => {
        node.promise = undefined

        if (singleton) {
          this.#store(node, value)
        } else {
          this.created.push(value)
        }

        return value
      },
      (error: unknown) => {
        node.promise = undefined
        node.state = 'idle'

        throw error
      }
    )

    if (singleton) {
      node.state = 'pending'
      node.promise = promise
    }

    this.started.push(promise.catch(() => undefined))

    return promise
  }

  /** Provider an alias points to, with alias cycles reported. */
  #target(alias: ProviderNode): ProviderNode {
    const definition = alias.definition

    if (definition.kind !== 'existing') {
      return alias
    }

    this.#enter(alias)

    try {
      return this.#target(this.lookup(alias.module, definition.target, false)!)
    } finally {
      this.#stack.pop()
    }
  }

  #store(node: ProviderNode, value: unknown): void {
    node.state = 'resolved'
    node.value = value
    this.created.push(value)
  }

  /** Explains where an unreachable token is provided, if anywhere. */
  #hint(module: ModuleNode, token: Token<unknown>): string {
    const modules = this.#graph.modules

    for (let i = 0, len = modules.length; i < len; i++) {
      const candidate = modules[i]!

      if (candidate.providers.has(token)) {
        return candidate.exportedTokens.has(token)
          ? ` ${candidate.name} exports it: add ${candidate.name} to the imports of ${module.name}.`
          : ` ${candidate.name} provides it but does not export it.`
      }
    }

    return ''
  }
}



class StartedContainer implements Container {
  readonly controllers: readonly ControllerEntry[]
  readonly #graph: ModuleGraph
  readonly #resolver: Resolver
  #closing: Promise<void> | undefined

  constructor(graph: ModuleGraph, resolver: Resolver, controllers: readonly ControllerEntry[]) {
    this.#graph = graph
    this.#resolver = resolver
    this.controllers = controllers
  }

  get<T>(token: Token<T>, options?: ResolveOptions & { readonly optional?: false }): T
  get<T>(token: Token<T>, options: ResolveOptions & { readonly optional: true }): T | undefined
  get<T>(token: Token<T>, options: ResolveOptions & { readonly optional?: boolean } = {}): T | undefined {
    this.#assertOpen(`get ${tokenName(token)}`)

    return this.#resolver.resolve(this.#moduleOf(options.from), token, options.optional === true) as T | undefined
  }

  runInContext<R>(fn: () => R, options: ResolveOptions = {}): R {
    this.#assertOpen('run in context')

    const module = this.#moduleOf(options.from)

    return runInContext({ resolve: (token, optional) => this.#resolver.resolve(module, token, optional) }, fn)
  }

  close(): Promise<void> {
    if (this.#closing === undefined) {
      // Assigned before any hook runs, so a hook calling close() gets this promise.
      const { promise, resolve, reject } = Promise.withResolvers<void>()

      this.#closing = promise
      destroyAll(this.#resolver.created)
        .then(resolve, reject)
        .finally(() => this.#resolver.release())
    }

    return this.#closing
  }

  #assertOpen(action: string): void {
    if (this.#closing !== undefined) {
      throw new DiError('CONTAINER_CLOSED', `Cannot ${action}: the container is closed`)
    }
  }

  #moduleOf(moduleClass: ModuleClass | undefined): ModuleNode {
    if (moduleClass === undefined) {
      return this.#graph.root
    }

    let found: ModuleNode | undefined
    const modules = this.#graph.modules

    for (let i = 0, len = modules.length; i < len; i++) {
      if (modules[i]!.moduleClass !== moduleClass) {
        continue
      }

      if (found !== undefined) {
        throw new DiError(
          'INVALID_MODULE',
          `${moduleClass.name} is imported several times as different dynamic modules; cannot tell which one to use`
        )
      }

      found = modules[i]
    }

    if (found === undefined) {
      throw new DiError('INVALID_MODULE', `${moduleClass.name} is not part of this container`)
    }

    return found
  }
}

/**
 * Creates every singleton of `graph`: factories first, then providers, controllers, module classes.
 */
const createAll = async (graph: ModuleGraph, resolver: Resolver): Promise<ControllerEntry[]> => {
  const { providers, controllers, modules } = graph

  for (let i = 0, len = providers.length; i < len; i++) {
    const node = providers[i]!

    if (node.definition.kind === 'factory' && node.scope === 'singleton') {
      await resolver.getAsync(node)
    }
  }

  for (let i = 0, len = providers.length; i < len; i++) {
    const node = providers[i]!

    if (node.scope === 'singleton') {
      resolver.get(node)
    }
  }

  const entries: ControllerEntry[] = []

  for (let i = 0, len = controllers.length; i < len; i++) {
    const node = controllers[i]!

    const module = node.module
    const context: InjectionContext = { resolve: (token, optional) => resolver.resolve(module, token, optional) }

    entries.push({
      module: module.moduleClass,
      controller: node.token as Constructor<unknown>,
      instance: resolver.get(node),
      runInContext: (fn) => runInContext(context, fn),
    })
  }

  for (let i = 0, len = modules.length; i < len; i++) {
    resolver.get(modules[i]!.instance)
  }

  return entries
}

/**
 * Builds the graph rooted at `root`, creates every singleton and runs `onInit` hooks.
 *
 * ```ts
 * const container = await createContainer(AppModule)
 * const users = container.get(UsersService)
 * await container.close()
 * ```
 *
 * Rejects with `DiError` on graph problems. If startup fails after something was
 * created, `onDestroy` runs for it first and the startup error is rethrown; if
 * hooks fail too, everything is rethrown as one `AggregateError`, startup error first.
 */
export const createContainer = async (root: ModuleImport, options: ContainerOptions = {}): Promise<Container> => {
  const graph = await buildGraph(root, options.overrides ?? [])
  const resolver = new Resolver(graph)

  try {
    const controllers = await createAll(graph, resolver)

    resolver.starting = false
    await initializeAll(resolver.created)

    return new StartedContainer(graph, resolver, controllers)
  } catch (error) {
    await Promise.all(resolver.started)

    try {
      await destroyAll(resolver.created)
    } catch (destroyError) {
      const errors = destroyError instanceof AggregateError ? destroyError.errors : [destroyError]

      throw new AggregateError([error, ...errors], 'Startup failed, and onDestroy hooks failed while rolling back')
    } finally {
      resolver.release()
    }

    throw error
  }
}
