# Validation

Soda validates with any [Standard Schema](https://standardschema.dev) library: zod, valibot, arktype and others. No DTO classes, no `class-validator`: the schema is the type.

```ts
import { z } from 'zod'

const CreateUser = z.object({
  name: z.string().min(1),
  email: z.email(),
  age: z.number().int().optional(),
})

@Post([body(CreateUser)])
create(input: z.infer<typeof CreateUser>) {}
```

## Bodies

`body(schema)` reads the JSON body and validates it.

| Request | Response |
|---|---|
| a content type other than JSON | `415` |
| invalid JSON | `400 Request body is not valid JSON` |
| a `__proto__` key, written plainly or escaped | `400`: prototype pollution is refused |
| a body the schema refuses | `400`, every issue listed |

```json
{
  "statusCode": 400,
  "message": ["name: Too small: expected string to have >=1 characters", "email: Invalid email address"],
  "error": "Bad Request"
}
```

Each issue is `path: message`, the messages of your schema library. A very long list is cut, the last entry saying so.

`body()` without schema gives the parsed JSON as `unknown`. Body schemas may validate asynchronously (a check against the database, say); the others must be synchronous.

## Path, query and header values

Path parameters, query parameters, headers and cookies are strings. Parsers convert them and answer `400` when they do not fit:

| Parser | Accepts | Gives | Nest |
|---|---|---|---|
| `int` | `-42`, within `Number.MAX_SAFE_INTEGER` | `number` | `ParseIntPipe` |
| `number` | `1.5`, `-2`, `1e3`, finite | `number` | `ParseFloatPipe` |
| `boolean` | `true`, `false` | `boolean` | `ParseBoolPipe` |
| `uuid` | a UUID of any version, any case | `string` | `ParseUUIDPipe` |

```ts
@Get(':id', [param('id', int), query('full', boolean.optional())])
findOne(id: number, full: boolean | undefined) {}
```

A value is required: without it, the request is a `400`. `.optional()` accepts a missing value as `undefined`; a present but invalid one is still a `400`. Unlike `ParseIntPipe`, `int` refuses `99999999999999999999` instead of rounding it.

Any schema works in place of a parser, over the string:

```ts
query('sort', z.enum(['asc', 'desc']))
query('page', z.coerce.number().int().min(1).default(1))
param('slug', z.string().regex(/^[a-z0-9-]+$/))
```

## Forms and files

`form()` reads `multipart/form-data` and `application/x-www-form-urlencoded` bodies; another content type is a `415`.

```ts
const Profile = z.object({
  name: z.string(),
  avatar: z.instanceof(File),
})

@Post('profile', [form(Profile, { maxFileSize: 2 * 1024 * 1024, maxFiles: 1 })])
update(profile: z.infer<typeof Profile>) {}
```

- A repeated field, or a field named `tags[]`, is an array.
- Files are `File` objects. Their `type` is what the client declared: check the content itself when it matters.
- Limits answer `413` past them: `maxBodySize` (bytes of the body, refused as soon as it is exceeded, before it is read entirely), `maxFileSize`, `maxFiles` and `maxFields`.

`form(limits)` without schema gives the fields as they are. See also [File uploads](./recipes/file-uploads.md).

## Signed cookies

`signed(signer)` checks a cookie's signature, as a parser: see [Authentication](./authentication.md#cookies).

## Writing a parser

A parser turns a raw value, `undefined` when absent, into a value or throws an `HttpException`. `jsonSchema` describes it in OpenAPI.

```ts
import { BadRequestException } from '@getsoda/core'
import type { Parser } from '@getsoda/core'

const date: Parser<Date> = {
  jsonSchema: { type: 'string', format: 'date' },
  parse: (value, name) => {
    const parsed = value === undefined ? Number.NaN : Date.parse(value)

    if (Number.isNaN(parsed)) {
      throw new BadRequestException(`Validation failed for "${name}" (date is expected)`)
    }

    return new Date(parsed)
  },
}

@Get([query('since', date)])
list(since: Date) {}
```

Most of the time a schema is simpler: `z.coerce.date()`.
