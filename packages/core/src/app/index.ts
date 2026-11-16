/**
 * @module
 * The application: container, routes and server, started and stopped together.
 */

export { createApp } from './app.ts'
export { checkApp } from './check.ts'
export type { CheckProblem, CheckReport } from './check.ts'
export type { App, AppOptions, ListenOptions } from './app.ts'
export type { ServeRoutes } from './serve.ts'
