/**
 * @module
 * Commands and queries: plain classes carrying the type of their result.
 */

declare const RESULT: unique symbol

/**
 * Base of a command: what changes the state of the application. `R` is what
 * its handler returns, and what `CommandBus.execute()` resolves with.
 *
 * ```ts
 * class CreateUser extends Command<User> {
 *   constructor(readonly name: string) {
 *     super()
 *   }
 * }
 * ```
 */
export abstract class Command<R = void> {
  /** Carries `R` for the compiler; nothing at runtime. */
  declare readonly [RESULT]: R
}

/** Base of a query: what reads the state, changing nothing. `R` is what its handler returns. */
export abstract class Query<R> {
  /** Carries `R` for the compiler; nothing at runtime. */
  declare readonly [RESULT]: R
}

/** What the handler of command `C` returns. */
export type CommandResult<C extends Command<unknown>> = C extends Command<infer R> ? R : never

/** What the handler of query `Q` returns. */
export type QueryResult<Q extends Query<unknown>> = Q extends Query<infer R> ? R : never

/** A class of messages: commands, queries and events are found by their class. */
export type MessageType<T> = new (...args: never[]) => T
