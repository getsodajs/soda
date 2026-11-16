# OpenAPI

`@getsoda/core/openapi` describes your routes from what already validates them: argument parsers, and schemas implementing [Standard JSON Schema](https://standardschema.dev) (zod 4 does). Nothing is written twice: no `@ApiProperty()` on each field of a DTO, as `@nestjs/swagger` needs.

```ts
import { OpenApiModule } from '@getsoda/core/openapi'

@Module({
  imports: [
    OpenApiModule.forRoot({
      info: { title: 'Shop', version: '1.0.0' },
      servers: [{ url: 'https://api.shop.example' }],
      ui: '/docs',
    }),
  ],
})
export class AppModule {}
```

The document is served at `/openapi.json` (the `path` option changes it), Swagger UI at `ui` when given; both follow the global prefix.

## From your schemas

The schema a route validates with is the one documented. Written once, it checks the request, types the handler and describes the route:

```ts
const CreateUser = z.object({
  name: z.string().min(1),
  email: z.email(),
  age: z.number().int().optional(),
})

type CreateUser = z.infer<typeof CreateUser>

@Controller('users')
export class UsersController {
  @Get(':id', [param('id', int), query('full', z.stringbool().optional())])
  findOne(id: number, full: boolean | undefined) {}

  @Post([body(CreateUser)])
  create(input: CreateUser) {}
}
```

gives, with no decorator:

```json
"/users/{id}": { "get": {
  "operationId": "UsersController_findOne",
  "parameters": [
    { "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } },
    { "name": "full", "in": "query", "required": false, "schema": { "type": "string" } }
  ],
  "responses": { "200": { "description": "Success" } }
} },
"/users": { "post": {
  "operationId": "UsersController_create",
  "requestBody": { "required": true, "content": { "application/json": { "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "minLength": 1 },
      "email": { "type": "string", "format": "email", "pattern": "..." },
      "age": { "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }
    },
    "required": ["name", "email"]
  } } } },
  "responses": { "201": { "description": "Success" } }
} }
```

A query value is described as what the client sends, a string, before `z.stringbool()` turns it into a boolean. Change the schema and the document follows: a field made optional leaves `required`, a `.max(100)` becomes `maxLength`. What the handler returns is not known at runtime: describe responses with `@ApiResponses()`, below.

## What is described

From each route, without decorators:

- the path, `:id` written `{id}`; an optional parameter gives two paths;
- path, query, header and cookie parameters, typed by their parser or schema, required unless `.optional()` or the schema accepts `undefined`;
- the JSON body of `body(schema)`, the form of `form()`;
- the success status: `201` for `POST`, `@HttpCode()` otherwise;
- `text/event-stream` for `@Sse()` routes.

`@All()` routes and WebSocket gateways are left out: OpenAPI has no way to say "any method", nor WebSockets.

## Decorators

```ts
import { ApiBearerAuth, ApiExclude, ApiOperation, ApiResponses, ApiTags } from '@getsoda/core/openapi'

const User = z.object({ id: z.number().int(), name: z.string() })

@Controller('users')
@ApiTags('users')
@ApiBearerAuth()
export class UsersController {
  @Get(':id', [param('id', int)])
  @ApiOperation({ summary: 'One user', description: 'By its id.' })
  @ApiResponses({
    200: { description: 'The user', schema: User },
    404: { description: 'No such user' },
  })
  findOne(id: number) {}

  @Get('internal')
  @ApiExclude()
  internal() {}
}
```

| Decorator | |
|---|---|
| `@ApiTags(...names)` | groups in Swagger UI |
| `@ApiOperation({ summary, description, deprecated })` | what the operation does |
| `@ApiResponses({ [status]: { description, schema? } })` | responses, typed by a schema |
| `@ApiBearerAuth()` | needs `Authorization: Bearer` |
| `@ApiExclude()` | left out of the document |

On a class, they apply to every route; on a method, they win over the class.

## The document itself

For a client generator or a contract test, build the document without serving it:

```ts
import { createOpenApiDocument } from '@getsoda/core/openapi'

const document = createOpenApiDocument(app.container.get(ROUTES).controllers, { info: { title: 'Shop', version: '1.0.0' } })

await Bun.write('openapi.json', JSON.stringify(document, null, 2))
```

## Schemas without JSON Schema

A schema library that does not implement Standard JSON Schema still validates, but its schema is described as `{}`: anything. Zod 4, and the libraries following the standard, describe themselves.
