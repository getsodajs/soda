/**
 * @module
 * Building an OpenAPI 3.1 document from the routes of an application.
 *
 * Schemas come from what validates requests: argument parsers (`int`,
 * `uuid`...) and Standard Schemas implementing Standard JSON Schema, as zod
 * does. Paths with optional parameters give one path per form, as OpenAPI has
 * no optional path parameters; `@All()` routes are left out, OpenAPI has no
 * such method.
 */

import type { Argument } from '../http/arguments.ts'
import { getClassEnhancers } from '../http/enhancers.ts'
import type { Parser } from '../http/parsers.ts'
import type { MappedController, MappedRoute } from '../http/routes.ts'
import { isStandardSchema } from '../http/schema.ts'
import type { StandardSchemaV1 } from '../http/schema.ts'
import { expandOptional, parsePath } from '../routing/path.ts'
import type { Segment } from '../routing/path.ts'
import { KEYS } from './decorators.ts'
import type { ApiOperationOptions, ApiResponseOptions } from './decorators.ts'

export type JsonSchema = Readonly<Record<string, unknown>>

export interface OpenApiOptions {
  readonly info: { readonly title: string; readonly version: string; readonly description?: string }
  readonly servers?: readonly { readonly url: string; readonly description?: string }[]
}

export interface OpenApiParameter {
  readonly name: string
  readonly in: 'path' | 'query' | 'header' | 'cookie'
  readonly required: boolean
  readonly schema: JsonSchema
}

export interface OpenApiOperation {
  readonly operationId: string
  readonly summary?: string
  readonly description?: string
  readonly deprecated?: boolean
  readonly tags?: readonly string[]
  readonly parameters?: readonly OpenApiParameter[]
  readonly requestBody?: { readonly required: boolean; readonly content: Readonly<Record<string, { readonly schema: JsonSchema }>> }
  readonly responses: Readonly<Record<string, { readonly description: string; readonly content?: Readonly<Record<string, { readonly schema: JsonSchema }>> }>>
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[]
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0'
  readonly info: OpenApiOptions['info']
  readonly servers?: OpenApiOptions['servers']
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>
  readonly components?: { readonly securitySchemes: Readonly<Record<string, JsonSchema>> }
}

const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'])
const IN = { query: 'query', header: 'header', cookie: 'cookie' } as const
const STRING: JsonSchema = { type: 'string' }
const FORM_TYPES = ['multipart/form-data', 'application/x-www-form-urlencoded']

/** Standard JSON Schema: the part of `~standard` a schema library may add. */
interface WithJsonSchema {
  readonly '~standard': { readonly jsonSchema?: { readonly input: (options: { readonly target: string }) => Record<string, unknown> } }
}

/** JSON Schema of what a parser or schema accepts, `{}` when it cannot tell or the schema has none. */
export const toJsonSchema = (source: Argument<unknown>['source']): JsonSchema => {
  if (source === undefined) {
    return STRING
  }

  if (!isStandardSchema(source)) {
    return (source as Parser<unknown>).jsonSchema ?? STRING
  }

  const converter = (source as WithJsonSchema)['~standard'].jsonSchema

  if (converter === undefined) {
    return {}
  }

  try {
    const { $schema: _, ...schema } = converter.input({ target: 'draft-2020-12' })

    return schema
  } catch {
    // Some schemas have no JSON Schema: zod's `z.instanceof(File)` in a form, a custom refinement.
    return {}
  }
}

/** A value may be missing when its parser says so, or its schema accepts `undefined`. */
export const isOptional = (source: Argument<unknown>['source']): boolean => {
  if (source === undefined) {
    return true
  }

  if (!isStandardSchema(source)) {
    return (source as Parser<unknown>).required === false
  }

  const result = (source as StandardSchemaV1)['~standard'].validate(undefined)

  return !(result instanceof Promise) && result.issues === undefined
}

const toOpenApiPath = (segments: readonly Segment[]): string =>
  `/${segments
    .map((segment) =>
      segment.type === 'static' ? decodeURIComponent(segment.value) : `{${segment.type === 'param' ? segment.name : (segment.name ?? 'wildcard')}}`
    )
    .join('/')}`

const pathParameters = (segments: readonly Segment[], args: readonly Argument<unknown>[]): OpenApiParameter[] => {
  const parameters: OpenApiParameter[] = []

  for (const segment of segments) {
    if (segment.type === 'static') {
      continue
    }

    const name = segment.type === 'param' ? segment.name : (segment.name ?? 'wildcard')
    const declared = args.find((arg) => arg.kind === 'param' && arg.name === name)
    const pattern = segment.type === 'param' && segment.pattern !== undefined ? { pattern: `^(?:${segment.pattern})$` } : {}

    parameters.push({ name, in: 'path', required: true, schema: { ...toJsonSchema(declared?.source), ...pattern } })
  }

  return parameters
}

