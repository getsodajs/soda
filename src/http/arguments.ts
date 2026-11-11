/**
 * @module
 * Handler arguments declared in the route decorator, the Nest-style way:
 * the method receives ready values instead of the context.
 *
 * ```ts
 * @Patch(':id', [param('id', int()), body(UpdateUserDto)])
 * update(id: number, dto: UpdateUserDto) {}
 *
 * // Nest:
 * // @Patch(':id')
 * // update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {}
 * ```
 *
 * Each argument is the same reader as on `Context` (`param()` is `ctx.param()`),
 * called by the framework before the method instead of by the method itself.
 */

import type { Context, ParamNameOf } from './context'
import type { Parsed, ValueParser } from './parsers'
import type { InferOutput, StandardSchemaV1 } from './schema'

export type ArgumentKind = 'param' | 'query' | 'header' | 'body' | 'context'

/**
 * One argument of a handler: where it comes from and how it is read.
 */
export interface Argument<T, K extends ArgumentKind = ArgumentKind, N extends string = string> {
  readonly kind: K
  /** Parameter, query or header name; empty for `body` and `context`. */
  readonly name: N
  readonly read: (ctx: Context) => T | Promise<T>
}

/** Arguments accepted by a route with path `P`: `param()` names must exist in it. */
export type ArgumentFor<P extends string> =
  | Argument<unknown, 'param', ParamNameOf<P>>
  | Argument<unknown, Exclude<ArgumentKind, 'param'>>

/** Values a method receives for an argument list. */
export type ArgumentValues<A extends readonly Argument<unknown>[]> = {
  -readonly [K in keyof A]: A[K] extends Argument<infer T> ? T : never
}

/** Path parameter. Like `@Param('id', ParseIntPipe)`. */
export function param<const N extends string>(name: N): Argument<string | undefined, 'param', N>
export function param<const N extends string, V extends ValueParser<unknown>>(
  name: N,
  parser: V
): Argument<Parsed<V>, 'param', N>
export function param(name: string, parser?: ValueParser<unknown>): Argument<unknown, 'param'> {
  return {
    kind: 'param',
    name,
    read: parser === undefined ? (ctx) => ctx.param(name) : (ctx) => ctx.param(name, parser),
  }
}

/** Query parameter. Like `@Query('page', ParseIntPipe)`. */
export function query(name: string): Argument<string | undefined, 'query'>
export function query<V extends ValueParser<unknown>>(name: string, parser: V): Argument<Parsed<V>, 'query'>
export function query(name: string, parser?: ValueParser<unknown>): Argument<unknown, 'query'> {
  return {
    kind: 'query',
    name,
    read: parser === undefined ? (ctx) => ctx.query(name) : (ctx) => ctx.query(name, parser),
  }
}

/** Request header. Like `@Headers('authorization')`. */
export function header(name: string): Argument<string | undefined, 'header'>
export function header<V extends ValueParser<unknown>>(name: string, parser: V): Argument<Parsed<V>, 'header'>
export function header(name: string, parser?: ValueParser<unknown>): Argument<unknown, 'header'> {
  return {
    kind: 'header',
    name,
    read: parser === undefined ? (ctx) => ctx.header(name) : (ctx) => ctx.header(name, parser),
  }
}

/** JSON body, validated by `schema`. Like `@Body() dto: CreateUserDto` with a validation pipe. */
export function body(): Argument<unknown, 'body'>
export function body<S extends StandardSchemaV1>(schema: S): Argument<InferOutput<S>, 'body'>
export function body(schema?: StandardSchemaV1): Argument<unknown, 'body'> {
  return {
    kind: 'body',
    name: '',
    read: schema === undefined ? (ctx) => ctx.body() : (ctx) => ctx.body(schema),
  }
}

/** The context itself, for what no other argument covers. Like `@Req()`. */
export const context = (): Argument<Context, 'context'> => ({ kind: 'context', name: '', read: (ctx) => ctx })
