/**
 * @module
 * `inspectApp()`: the application as data, what `soda inspect` writes. The
 * modules, what each provider injects and from which module, the routes with
 * what they read (and its JSON Schema), their guards and interceptors.
 *
 * ```ts
 * const { modules, routes } = await inspectApp(AppModule)
 *
 * modules[1]
 * // { name: 'UsersModule', imports: ['DatabaseModule'], exports: ['UsersService'],
 * //   providers: [{ token: 'UsersService', kind: 'class', scope: 'singleton',
 * //                 injects: [{ token: 'UsersRepository', optional: false, from: 'DatabaseModule' }] }], ... }
 * routes[0]
 * // { method: 'GET', path: '/users/:id', handler: 'UsersController.findOne', module: 'UsersModule',
 * //   inputs: [{ kind: 'param', name: 'id', required: true, schema: { type: 'integer' } }], guards: ['JwtGuard'], ... }
 * ```
 *
 * Built by the dry run of `soda check`: nothing starts, and an application
 * with problems is described as far as it goes, its problems listed.
 */

import { describeContainer } from '../di/container.ts'
import type { DescribedModule } from '../di/dry.ts'
import type { ModuleImport } from '../di/index.ts'
import type { Argument } from '../http/arguments.ts'
import type { BuiltRoutes } from '../http/index.ts'
import { isOptional, toJsonSchema } from '../openapi/document.ts'
import type { JsonSchema } from '../openapi/document.ts'
import { labelOf } from '../utils/name.ts'
import { VERSION } from '../version.ts'
import type { AppOptions } from './app.ts'
import { dryRun } from './check.ts'
import type { CheckProblem } from './check.ts'

export type { DescribedDependency as InspectDependency, DescribedModule as InspectModule, DescribedProvider as InspectProvider } from '../di/dry.ts'

/** Something a route reads. */
export interface InspectInput {
  /** `param`, `query`, `header`, `cookie`, `body`, `form`, `context` or `value`. */
  readonly kind: string
  /** Parameter, query, header or cookie name; the key of a `value()`. */
  readonly name?: string
  readonly required: boolean
  /** What it accepts, when its parser or schema says. */
  readonly schema?: JsonSchema
}

export interface InspectRoute {
  /** `GET`, `POST`... `WS` for a gateway. */
  readonly method: string
  readonly path: string
  /** `UsersController.findOne`, or the gateway class. */
  readonly handler: string
  readonly module: string
  /** What the handler receives, in order; empty when it takes the context. */
  readonly inputs: readonly InspectInput[]
  /** Declared on the controller and the method; those of every route are in the report. */
  readonly guards: readonly string[]
  readonly interceptors: readonly string[]
  /** Status of the responses built from returned values. */
  readonly status?: number
  readonly sse?: boolean
  /** Events a gateway handles. */
  readonly events?: readonly string[]
}

export interface InspectReport {
  /** Version of `@getsoda/core`. */
  readonly version: string
  /** No problem found: the application would start. */
  readonly ok: boolean
  readonly problems: readonly CheckProblem[]
  readonly duration: number
  readonly middleware: readonly string[]
  /** Guards and interceptors of every route. */
  readonly guards: readonly string[]
  readonly interceptors: readonly string[]
  /** Imports before importers, the root last. */
  readonly modules: readonly DescribedModule[]
  readonly routes: readonly InspectRoute[]
}

const inputOf = (arg: Argument<unknown>): InspectInput | undefined => {
  if (arg.kind === 'message' || arg.kind === 'socket') {
    return undefined
  }

  const kind = arg.kind === 'body' && arg.multipart === true ? 'form' : arg.kind
  const named = arg.name === '' ? {} : { name: arg.name }

  if (kind === 'context' || kind === 'value') {
    return { kind, ...named, required: true }
  }

  return { kind, ...named, required: !isOptional(arg.source), schema: toJsonSchema(arg.source) }
}

const describeRoutes = (built: BuiltRoutes, moduleOf: ReadonlyMap<unknown, string>): InspectRoute[] => {
  const routes: InspectRoute[] = []

  for (const { controller, routes: mapped } of built.controllers) {
    for (const route of mapped) {
      routes.push({
        method: route.info.method.toUpperCase(),
        path: route.info.path,
        handler: `${controller.name}.${route.info.handler}`,
        module: moduleOf.get(controller) ?? '',
        inputs: (route.args ?? []).map(inputOf).filter((input) => input !== undefined),
        guards: route.guards,
        interceptors: route.interceptors,
        status: route.status,
        sse: route.sse,
      })
    }
  }

  for (const gateway of built.gateways) {
    routes.push({
      method: 'WS',
      path: gateway.path,
      handler: gateway.gateway.name,
      module: moduleOf.get(gateway.gateway) ?? '',
      inputs: [],
      guards: gateway.guards,
      interceptors: [],
      events: gateway.runtime.events,
    })
  }

  return routes
}

/** Describes `root` with the options `createApp()` would get. Never throws and leaves nothing open. */
export const inspectApp = async (root: ModuleImport, options: AppOptions = {}): Promise<InspectReport> => {
  const { problems, container, built, started } = await dryRun(root, options)
  const moduleOf = new Map<unknown, string>()

  for (const entry of container?.controllers ?? []) {
    moduleOf.set(entry.controller, entry.module.name)
  }

  return {
    version: VERSION,
    ok: problems.length === 0,
    problems,
    duration: performance.now() - started,
    middleware: (options.middleware ?? []).map(labelOf),
    guards: (options.guards ?? []).map(labelOf),
    interceptors: (options.interceptors ?? []).map(labelOf),
    modules: container === undefined ? [] : describeContainer(container),
    routes: built === undefined ? [] : describeRoutes(built, moduleOf),
  }
}
