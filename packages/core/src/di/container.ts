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

import { atSite } from '../utils/errors.ts'
import { isThenable } from '../utils/promise.ts'
import { runInContext } from './context.ts'
import type { InjectionContext } from './context.ts'
import { Module } from './decorators.ts'
import { attachDiscovery, Discovery } from './discovery.ts'
import type { DiscoveredProvider } from './discovery.ts'
import type { DynamicModule, ModuleClass, ModuleImport } from './decorators.ts'
import { isSafeToCheck, STUB } from './dry.ts'
import type { DescribedDependency, DescribedModule, DescribedProvider, ReportProblem } from './dry.ts'
import { DiError } from './errors.ts'
import { buildGraph } from './graph.ts'
import type { ModuleGraph, ModuleNode, ProviderNode } from './graph.ts'
import { destroyAll, initializeAll } from './lifecycle.ts'
import { isProviderRecord, provide } from './provider.ts'
import type { Provider, ProviderDefinition } from './provider.ts'
import { tokenName } from './token.ts'
import type { Constructor, Token } from './token.ts'
import { chainOf, ownersOf } from './utils.ts'
import { visibleProviders } from './visibility.ts'

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
  /**
   * Providers visible in every module, as if exported by a global module:
   * what the application itself provides, such as its `Logger`.
   */
  readonly providers?: readonly Provider[]
}

/** Module holding `ContainerOptions.providers`. */
@Module({})
class ContainerProvidersModule {}

/** Name of a module in descriptions: `application` for the one holding what the application provides. */
const moduleName = (module: ModuleNode): string => (module.moduleClass === ContainerProvidersModule ? 'application' : module.name)

const KINDS: Readonly<Record<ProviderDefinition['kind'], DescribedProvider['kind']>> = {
  class: 'class',
  value: 'value',
  factory: 'factory',
  existing: 'alias',
}

