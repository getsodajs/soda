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

import type { Constructor } from '../di/index.ts'
import type { Argument } from '../http/arguments.ts'
import { getControllerPath } from '../http/decorators.ts'
import { getClassEnhancers } from '../http/enhancers.ts'
import type { Guard } from '../http/enhancers.ts'
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
  readonly components?: {
    readonly schemas?: Readonly<Record<string, JsonSchema>>
    readonly securitySchemes?: Readonly<Record<string, JsonSchema>>
  }
}

const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'])
const IN = { query: 'query', header: 'header', cookie: 'cookie' } as const
const STRING: JsonSchema = { type: 'string' }
const FORM_TYPES = ['multipart/form-data', 'application/x-www-form-urlencoded']

/** Standard JSON Schema: the part of `~standard` a schema library may add. */
interface WithJsonSchema {
  readonly '~standard': {
    readonly jsonSchema?: Readonly<Record<'input' | 'output', (options: { readonly target: string }) => Record<string, unknown>>>
  }
}

/**
 * JSON Schema of what a parser or schema accepts, or of what it produces with `side: 'output'`
 * (a response); `{}` when it cannot tell or the schema has none.
 */
export const toJsonSchema = (source: Argument<unknown>['source'], side: 'input' | 'output' = 'input'): JsonSchema => {
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
    const { $schema: _, ...schema } = converter[side]({ target: 'draft-2020-12' })

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

/** Body of the errors Soda answers with: `HttpException`'s. */
const ERROR: JsonSchema = {
  type: 'object',
  properties: {
    statusCode: { type: 'integer' },
    message: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    error: { type: 'string' },
  },
  required: ['statusCode', 'message'],
}

/** Where the operations find {@link ERROR}, written once in the components. */
const ERROR_REF: JsonSchema = { $ref: '#/components/schemas/HttpError' }

type Responses = Record<string, OpenApiOperation['responses'][string]>

const BAD_REQUEST = 'Invalid request'
const TOO_LARGE = 'Request body too large'
const UNSUPPORTED = 'Unsupported content type'
const FORBIDDEN = 'Forbidden'

/** The class whose decorators describe a guard: itself, or the class of an instance. */
const classOf = (guard: Guard): Constructor<unknown> =>
  (typeof guard === 'function' ? guard : guard.constructor) as Constructor<unknown>

/**
 * A decorator's values for a route, the least specific first: those of its
 * guards, of its controller, of its method. The route's metadata only keeps the
 * method's value when it has one: the same value means it declared none.
 */
const layersOf = <T>(route: MappedRoute, key: symbol, guards = true): T[] => {
  const values: unknown[] = guards ? route.guardTypes.map((guard) => getClassEnhancers(classOf(guard)).metadata.get(key)) : []
  const inherited = getClassEnhancers(route.info.controller).metadata.get(key)
  const value = route.info.metadata.get(key)

  values.push(inherited, value === inherited ? undefined : value)

  return values.filter((entry) => entry !== undefined) as T[]
}

const describeResponse = (status: string, response: ApiResponseOptions): Responses[string] => {
  if (response.schema !== undefined) {
    return { description: response.description, content: { 'application/json': { schema: toJsonSchema(response.schema, 'output') } } }
  }

  return Number(status) >= 400 ? { description: response.description, content: { 'application/json': { schema: ERROR_REF } } } : { description: response.description }
}

/** The errors the arguments of a route answer with: `400` when a value can be refused, `413` and `415` for bodies. */
const inputErrors = (args: readonly Argument<unknown>[]): Record<number, string> => {
  const errors: Record<number, string> = {}

  for (const arg of args) {
    if (arg.kind === 'body' && arg.multipart === true) {
      Object.assign(errors, arg.source === undefined ? {} : { 400: BAD_REQUEST }, { 413: TOO_LARGE, 415: UNSUPPORTED })
    } else if (arg.kind === 'body') {
      // Invalid JSON is refused, with or without schema.
      Object.assign(errors, { 400: BAD_REQUEST, 415: UNSUPPORTED })
    } else if (arg.source !== undefined && (arg.kind === 'param' || arg.kind === 'query' || arg.kind === 'header' || arg.kind === 'cookie')) {
      errors[400] = BAD_REQUEST
    }
  }

  return errors
}

/**
 * What the document finds itself, then what is declared, each replacing the
 * same status: the success of the route, the errors of its arguments, a `403`
 * for a guard declaring no response of its own; then the responses of its
 * guards, of its controller, of its method.
 */
const responsesOf = (route: MappedRoute): Responses => {
  const responses: Responses = route.sse
    ? { 200: { description: 'Event stream', content: { 'text/event-stream': { schema: STRING } } } }
    : { [route.status]: { description: 'Success' } }
  const found: Record<number, string> = inputErrors(route.args ?? [])

  for (const guard of route.guardTypes) {
    if (getClassEnhancers(classOf(guard)).metadata.get(KEYS.responses) === undefined) {
      found[403] = FORBIDDEN
    }
  }

  for (const [status, description] of Object.entries(found)) {
    responses[status] = describeResponse(status, { description })
  }

  for (const declared of layersOf<Readonly<Record<number, ApiResponseOptions>>>(route, KEYS.responses)) {
    for (const [status, response] of Object.entries(declared)) {
      responses[status] = describeResponse(status, response)
    }
  }

  return responses
}

/** The tag of a controller without `@ApiTags`: its path without parameters, `users` for `/users/:id`. */
const tagOf = (controller: Constructor<unknown>): readonly string[] => {
  const tag = (getControllerPath(controller) ?? '')
    .split('/')
    .filter((segment) => segment !== '' && !segment.startsWith(':') && !segment.startsWith('*'))
    .join('/')

  return tag === '' ? [] : [tag]
}

/** The controller's tags, declared or its path, and those of the method. */
const tagsOf = (route: MappedRoute): readonly string[] => {
  const inherited = getClassEnhancers(route.info.controller).metadata.get(KEYS.tags) as readonly string[] | undefined
  const value = route.info.metadata.get(KEYS.tags) as readonly string[] | undefined
  const own = value === inherited ? [] : (value ?? [])

  return [...new Set([...(inherited ?? tagOf(route.info.controller)), ...own])]
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

  // Fields of the method win over those of the controller.
  const options: ApiOperationOptions = Object.assign({}, ...layersOf<ApiOperationOptions>(route, KEYS.operation, false))
  const tags = tagsOf(route)
  const body = requestBody(args)
  const bearer = layersOf<boolean>(route, KEYS.bearer).at(-1) === true

  return {
    operationId: `${info.controller.name}_${info.handler}${suffix}`,
    ...options,
    ...(tags.length === 0 ? {} : { tags }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(body === undefined ? {} : { requestBody: body }),
    responses: responsesOf(route),
    ...(bearer ? { security: [{ bearer: [] }] } : {}),
  }
}

/** Adds the operations of `route` to `paths`, one per form of its path, and returns them. */
const addRoute = (paths: Record<string, Record<string, OpenApiOperation>>, route: MappedRoute): OpenApiOperation[] => {
  const { info } = route

  if (!METHODS.has(info.method) || info.metadata.get(KEYS.exclude) === true) {
    return []
  }

  const operations: OpenApiOperation[] = []

  for (const [index, segments] of expandOptional(info.path, parsePath(info.path)).entries()) {
    const path = toOpenApiPath(segments)
    const operation = operationOf(route, segments, index === 0 ? '' : `_${index}`)

    paths[path] ??= {}
    paths[path][info.method.toLowerCase()] = operation
    operations.push(operation)
  }

  return operations
}

const refersToError = (operation: OpenApiOperation): boolean =>
  Object.values(operation.responses).some((response) => response.content?.['application/json']?.schema === ERROR_REF)

/** The OpenAPI document of `controllers`, as `inject(ROUTES).controllers` lists them. */
export const createOpenApiDocument = (controllers: readonly MappedController[], options: OpenApiOptions): OpenApiDocument => {
  const paths: Record<string, Record<string, OpenApiOperation>> = {}
  const operations = controllers.flatMap((controller) => controller.routes.flatMap((route) => addRoute(paths, route)))
  const bearer = operations.some((operation) => operation.security !== undefined)
  const errors = operations.some(refersToError)
  const components = {
    ...(errors ? { schemas: { HttpError: ERROR } } : {}),
    ...(bearer ? { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } } : {}),
  }

  return {
    openapi: '3.1.0',
    info: options.info,
    ...(options.servers === undefined ? {} : { servers: options.servers }),
    paths,
    ...(errors || bearer ? { components } : {}),
  }
}
