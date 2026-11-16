/**
 * @module
 * Handler arguments declared in the route decorator, the Nest-style way:
 * the method receives ready values instead of the context.
 *
 * ```ts
 * @Patch(':id', [param('id', int), body(UpdateUserDto)])
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

import type { FormFields, FormLimits } from './body.ts'
import type { ContextKey } from './context-key.ts'
import type { Context, ContextParams, ParamNameOf } from './context.ts'
import type { Parsed, ValueParser } from './parsers.ts'
import { isStandardSchema } from './schema.ts'
import type { InferOutput, StandardSchemaV1 } from './schema.ts'

export type ArgumentKind = 'param' | 'query' | 'header' | 'cookie' | 'body' | 'context' | 'value'

/**
 * One argument of a handler: where it comes from and how it is read.
 */
export interface Argument<T, K extends ArgumentKind = ArgumentKind, N extends string = string> {
  readonly kind: K
  /** Parameter, query, header or cookie name; the key description for `value`; empty for `body` and `context`. */
  readonly name: N
  readonly read: (ctx: Context) => T | Promise<T>
  /** The parser or schema the value goes through, for API descriptions such as OpenAPI. */
  readonly source?: ValueParser<unknown> | StandardSchemaV1
  /** Set by `form()`: the body is a form, not JSON. */
  readonly multipart?: true
}

declare const RAW_PARAM: unique symbol

/**
 * Value of `param(name)` without parser, typed by the route path:
 * `string` for `:id`, `string | undefined` for `:id?`, `string` for a
 * parameter of the controller path.
 */
export interface RawParam {
  readonly [RAW_PARAM]: true
}

/** A parameter of the route path as typed there; one of the controller path is a `string`. */
export type ParamValue<P extends string, N extends string> = N extends ParamNameOf<P> ? ContextParams<P>[N] : string

/** Values a method receives for an argument list on a route with path `P`. */
export type ArgumentValues<A extends readonly Argument<unknown>[], P extends string = string> = {
  -readonly [K in keyof A]: A[K] extends Argument<infer T, ArgumentKind, infer N>
    ? [T] extends [RawParam]
      ? ParamValue<P, N>
      : T
    : never
}

/**
 * Path parameter of the route or of its controller, typed by the route path,
 * or by `parser`. Like `@Param('id', ParseIntPipe)`.
 */
export function param<const N extends string>(name: N): Argument<RawParam, 'param', N>
export function param<const N extends string, V extends ValueParser<unknown>>(
  name: N,
  parser: V
): Argument<Parsed<V>, 'param', N>
export function param(name: string, parser?: ValueParser<unknown>): Argument<unknown, 'param'> {
  return {
    kind: 'param',
    name,
    source: parser,
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
    source: parser,
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
    source: parser,
    read: parser === undefined ? (ctx) => ctx.header(name) : (ctx) => ctx.header(name, parser),
  }
}

/** Cookie. Like `@Cookies('session')` with `cookie-parser`; `signed(signer)` checks a signed one. */
export function cookie(name: string): Argument<string | undefined, 'cookie'>
export function cookie<V extends ValueParser<unknown>>(name: string, parser: V): Argument<Parsed<V>, 'cookie'>
export function cookie(name: string, parser?: ValueParser<unknown>): Argument<unknown, 'cookie'> {
  return {
    kind: 'cookie',
    name,
    source: parser,
    read: parser === undefined ? (ctx) => ctx.cookie(name) : (ctx) => ctx.cookie(name, parser),
  }
}

/** JSON body, validated by `schema`. Like `@Body() dto: CreateUserDto` with a validation pipe. */
export function body(): Argument<unknown, 'body'>
export function body<S extends StandardSchemaV1>(schema: S): Argument<InferOutput<S>, 'body'>
export function body(schema?: StandardSchemaV1): Argument<unknown, 'body'> {
  return {
    kind: 'body',
    name: '',
    source: schema,
    read: schema === undefined ? (ctx) => ctx.body() : (ctx) => ctx.body(schema),
  }
}

/** The context itself, for what no other argument covers. Like `@Req()`. */
export const context = (): Argument<Context, 'context'> => ({ kind: 'context', name: '', read: (ctx) => ctx })

/**
 * Value a guard or an interceptor attached to the request. Like a custom Nest
 * parameter decorator such as `@User()`.
 *
 * ```ts
 * @Get('me', [value(USER)])
 * me(user: User) {}
 * ```
 */
export const value = <T>(key: ContextKey<T>): Argument<T, 'value'> => ({
  kind: 'value',
  name: key.description,
  read: (ctx) => ctx.get(key),
})

/** Form body, validated by `schema` when given, within `limits`. Like `@Body()` on a form, or Nest's file interceptors with multer limits. */
export function form(limits?: FormLimits): Argument<FormFields, 'body'>
export function form<S extends StandardSchemaV1>(schema: S, limits?: FormLimits): Argument<InferOutput<S>, 'body'>
export function form(schemaOrLimits?: StandardSchemaV1 | FormLimits, limits?: FormLimits): Argument<unknown, 'body'> {
  return {
    kind: 'body',
    name: '',
    source: isStandardSchema(schemaOrLimits) ? schemaOrLimits : undefined,
    multipart: true,
    read: isStandardSchema(schemaOrLimits) ? (ctx) => ctx.form(schemaOrLimits, limits) : (ctx) => ctx.form(schemaOrLimits),
  }
}
