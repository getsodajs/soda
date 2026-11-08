/**
 * @module
 * Route compiler for Soda: turns a route table into Bun's native router.
 */

export { compileRoutes } from './compiler'
export { RouteError } from './errors'
export type { RouteErrorCode } from './errors'
export { MAX_NATIVE_ROUTES, METHOD_ALL } from './types'
export type { CompiledRoutes, CompileOptions, Handler, NativeHandler, Params, RouteDefinition } from './types'
