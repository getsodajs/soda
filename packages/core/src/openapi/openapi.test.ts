import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { Module } from '../di/index.ts'
import type { Constructor, ModuleClass } from '../di/index.ts'
import { body, cookie, form, header, param, query } from '../http/arguments.ts'
import { All, Controller, Get, HttpCode, Post, Sse } from '../http/decorators.ts'
import { getClassEnhancers, UseGuards } from '../http/enhancers.ts'
import type { CanActivate } from '../http/enhancers.ts'
import { int, uuid } from '../http/parsers.ts'
import type { SseMessage } from '../http/sse.ts'
import { createTestApp } from '../testing/index.ts'
import { JwtGuard } from '../jwt/guard.ts'
import { ThrottlerGuard } from '../throttler/guard.ts'
import { ApiBearerAuth, ApiExclude, ApiOperation, ApiResponses, ApiTags, KEYS } from './decorators.ts'
import type { OpenApiDocument } from './document.ts'
import { OpenApiModule } from './module.ts'

const CreateUser = z.object({ name: z.string().min(1), age: z.number().int().optional() })
const User = z.object({ id: z.number().int(), name: z.string() })

@Controller('users')
@ApiTags('users')
class UsersController {
  @Get([query('page', int.optional()), query('sort', z.enum(['asc', 'desc']))])
  list(): unknown[] {
    return []
  }

  @Get(':id', [param('id', int), header('x-request-id', uuid.optional())])
  @ApiOperation({ summary: 'One user' })
  @ApiResponses({ 200: { description: 'The user', schema: User }, 404: { description: 'No such user' } })
  findOne(): null {
    return null
  }

  @Post([body(CreateUser), cookie('session')])
  @ApiBearerAuth()
  create(): null {
    return null
  }

  @Post('avatar', [form()])
  @HttpCode(204)
  avatar(): void {}

  @Get('files/:path?')
  file(): null {
    return null
  }

  @Sse('events')
  async *events(): AsyncGenerator<SseMessage> {}

  @All('any')
  any(): null {
    return null
  }

  @Get('internal')
  @ApiExclude()
  internal(): null {
    return null
  }
}

@Module({
  imports: [OpenApiModule.forRoot({ info: { title: 'Shop', version: '1.0.0' }, servers: [{ url: 'https://shop.test' }], ui: '/docs' })],
  controllers: [UsersController],
})
class AppModule {}

const app = await createTestApp(AppModule, { prefix: 'api' })

const error = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/HttpError' } } } })

const defineModule = (controllers: readonly Constructor<unknown>[]): ModuleClass => {
  @Module({ imports: [OpenApiModule.forRoot({ info: { title: 'Shop', version: '1.0.0' } })], controllers })
  class DecoratedModule {}

  return DecoratedModule
}

afterAll(() => app.close())

describe('OpenApiModule', () => {
  it('describes every route from its arguments, schemas and decorators', async () => {
    const response = await app.request('/api/openapi.json')
    const document = (await response.json()) as OpenApiDocument

    expect(response.status).toBe(200)
    expect(document).toEqual({
      openapi: '3.1.0',
      info: { title: 'Shop', version: '1.0.0' },
      servers: [{ url: 'https://shop.test' }],
      paths: {
        '/api/users': {
          get: {
            operationId: 'UsersController_list',
            tags: ['users'],
            parameters: [
              { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
              { name: 'sort', in: 'query', required: true, schema: { type: 'string', enum: ['asc', 'desc'] } },
            ],
            responses: { 200: { description: 'Success' }, 400: error('Invalid request') },
          },
          post: {
            operationId: 'UsersController_create',
            tags: ['users'],
            parameters: [{ name: 'session', in: 'cookie', required: false, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', minLength: 1 },
                      age: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
                    },
                    required: ['name'],
                  },
                },
              },
            },
            responses: { 201: { description: 'Success' }, 400: error('Invalid request'), 415: error('Unsupported content type') },
            security: [{ bearer: [] }],
          },
        },
        '/api/users/{id}': {
          get: {
            operationId: 'UsersController_findOne',
            summary: 'One user',
            tags: ['users'],
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
              { name: 'x-request-id', in: 'header', required: false, schema: { type: 'string', format: 'uuid' } },
            ],
            responses: {
              200: {
                description: 'The user',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
                        name: { type: 'string' },
                      },
                      required: ['id', 'name'],
                      // What the schema produces: a response has no other field.
                      additionalProperties: false,
                    },
                  },
                },
              },
              400: error('Invalid request'),
              404: error('No such user'),
            },
          },
        },
        '/api/users/avatar': {
          post: {
            operationId: 'UsersController_avatar',
            tags: ['users'],
            requestBody: {
              required: false,
              content: { 'multipart/form-data': { schema: {} }, 'application/x-www-form-urlencoded': { schema: {} } },
            },
            responses: { 204: { description: 'Success' }, 413: error('Request body too large'), 415: error('Unsupported content type') },
          },
        },
        '/api/users/files': {
          get: { operationId: 'UsersController_file', tags: ['users'], responses: { 200: { description: 'Success' } } },
        },
        '/api/users/files/{path}': {
          get: {
            operationId: 'UsersController_file_1',
            tags: ['users'],
            parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { 200: { description: 'Success' } },
          },
        },
        '/api/users/events': {
          get: {
            operationId: 'UsersController_events',
            tags: ['users'],
            responses: { 200: { description: 'Event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
          },
        },
      },
      components: {
        schemas: { HttpError: expect.objectContaining({ required: ['statusCode', 'message'] }) },
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    })
  })

  it('serves a Swagger UI page reading the document under the global prefix', async () => {
    const response = await app.request('/api/docs')
    const html = await response.text()

    expect(response.headers.get('content-type')).toBe('text/html;charset=utf-8')
    expect(html).toContain('<title>Shop</title>')
    expect(html).toContain('SwaggerUIBundle({ url: "/api/openapi.json"')
  })
})

