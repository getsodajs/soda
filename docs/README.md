# Soda documentation

Soda is a class-based web framework for [Bun](https://bun.sh): modules, dependency injection and decorators like [Nest](https://nestjs.com), on Bun's native router, with standard TC39 decorators.

These pages describe the `main` branch. Soda is 0.x: the API may change between minor versions.

## Guide

1. [Getting started](./getting-started.md): create a project, run it, the files it contains
2. [Controllers](./controllers.md): routes, paths, arguments, responses, server-sent events
3. [Validation](./validation.md): schemas, parsers, bodies, forms and uploads, error responses
4. [Providers and modules](./providers-and-modules.md): `inject()`, providers, tokens, modules, lifecycle
5. [Request pipeline](./request-pipeline.md): middleware, guards, interceptors, exception filters, CORS
6. [Configuration](./configuration.md): typed environment, validated at startup
7. [Authentication](./authentication.md): JWT, cookies, the current user
8. [WebSockets](./websockets.md): gateways, messages, rooms
9. [Rate limiting](./rate-limiting.md): limits per client and route
10. [OpenAPI](./openapi.md): the document and Swagger UI from your routes
11. [CQRS](./cqrs.md): commands, queries and events, handled across modules
12. [Logging](./logging.md): the logger, levels, JSON output
13. [Testing](./testing.md): the application over HTTP, replaced providers
14. [Production](./production.md): build, shutdown, proxies, limits, Docker
15. [Checking and inspecting](./check.md): `soda check`, every startup problem at once; `soda inspect`, the application as data

## Recipes

- [Database](./recipes/database.md): `Bun.sql`, Drizzle, Prisma
- [File uploads](./recipes/file-uploads.md): forms, files, limits, storage

## Coming from Nest

[From Nest](./from-nest.md) maps each Nest feature to Soda's, and says what differs.
