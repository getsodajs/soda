/**
 * @module
 * JSON Web Tokens: `JwtService` to sign and verify them, `JwtModule` to
 * configure it, `JwtGuard` to protect routes with them.
 */

export type { JwtAlgorithm, JwtKey } from './algorithms.ts'
export { JwtError } from './errors.ts'
export type { JwtErrorCode } from './errors.ts'
export { JWT_PAYLOAD, JwtGuard } from './guard.ts'
export { JWT_OPTIONS, JwtModule } from './module.ts'
export type { JwtModuleAsyncOptions, JwtModuleOptions } from './module.ts'
export { JwtService } from './service.ts'
export type { JwtOptions, JwtPayload, JwtSignOptions } from './service.ts'