const requestBody = (args: readonly Argument<unknown>[]): OpenApiOperation['requestBody'] => {
  const body = args.find((arg) => arg.kind === 'body')

  if (body === undefined) {
    return undefined
  }

  const schema = body.source === undefined ? {} : toJsonSchema(body.source)
  const types = body.multipart === true ? FORM_TYPES : ['application/json']

  return { required: !isOptional(body.source), content: Object.fromEntries(types.map((type) => [type, { schema }])) }
}

/**
 * A decorator's value on the controller and on the method, apart: the route's
 * metadata only keeps the method's. The same value means the method declared none.
 */
const layersOf = <T>(info: MappedRoute['info'], key: symbol): readonly [T | undefined, T | undefined] => {
  const inherited = getClassEnhancers(info.controller).metadata.get(key) as T | undefined
  const value = info.metadata.get(key) as T | undefined

  return [inherited, value === inherited ? undefined : value]
}

const describeResponse = (response: ApiResponseOptions): OpenApiOperation['responses'][string] =>
  response.schema === undefined
    ? { description: response.description }
    : { description: response.description, content: { 'application/json': { schema: toJsonSchema(response.schema) } } }

/** The success of the route, then the declared responses: of the controller, then of the method, by status. */
const responsesOf = (route: MappedRoute): OpenApiOperation['responses'] => {
  const responses: Record<string, OpenApiOperation['responses'][string]> = route.sse
    ? { 200: { description: 'Event stream', content: { 'text/event-stream': { schema: STRING } } } }
    : { [route.status]: { description: 'Success' } }

  for (const declared of layersOf<Readonly<Record<number, ApiResponseOptions>>>(route.info, KEYS.responses)) {
    for (const [status, response] of Object.entries(declared ?? {})) {
      responses[status] = describeResponse(response)
    }
  }

  return responses
}

const operationOf = (route: MappedRoute, segments: readonly Segment[], suffix: string): OpenApiOperation => {
  const { info } = route
  const args = route.args ?? []
  const parameters = pathParameters(segments, args)

  for (const arg of args) {
    if (arg.kind === 'query' || arg.kind === 'header' || arg.kind === 'cookie') {
      parameters.push({ name: arg.name, in: IN[arg.kind], required: !isOptional(arg.source), schema: toJsonSchema(arg.source) })
    }
  }

  // A method's operation and tags add to those of its controller.
  const [inheritedOperation, ownOperation] = layersOf<ApiOperationOptions>(info, KEYS.operation)
  const options = { ...inheritedOperation, ...ownOperation }
  const [inheritedTags, ownTags] = layersOf<readonly string[]>(info, KEYS.tags)
  const tags = inheritedTags === undefined && ownTags === undefined ? undefined : [...new Set([...(inheritedTags ?? []), ...(ownTags ?? [])])]
  const body = requestBody(args)

  return {
    operationId: `${info.controller.name}_${info.handler}${suffix}`,
    ...options,
    ...(tags === undefined ? {} : { tags }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(body === undefined ? {} : { requestBody: body }),
    responses: responsesOf(route),
    ...(info.metadata.get(KEYS.bearer) === true ? { security: [{ bearer: [] }] } : {}),
  }
}

/** Adds the operations of `route` to `paths`, one per form of its path; `false` when it is left out. */
const addRoute = (paths: Record<string, Record<string, OpenApiOperation>>, route: MappedRoute): boolean => {
  const { info } = route

  if (!METHODS.has(info.method) || info.metadata.get(KEYS.exclude) === true) {
    return false
  }

  for (const [index, segments] of expandOptional(info.path, parsePath(info.path)).entries()) {
    const path = toOpenApiPath(segments)

    paths[path] ??= {}
    paths[path][info.method.toLowerCase()] = operationOf(route, segments, index === 0 ? '' : `_${index}`)
  }

  return true
}

/** The OpenAPI document of `controllers`, as `inject(ROUTES).controllers` lists them. */
export const createOpenApiDocument = (controllers: readonly MappedController[], options: OpenApiOptions): OpenApiDocument => {
  const paths: Record<string, Record<string, OpenApiOperation>> = {}
  let bearer = false

  for (const controller of controllers) {
    for (const route of controller.routes) {
      bearer = (addRoute(paths, route) && route.info.metadata.get(KEYS.bearer) === true) || bearer
    }
  }

  return {
    openapi: '3.1.0',
    info: options.info,
    ...(options.servers === undefined ? {} : { servers: options.servers }),
    paths,
    ...(bearer ? { components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } } } : {}),
  }
}