const providersModule = (providers: readonly Provider[]): DynamicModule => {
  const exports: Token<unknown>[] = []

  for (const provider of providers) {
    exports.push(isProviderRecord(provider) ? provider.token : provider)
  }

  return { module: ContainerProvidersModule, providers, exports, global: true }
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
  /** Every module, imports before importers. */
  readonly modules: readonly ModuleClass[]
  /** Number of providers of the modules. */
  readonly providerCount: number
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
  /** Set for a dry run: problems are reported and give stubs. */
  readonly #report: ReportProblem | undefined
  /** Stubs handed out in a dry run, to tell a class failing on its own from one failing on a stub. */
  #stubs = 0
  /** In a dry run, what each provider asked for, by token. */
  readonly dependencies = new Map<ProviderNode, Map<Token<unknown>, DescribedDependency>>()

  constructor(graph: ModuleGraph, report?: ReportProblem) {
    this.#graph = graph
    this.#report = report
  }

  /** Provider for `token` as seen from `module`; in a dry run, recorded as a dependency of the provider being created. */
  lookup(module: ModuleNode, token: Token<unknown>, optional: boolean): ProviderNode | undefined {
    const requester = this.#report === undefined ? undefined : this.#stack.at(-1)

    if (requester === undefined) {
      return this.#find(module, token, optional)
    }

    let found: ProviderNode | undefined

    try {
      found = this.#find(module, token, optional)

      return found
    } finally {
      let asked = this.dependencies.get(requester)

      if (asked === undefined) {
        asked = new Map()
        this.dependencies.set(requester, asked)
      }

      asked.set(token, { token: tokenName(token), optional, from: found === undefined ? undefined : moduleName(found.module) })
    }
  }

  #find(module: ModuleNode, token: Token<unknown>, optional: boolean): ProviderNode | undefined {
    const providers = visibleProviders(module, token, this.#graph.globals)

    if (providers.size === 1) {
      for (const provider of providers) {
        return provider
      }
    }

    if (providers.size > 1) {
      throw this.#located(token, new DiError(
        'AMBIGUOUS_PROVIDER',
        `${tokenName(token)} is exported to ${module.name} by several imports with different providers ` +
          `(${ownersOf(providers)}; ${chainOf(this.#stack, token)}). Provide it in ${module.name} or import only one of them.`
      ))
    }

    if (optional) {
      return undefined
    }

    throw this.#located(
      token,
      new DiError('NO_PROVIDER', `No provider for ${tokenName(token)} in ${module.name} (${chainOf(this.#stack, token)}).`, this.#hint(module, token))
    )
  }

  /** The `inject()` call in the class asking for `token`, for `soda check`. */
  #located(token: Token<unknown>, error: DiError): DiError {
    const requester = this.#stack.at(-1)

    if (requester === undefined || typeof requester.token !== 'function') {
      return error
    }

    const name = typeof token === 'function' ? token.name : (token as { description?: string }).description

    return atSite(error, { class: requester.token.name, text: name === undefined ? [] : [`inject(${name}`] })
  }

  /** Value of `token` for code running in `module`, created synchronously if needed. */
  resolve(module: ModuleNode, token: Token<unknown>, optional: boolean): unknown {
    if (this.#report === undefined) {
      return this.#resolve(module, token, optional)
    }

    try {
      return this.#resolve(module, token, optional)
    } catch (error) {
      return this.#stub(error)
    }
  }

  #resolve(module: ModuleNode, token: Token<unknown>, optional: boolean): unknown {
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

      let value: unknown

      if (definition.kind === 'class') {
        value = this.#construct(node, definition.useClass)
      } else {
        value = this.#dry(definition) ? this.#dryFactory(node, definition) : this.#callFactory(node, definition)
      }

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

    if (this.#dry(definition)) {
      this.#enter(node)

      try {
        const value = this.#dryFactory(node, definition)

        this.#store(node, value)

        return value
      } finally {
        this.#stack.pop()
      }
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
    } catch (error) {
      if (this.#report === undefined) {
        throw error
      }

      // A factory safe to check failed, a configuration most likely: reported, stubbed.
      const value = this.#stub(error)

      this.#store(node, value)

      return value
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

    if (this.#report === undefined) {
      return runInContext(context, () => new useClass())
    }

    const stubs = this.#stubs

    try {
      return runInContext(context, () => new useClass())
    } catch (error) {
      // Failing on a stub is the dry run's doing, not the class's.
      if (this.#stubs === stubs) {
        this.#report(error)
      }

      // An instance all the same: the methods of a controller still give routes.
      return Object.create(useClass.prototype) as unknown
    }
  }

  /** In a dry run, a factory is not called unless marked safe to check. */
  #dry(definition: FactoryDefinition): boolean {
    return this.#report !== undefined && !isSafeToCheck(definition.useFactory)
  }

  /** What a factory gives in a dry run: its dependencies resolved, problems reported, and a stub. */
  #dryFactory(node: ProviderNode, definition: FactoryDefinition): unknown {
    for (const dependency of definition.dependencies) {
      this.resolve(node.module, dependency.token, dependency.optional)
    }

    this.#stubs++

    return STUB
  }

  #stub(error: unknown): unknown {
    this.#report!(error)
    this.#stubs++

    return STUB
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
          ? `${candidate.name} exports it: add ${candidate.name} to the imports of ${module.name}.`
          : `${candidate.name} provides it but does not export it: add it to the exports of ${candidate.name}.`
      }
    }

    return `Add it to the providers of ${module.name}, or import a module that exports it.`
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

  /** Providers of the modules, those `createContainer()` adds itself left out. */
  get providerCount(): number {
    let count = 0

    for (const node of this.#graph.providers) {
      if (node.module.moduleClass !== ContainerProvidersModule) {
        count++
      }
    }

    return count
  }

  /** The modules and what each provider injects, as a dry run recorded it. */
  describe(): DescribedModule[] {
    const described: DescribedModule[] = []
    const describeNode = (node: ProviderNode): DescribedProvider => ({
      token: tokenName(node.token),
      kind: KINDS[node.definition.kind],
      scope: node.scope,
      injects: [...(this.#resolver.dependencies.get(node)?.values() ?? [])],
    })

    for (const module of this.#graph.modules) {
      if (module.moduleClass === ContainerProvidersModule) {
        continue
      }

      described.push({
        name: module.name,
        global: module.global,
        imports: module.imports.map(moduleName),
        exports: [...[...module.exportedTokens].map(tokenName), ...[...module.exportedModules].map((exported) => exported.name)],
        providers: [...module.providers.values()].map(describeNode),
        controllers: module.controllers.map(describeNode),
      })
    }

    return described
  }

  get modules(): readonly ModuleClass[] {
    const modules: ModuleClass[] = []

    for (const node of this.#graph.modules) {
      if (node.moduleClass !== ContainerProvidersModule) {
        modules.push(node.moduleClass)
      }
    }

    return modules
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
const createAll = async (graph: ModuleGraph, resolver: Resolver, report?: ReportProblem): Promise<ControllerEntry[]> => {
  const { providers, controllers, modules } = graph

  for (let i = 0, len = providers.length; i < len; i++) {
    const node = providers[i]!

    if (node.definition.kind === 'factory' && node.scope === 'singleton') {
      await attempt(() => resolver.getAsync(node), report)
    }
  }

  for (let i = 0, len = providers.length; i < len; i++) {
    const node = providers[i]!

    if (node.scope === 'singleton') {
      attempt(() => resolver.get(node), report)
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
    attempt(() => resolver.get(modules[i]!.instance), report)
  }

  return entries
}

/** Runs `fn`; in a dry run, an error is reported instead of thrown. */
function attempt<R>(fn: () => R, report: ReportProblem | undefined): R | undefined {
  if (report === undefined) {
    return fn()
  }

  try {
    const result = fn()

    return isThenable(result) ? (Promise.resolve(result).catch(report) as R) : result
  } catch (error) {
    report(error)

    return undefined
  }
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
  const discovery = new Discovery()
  const graph = await graphOf(root, options, discovery)
  const resolver = new Resolver(graph)

  attachDiscovery(discovery, () => discover(graph, resolver))

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

/** The graph of `root`, with the providers of the options and `Discovery`, visible everywhere. */
const graphOf = (root: ModuleImport, options: ContainerOptions, discovery: Discovery): Promise<ModuleGraph> =>
  buildGraph(root, options.overrides ?? [], [providersModule([...(options.providers ?? []), provide(Discovery, { useValue: discovery })])])

/** The providers of the modules, for `Discovery`. */
const discover = (graph: ModuleGraph, resolver: Resolver): readonly DiscoveredProvider[] => {
  const found: DiscoveredProvider[] = []

  for (const module of graph.modules) {
    if (module.moduleClass === ContainerProvidersModule) {
      continue
    }

    for (const node of module.providers.values()) {
      found.push({ token: node.token, module: module.moduleClass, get: () => resolver.get(node) })
    }
  }

  return found
}

/**
 * The dry run of `createContainer`, for `soda check`: every class created,
 * no factory called but those safe to check, no lifecycle hook; problems go
 * to `report` instead of failing. Errors of the graph itself still reject.
 * The container is not closed: what it holds was never initialized.
 */
export const createDryContainer = async (root: ModuleImport, options: ContainerOptions, report: ReportProblem): Promise<Container> => {
  const discovery = new Discovery()
  const graph = await graphOf(root, options, discovery)
  const resolver = new Resolver(graph, report)

  attachDiscovery(discovery, () => discover(graph, resolver))
  const controllers = await createAll(graph, resolver, report)

  resolver.starting = false

  return new StartedContainer(graph, resolver, controllers)
}

/** What a container made by `createDryContainer` recorded; nothing for another one. */
export const describeContainer = (container: Container): DescribedModule[] =>
  container instanceof StartedContainer ? container.describe() : []
