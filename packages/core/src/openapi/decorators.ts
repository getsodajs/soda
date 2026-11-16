/**
 * @module
 * Decorators describing routes in the OpenAPI document, as `@nestjs/swagger` does.
 */

import { createDecorator } from '../http/enhancers.ts'
import type { ClassOrMethodDecorator } from '../http/enhancers.ts'
import type { StandardSchemaV1 } from '../http/schema.ts'

export interface ApiOperationOptions {
  readonly summary?: string
  readonly description?: string
  readonly deprecated?: boolean
}

export interface ApiResponseOptions {
  readonly description: string
  /** Schema of the JSON body; needs a library implementing Standard JSON Schema, such as zod. */
  readonly schema?: StandardSchemaV1
}

const operation = createDecorator<ApiOperationOptions>('ApiOperation')
const tags = createDecorator<readonly string[]>('ApiTags')
const responses = createDecorator<Readonly<Record<number, ApiResponseOptions>>>('ApiResponses')
const bearer = createDecorator<boolean>('ApiBearerAuth')
const exclude = createDecorator<boolean>('ApiExclude')

/** Summary, description and deprecation of an operation; on a method, its fields win over those of the controller. */
export const ApiOperation = (options: ApiOperationOptions): ClassOrMethodDecorator => operation(options)

/**
 * Tags grouping operations. A controller is tagged with its path (`users`)
 * unless it declares its own; those of a method add to those of its controller.
 */
export const ApiTags = (...names: string[]): ClassOrMethodDecorator => tags(names)

/**
 * Responses of an operation, by status. They add to those the document finds
 * itself (the success of the route, its validation errors, those of its
 * guards), replacing them when they declare the same status: those of a guard,
 * then of the controller, then of the method. An error status without schema
 * gets the body of `HttpException`.
 *
 * ```ts
 * @ApiResponses({ 200: { description: 'The user', schema: User }, 404: { description: 'No such user' } })
 * ```
 */
export const ApiResponses = (byStatus: Readonly<Record<number, ApiResponseOptions>>): ClassOrMethodDecorator => responses(byStatus)

/**
 * Operations need `Authorization: Bearer <token>`. On a guard, every route it
 * guards does, as with `JwtGuard`; `@ApiBearerAuth(false)` says a route does not.
 */
export const ApiBearerAuth = (required = true): ClassOrMethodDecorator => bearer(required)

/** Leaves a controller or a method out of the document. */
export const ApiExclude = (): ClassOrMethodDecorator => exclude(true)

export const KEYS = { operation: operation.key, tags: tags.key, responses: responses.key, bearer: bearer.key, exclude: exclude.key } as const