describe('decorators', () => {
  @ApiBearerAuth()
  @ApiResponses({ 401: { description: 'No token' } })
  class TokenGuard implements CanActivate {
    canActivate(): boolean {
      return true
    }
  }

  class AdminGuard implements CanActivate {
    canActivate(): boolean {
      return true
    }
  }

  @Controller('v1/orders/:shop')
  @UseGuards(TokenGuard)
  @ApiOperation({ summary: 'An order operation', deprecated: true })
  class OrdersController {
    @Get('mine')
    @ApiTags('me')
    @ApiOperation({ summary: 'My orders' })
    mine(): null {
      return null
    }

    @Post([body(CreateUser)])
    @UseGuards(AdminGuard)
    @ApiResponses({ 201: { description: 'The order', schema: User }, 401: { description: 'Expired token' }, 409: { description: 'Already placed' } })
    place(): null {
      return null
    }

    @Get('open')
    @ApiBearerAuth(false)
    open(): null {
      return null
    }
  }

  @Controller('catalog')
  @ApiTags('products')
  class CatalogController {
    @Get()
    list(): null {
      return null
    }
  }

  @Controller('admin')
  @ApiExclude()
  class AdminController {
    @Get()
    stats(): null {
      return null
    }
  }

  const document = async (): Promise<OpenApiDocument> => {
    const tested = await createTestApp(defineModule([OrdersController, CatalogController, AdminController]))
    const json = (await (await tested.request('/openapi.json')).json()) as OpenApiDocument

    await tested.close()

    return json
  }

  it('tags a controller with its path, unless it declares its tags; those of a method add to them', async () => {
    const { paths } = await document()

    expect(Object.keys(paths)).toEqual(['/v1/orders/{shop}/mine', '/v1/orders/{shop}', '/v1/orders/{shop}/open', '/catalog'])
    expect(paths['/v1/orders/{shop}/mine']!.get!.tags).toEqual(['v1/orders', 'me'])
    expect(paths['/catalog']!.get!.tags).toEqual(['products'])
  })

  it('merges the operation of a method with that of its controller, field by field', async () => {
    const { paths } = await document()

    expect(paths['/v1/orders/{shop}/mine']!.get).toMatchObject({ summary: 'My orders', deprecated: true })
    expect(paths['/v1/orders/{shop}/open']!.get).toMatchObject({ summary: 'An order operation', deprecated: true })
  })

  it('describes what guards need from their decorators, a 403 for a guard without', async () => {
    const { paths } = await document()

    expect(paths['/v1/orders/{shop}/mine']!.get).toMatchObject({ security: [{ bearer: [] }] })
    expect(Object.keys(paths['/v1/orders/{shop}/mine']!.get!.responses)).toEqual(['200', '401'])
    expect(Object.keys(paths['/v1/orders/{shop}']!.post!.responses)).toEqual(['201', '400', '401', '403', '409', '415'])
    expect(paths['/v1/orders/{shop}/open']!.get!.security).toBeUndefined()
  })

  it('keeps what it finds, declared responses replacing it by status: of guards, then the controller, then the method', async () => {
    const { paths } = await document()

    expect(paths['/v1/orders/{shop}']!.post!.responses).toMatchObject({
      201: { description: 'The order', content: { 'application/json': { schema: expect.objectContaining({ required: ['id', 'name'] }) } } },
      400: error('Invalid request'),
      401: error('Expired token'),
      403: error('Forbidden'),
      409: error('Already placed'),
    })
  })

  it('knows the guards of Soda', () => {
    expect(getClassEnhancers(JwtGuard).metadata.get(KEYS.bearer)).toBe(true)
    expect(getClassEnhancers(JwtGuard).metadata.get(KEYS.responses)).toMatchObject({ 401: {} })
    expect(getClassEnhancers(ThrottlerGuard).metadata.get(KEYS.responses)).toMatchObject({ 429: {} })
  })
})
