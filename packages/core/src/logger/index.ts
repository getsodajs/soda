/**
 * @module
 * Logging: the `Logger` contract and token, and the console implementation.
 */

export { ConsoleLogger } from './console-logger.ts'
export type { ConsoleLoggerOptions } from './console-logger.ts'
export { LOG_LEVELS, Logger, SilentLogger } from './logger.ts'
export type { LogData, LogEntry, LogLevel, StartupReport, StartupRoute } from './logger.ts'
