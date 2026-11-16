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
