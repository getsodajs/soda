# OpenAPI

`@getsoda/core/openapi` builds the document from your code: everything the routes already declare is described, with no decorator. Decorators add what code cannot say (a summary, the schema of what a handler returns), or replace what the document found.

Nothing is written twice: no `@ApiProperty()` on each field of a DTO, as `@nestjs/swagger` needs. The schema that validates a request is the one documented.

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

That is the whole setup: there is nothing to turn on. The document is served at `/openapi.json` (the `path` option changes it), Swagger UI at `ui` when given; both follow the global prefix.

## What is generated

| Part of the document | From |
|---|---|
| paths, `:id` written `{id}` | the route; an optional parameter gives two paths |
| path, query, header and cookie parameters | their parser or schema; required unless `.optional()` or the schema accepts `undefined` |
| request body | `body(schema)` as JSON, `form()` as multipart and urlencoded |
| success response | `201` for `POST`, `200` otherwise, `@HttpCode()`; `text/event-stream` for `@Sse()` |
| `400 Invalid request` | an argument that can be refused: a body, a value with a parser or schema |
| `413`, `415` | `body()` (`415`), `form()` (`413` and `415`) |
| guard responses and bearer token | the decorators of each guard, see [Guards](#guards); `403 Forbidden` for a guard without |
| tags | the controller path: `@Controller('v1/orders/:shop')` is tagged `v1/orders` |
| `operationId` | controller and method: `UsersController_findOne` |

Error responses are described with the body Soda answers with, `HttpError` in the components: `statusCode`, `message` (a string, or the list of validation issues), `error`.

What code does not say is not generated: a summary, a description, what a handler returns, the errors it throws itself (a `404`, a `409`). Those are what decorators are for.

`@All()` routes and WebSocket gateways are left out: OpenAPI has no way to say "any method", nor WebSockets.

### From your schemas

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

gives, with no decorator (`HttpError` stands for `{ "$ref": "#/components/schemas/HttpError" }`):

```json
"/users/{id}": { "get": {
  "operationId": "UsersController_findOne",
  "tags": ["users"],
  "parameters": [
    { "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } },
    { "name": "full", "in": "query", "required": false, "schema": { "type": "string" } }
  ],
  "responses": {
    "200": { "description": "Success" },
    "400": { "description": "Invalid request", "content": { "application/json": { "schema": HttpError } } }
  }
} },
"/users": { "post": {
  "operationId": "UsersController_create",
  "tags": ["users"],
  "requestBody": { "required": true, "content": { "application/json": { "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "minLength": 1 },
      "email": { "type": "string", "format": "email", "pattern": "..." },
      "age": { "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }
    },
    "required": ["name", "email"]
  } } } },
  "responses": {
    "201": { "description": "Success" },
    "400": { "description": "Invalid request", "content": { "application/json": { "schema": HttpError } } },
    "415": { "description": "Unsupported content type", "content": { "application/json": { "schema": HttpError } } }
  }
} }
```

A query value is described as what the client sends, a string, before `z.stringbool()` turns it into a boolean. Change the schema and the document follows: a field made optional leaves `required`, a `.max(100)` becomes `maxLength`.

## Decorators

| Decorator | Does | Over what is generated |
|---|---|---|
| `@ApiOperation({ summary, description, deprecated })` | what the operation does | adds: nothing is generated |
| `@ApiResponses({ [status]: { description, schema? } })` | responses, typed by a schema | adds statuses; replaces those it declares |
| `@ApiTags(...names)` | groups in Swagger UI | on a controller, replaces the tag of its path; on a method, adds |
| `@ApiBearerAuth(required = true)` | needs `Authorization: Bearer` | replaces what the guards say; `false` removes it |
| `@ApiExclude()` | left out of the document | |

```ts
import { ApiExclude, ApiOperation, ApiResponses, ApiTags } from '@getsoda/core/openapi'

const User = z.object({ id: z.number().int(), name: z.string() })

@Controller('users')
@UseGuards(JwtGuard)          // bearer token and 401, from JwtGuard
@ApiTags('people')            // instead of `users`
export class UsersController {
  @Get(':id', [param('id', int)])
  @ApiOperation({ summary: 'One user', description: 'By its id.' })
  @ApiResponses({
    200: { description: 'The user', schema: User },   // replaces 200 Success
    404: { description: 'No such user' },             // adds; an error status gets HttpError
  })
  findOne(id: number) {}
  // responses: 200 The user, 400 Invalid request, 401 Missing or invalid token, 404 No such user

  @Get('internal')
  @ApiExclude()
  internal() {}
}
```

### Adding and replacing

Each part of an operation is built in layers, the most specific last, a later one replacing an earlier one where they overlap:

1. what is generated;
2. the decorators of the route's guards (global ones, the controller's, the method's);
3. the decorators of the controller;
4. the decorators of the method.

- **Responses** replace status by status: a `401` on the controller documents every route, a `401` on a method replaces it there, a declared `201` replaces `201 Success`. Everything else stays. An error status declared without `schema` gets `HttpError`; give a `schema` when the body is yours.
- **Operation**: field by field. `deprecated: true` on the controller stays when a method gives only a `summary`.
- **Tags**: `@ApiTags` on a controller replaces the tag of its path, `@ApiTags()` with no name removes it; tags of a method add to the controller's.
- **Bearer token**: the last that says replaces the others: `@ApiBearerAuth(false)` on a method behind `JwtGuard` documents it as public.

### Guards

A guard describes what it needs with the same decorators, on its class: every route it guards then gets them.

```ts
@ApiBearerAuth()
@ApiResponses({ 401: { description: 'Missing or invalid API key' } })
export class ApiKeyGuard implements CanActivate {
  canActivate(ctx: Context) { /* ... */ }
}
```

Soda's guards are described already: `JwtGuard` with the bearer token and `401`, `ThrottlerGuard` with `429`. A guard declaring no response gives `403 Forbidden`, what it answers when it returns `false`.

## The document itself

For a client generator or a contract test, build the document without serving it:

```ts
import { createOpenApiDocument } from '@getsoda/core/openapi'

const document = createOpenApiDocument(app.container.get(ROUTES).controllers, { info: { title: 'Shop', version: '1.0.0' } })

await Bun.write('openapi.json', JSON.stringify(document, null, 2))
```

## Schemas without JSON Schema

A schema library that does not implement Standard JSON Schema still validates, but its schema is described as `{}`: anything. Zod 4, and the libraries following the standard, describe themselves.
