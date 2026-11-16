/**
 * @module
 * Request context passed to route handlers.
 */

import type { Constructor } from '../di/index.ts'
import { readFormBody, readJsonBody } from './body.ts'
import type { FormFields, FormLimits } from './body.ts'
import type { ContextKey } from './context-key.ts'
import type { MetadataDecorator } from './enhancers.ts'
import { applyParser } from './parsers.ts'
import type { Parsed, ValueParser } from './parsers.ts'
import { isStandardSchema, validate } from './schema.ts'
import type { InferOutput, StandardSchemaV1 } from './schema.ts'
import type { AnyParams, PathParams } from './types.ts'

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
 *   const id = ctx.param('id', int)
 *   const dto = await ctx.body(UpdateUserDto)
 *
 *   return this.#users.update(id, dto)
 * }
 * ```
 *
 * The URL is parsed only when `url` is used, its query only when `query()` is; the body is read at
 * most once; the storage of `set()` is created on the first `set()`.
 */
export class Context<P extends string = string> {
  #url: URL | undefined
  #search: URLSearchParams | undefined
  #body: { readonly kind: 'JSON' | 'form'; readonly value: Promise<unknown> } | undefined
  #values: Map<ContextKey<unknown>, unknown> | undefined

  constructor(
    readonly req: Bun.BunRequest,
    readonly params: ContextParams<P>,
    readonly route: RouteInfo
  ) {}

  /** Attaches a value to this request, for the guards, interceptors and handler that follow. */
  set<T>(key: ContextKey<T>, value: T): void {
    this.#values ??= new Map()
    this.#values.set(key, value)
  }

  /**
   * Value attached to this request under `key`, or its default. Throws if
   * nothing was set and the key has no default: a guard is missing on the route.
   */
  get<T>(key: ContextKey<T>): T {
    if (this.#values?.has(key) === true) {
      return this.#values.get(key) as T
    }

    if (key.defaultValue === undefined) {
      throw new Error(
        `${key.toString()} is not set for ${this.route.controller.name}.${this.route.handler}: ` +
          'is the guard or interceptor that sets it applied to this route?'
      )
    }

    const value = key.defaultValue()

    this.set(key, value)

    return value
  }

  /** `true` if a value was set under `key` for this request. */
  has(key: ContextKey<unknown>): boolean {
    return this.#values?.has(key) === true
  }

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

  /** The query of the URL, parsed alone: cheaper than a whole `URL`, with the same rules. */
  #searchParams(): URLSearchParams {
    if (this.#search === undefined) {
      const url = this.req.url
      const start = url.indexOf('?')

      this.#search = this.#url?.searchParams ?? new URLSearchParams(start === -1 ? '' : url.slice(start + 1))
    }

    return this.#search
  }

  /**
   * Path parameter, decoded; converted and checked when a parser is given.
   * `P` is the route path only: read a parameter of the controller path from a
   * plain `Context`, or receive it with `param()` in the argument list.
   */
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
    const value = this.#searchParams().get(name) ?? undefined

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
   * Cookies of the request: Bun's `CookieMap`. What `set()` and `delete()`
   * change is sent with the response as `Set-Cookie`, whatever the response is.
   *
   * ```ts
   * ctx.cookies.set('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
   * ctx.cookies.delete('session')
   * ```
   */
  get cookies(): Bun.CookieMap {
    return this.req.cookies
  }

  /** Cookie, decoded; converted and checked when a parser is given, such as `signed()`. */
  cookie(name: string): string | undefined
  cookie<V extends ValueParser<unknown>>(name: string, parser: V): Parsed<V>
  cookie(name: string, parser?: ValueParser<unknown>): unknown {
    const value = this.req.cookies.get(name) ?? undefined

    return parser === undefined ? value : applyParser(parser, value, name)
  }

  /**
   * JSON body, validated by `schema` when given. `415` for a non-JSON body,
   * `400` for invalid JSON or a failed validation.
   */
  body(): Promise<unknown>
  body<S extends StandardSchemaV1>(schema: S): Promise<InferOutput<S>>
  async body(schema?: StandardSchemaV1): Promise<unknown> {
    const value = await this.#read('JSON', readJsonBody)

    return schema === undefined ? value : validate(schema, value, '')
  }

  /**
   * Form body (`multipart/form-data` or `application/x-www-form-urlencoded`),
   * validated by `schema` when given. `415` for another content type.
   * Repeated fields and fields named `name[]` are arrays; files are `File`s
   * whose `type` is what the client declared, not checked against the content.
   * `limits` bound the body, the files and the fields: `413` past them.
   */
  form(limits?: FormLimits): Promise<FormFields>
  form<S extends StandardSchemaV1>(schema: S, limits?: FormLimits): Promise<InferOutput<S>>
  async form(schemaOrLimits?: StandardSchemaV1 | FormLimits, limits?: FormLimits): Promise<unknown> {
    if (isStandardSchema(schemaOrLimits)) {
      return validate(schemaOrLimits, await this.#read('form', (req) => readFormBody(req, limits)), '')
    }

    return this.#read('form', (req) => readFormBody(req, schemaOrLimits))
  }

  /** Reads the body once; reading it again in another format is a programming error. */
  #read(kind: 'JSON' | 'form', read: (req: Request) => Promise<unknown>): Promise<unknown> {
    if (this.#body === undefined) {
      this.#body = { kind, value: read(this.req) }
    } else if (this.#body.kind !== kind) {
      throw new TypeError(`The body of this request was already read as ${this.#body.kind}, it cannot be read as ${kind}`)
    }

    return this.#body.value
  }
}
