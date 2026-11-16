import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { Module } from '../di/index.ts'
import type { Constructor, ModuleClass } from '../di/index.ts'
import { body, cookie, form, header, param, query } from '../http/arguments.ts'
import { All, Controller, Get, HttpCode, Post, Sse } from '../http/decorators.ts'
import { int, uuid } from '../http/parsers.ts'
import type { SseMessage } from '../http/sse.ts'
import { createTestApp } from '../testing/index.ts'
import { ApiBearerAuth, ApiExclude, ApiOperation, ApiResponses, ApiTags } from './decorators.ts'
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
            responses: { 200: { description: 'Success' } },
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
            responses: { 201: { description: 'Success' } },
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
                    },
                  },
                },
              },
              404: { description: 'No such user' },
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
            responses: { 204: { description: 'Success' } },
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
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
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
  @Controller('orders')
  @ApiTags('orders')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'An order operation', deprecated: true })
  @ApiResponses({ 401: { description: 'No token' } })
  class OrdersController {
    @Get('mine')
    @ApiTags('me')
    @ApiOperation({ summary: 'My orders' })
    mine(): null {
      return null
    }

    @Get()
    list(): null {
      return null
    }

    @Post([body(CreateUser)])
    @ApiResponses({ 201: { description: 'The order', schema: User }, 401: { description: 'Expired token' }, 409: { description: 'Already placed' } })
    place(): null {
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
    const tested = await createTestApp(defineModule([OrdersController, AdminController]))
    const json = (await (await tested.request('/openapi.json')).json()) as OpenApiDocument

    await tested.close()

    return json
  }

  it('adds those of a method to those of its controller, the method winning field by field', async () => {
    const { paths } = await document()

    expect(Object.keys(paths)).toEqual(['/orders/mine', '/orders'])
    expect(paths['/orders/mine']!.get).toMatchObject({ summary: 'My orders', deprecated: true, tags: ['orders', 'me'], security: [{ bearer: [] }] })
    expect(paths['/orders']!.get).toMatchObject({ summary: 'An order operation', deprecated: true, tags: ['orders'], security: [{ bearer: [] }] })
  })

  it('keeps the success of the route, declared responses adding to it or replacing it by status', async () => {
    const { paths } = await document()

    expect(paths['/orders']!.get!.responses).toEqual({ 200: { description: 'Success' }, 401: { description: 'No token' } })
    expect(paths['/orders']!.post!.responses).toEqual({
      201: { description: 'The order', content: { 'application/json': { schema: expect.objectContaining({ required: ['id', 'name'] }) } } },
      401: { description: 'Expired token' },
      409: { description: 'Already placed' },
    })
  })
})
