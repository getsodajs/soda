/**
 * @module
 * Route compiler for Soda: turns a route table into Bun's native router.
 */

export { compileRoutes } from './compiler.ts'
export { RouteError } from './errors.ts'
export type { RouteErrorCode } from './errors.ts'
export { MAX_NATIVE_ROUTES, METHOD_ALL } from './types.ts'
export type { CompiledRoutes, CompileOptions, Handler, NativeHandler, Params, RequestServer, RouteDefinition } from './types.ts'
