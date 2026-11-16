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

/** Tags grouping operations; those of a method add to those of its controller. */
export const ApiTags = (...names: string[]): ClassOrMethodDecorator => tags(names)

/**
 * Responses of an operation, by status. They add to the success of the route
 * (`200`, `201` for `POST`, or `@HttpCode()`), replacing it when they declare
 * its status; those of a method add to those of the controller, the same way.
 *
 * ```ts
 * @ApiResponses({ 200: { description: 'The user', schema: User }, 404: { description: 'No such user' } })
 * ```
 */
export const ApiResponses = (byStatus: Readonly<Record<number, ApiResponseOptions>>): ClassOrMethodDecorator => responses(byStatus)

/** Operations need `Authorization: Bearer <token>`, as `JwtGuard` reads. */
export const ApiBearerAuth = (): ClassOrMethodDecorator => bearer(true)

/** Leaves a controller or a method out of the document. */
export const ApiExclude = (): ClassOrMethodDecorator => exclude(true)

export const KEYS = { operation: operation.key, tags: tags.key, responses: responses.key, bearer: bearer.key, exclude: exclude.key } as const
