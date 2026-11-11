/**
 * @module
 * Types of the HTTP layer.
 */

type Segments<P extends string> = P extends `${infer Head}/${infer Tail}` ? Head | Segments<Tail> : P

/** `id{\\d+}` → `id`. */
type Unbrace<B extends string> = B extends `${infer Name}{${string}` ? Name : B

type ParamName<S extends string> = S extends `:${infer Body}?`
  ? Unbrace<Body>
  : S extends `:${infer Body}`
    ? Unbrace<Body>
    : S extends `*${infer Name}`
      ? Name extends ''
        ? never
        : Name
      : never

type RequiredParams<P extends string> = {
  [S in Segments<P> as S extends `:${string}?` ? never : ParamName<S>]: string
}

type OptionalParams<P extends string> = {
  [S in Segments<P> as S extends `:${string}?` ? ParamName<S> : never]?: string
}

type Merge<A, B> = { [K in keyof (A & B)]: (A & B)[K] }

/**
 * Parameters of a route path, as the router fills them.
 *
 * ```ts
 * PathParams<'/users/:id{\\d+}/posts/:slug?/*rest'> // { id: string; slug?: string; rest: string }
 * PathParams<'/health'>                              // {}
 * ```
 */
export type PathParams<P extends string> = Merge<RequiredParams<P>, OptionalParams<P>>

/**
 * Any parameters: what a handler sees when the path is not known statically.
 */
export type AnyParams = Readonly<Record<string, string | undefined>>
