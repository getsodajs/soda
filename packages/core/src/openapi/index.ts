/**
 * @module
 * OpenAPI documents of an application, and a Swagger UI page, as `@nestjs/swagger`.
 */

export { ApiBearerAuth, ApiExclude, ApiOperation, ApiResponses, ApiTags } from './decorators.ts'
export type { ApiOperationOptions, ApiResponseOptions } from './decorators.ts'
export { createOpenApiDocument } from './document.ts'
export type { JsonSchema, OpenApiDocument, OpenApiOperation, OpenApiOptions, OpenApiParameter } from './document.ts'
export { OpenApiModule } from './module.ts'
export type { OpenApiModuleOptions } from './module.ts'
