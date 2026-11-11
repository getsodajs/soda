/**
 * @module
 * Request context passed to route handlers.
 */

import type { Constructor } from '../di'
import { readJsonBody } from './body'
import type { MetadataDecorator } from './enhancers'
import { applyParser } from './parsers'
import type { Parsed, ValueParser } from './parsers'
import { validate } from './schema'
import type { InferOutput, StandardSchemaV1 } from './schema'
import type { AnyParams, PathParams } from './types'

/**
 * Parameters of a context: typed from the route path, plus untyped access to
 * parameters of the controller path, which the method decorator cannot see.
 */
export type ContextParams<P extends string> = string extends P ? AnyParams : Readonly<PathParams<P>> & AnyParams

/** Names of the parameters of a route path. */
export type ParamNameOf<P extends string> = string extends P ? string : keyof PathParams<P> & string

/**
 * The route a request is served by: the part of Nest's `ExecutionContext`
 * (`getClass()`, `getHandler()`) guards and interceptors need. Built once per route.
 */
export interface RouteInfo {
  readonly controller: Constructor<unknown>
  /** Method name on the controller. */
  readonly handler: string
  readonly method: string
  readonly path: string
  /** Custom metadata, the method's values over the class's. */
  readonly metadata: ReadonlyMap<symbol, unknown>
}

/**
 * What a route handler receives: the request, with typed readers. `P` is the
 * route path as written in the decorator.
 *
 * ```ts
 * @Patch(':id')
 * async update(ctx: Context<':id'>) {
 *   const id = ctx.param('id', int())
 *   const dto = await ctx.body(UpdateUserDto)
 *
 *   return this.#users.update(id, dto)
 * }
 * ```
 *
 * The URL is parsed only when `url` or `query()` is used; the body is read at most once.
 */
export class Context<P extends string = string> {
  #url: URL | undefined
  #body: Promise<unknown> | undefined

  constructor(
    readonly req: Request,
    readonly params: ContextParams<P>,
    readonly route: RouteInfo
  ) {}

  /**
   * Custom metadata of the route, the method's value over the class's.
   * Like Nest's `reflector.getAllAndOverride(Roles, [handler, class])`.
   */
  metadata<T>(decorator: MetadataDecorator<T>): T | undefined {
    return this.route.metadata.get(decorator.key) as T | undefined
  }

  get url(): URL {
    this.#url ??= new URL(this.req.url)

    return this.#url
  }

  /** Path parameter, decoded; converted and checked when a parser is given. */
  param<N extends ParamNameOf<P>>(name: N): ContextParams<P>[N]
  param<N extends ParamNameOf<P>, V extends ValueParser<unknown>>(name: N, parser: V): Parsed<V>
  param(name: string, parser?: ValueParser<unknown>): unknown {
    const value = (this.params as AnyParams)[name]

    return parser === undefined ? value : applyParser(parser, value, name)
  }

  /** First value of a query parameter; converted and checked when a parser is given. */
  query(name: string): string | undefined
  query<V extends ValueParser<unknown>>(name: string, parser: V): Parsed<V>
  query(name: string, parser?: ValueParser<unknown>): unknown {
    const value = this.url.searchParams.get(name) ?? undefined

    return parser === undefined ? value : applyParser(parser, value, name)
  }

  /** Request header; converted and checked when a parser is given. */
  header(name: string): string | undefined
  header<V extends ValueParser<unknown>>(name: string, parser: V): Parsed<V>
  header(name: string, parser?: ValueParser<unknown>): unknown {
    const value = this.req.headers.get(name) ?? undefined

    return parser === undefined ? value : applyParser(parser, value, name)
  }

  /**
   * JSON body, validated by `schema` when given. `415` for a non-JSON body,
   * `400` for invalid JSON or a failed validation.
   */
  body(): Promise<unknown>
  body<S extends StandardSchemaV1>(schema: S): Promise<InferOutput<S>>
  async body(schema?: StandardSchemaV1): Promise<unknown> {
    this.#body ??= readJsonBody(this.req)

    const value = await this.#body

    return schema === undefined ? value : validate(schema, value, '')
  }
}
