# Soda documentation

Soda is a class-based web framework for [Bun](https://bun.sh): modules, dependency injection and decorators like [Nest](https://nestjs.com), on Bun's native router, with standard TC39 decorators.

These pages describe the `main` branch. Soda is 0.x: the API may change between minor versions.

## Guide

1. [Getting started](https://getsodajs.github.io/docs/getting-started.md): create a project, run it, the files it contains
2. [Controllers](https://getsodajs.github.io/docs/controllers.md): routes, paths, arguments, responses, server-sent events
3. [Validation](https://getsodajs.github.io/docs/validation.md): schemas, parsers, bodies, forms and uploads, error responses
4. [Providers and modules](https://getsodajs.github.io/docs/providers-and-modules.md): `inject()`, providers, tokens, modules, lifecycle
5. [Request pipeline](https://getsodajs.github.io/docs/request-pipeline.md): middleware, guards, interceptors, exception filters, CORS
6. [Configuration](https://getsodajs.github.io/docs/configuration.md): typed environment, validated at startup
7. [Authentication](https://getsodajs.github.io/docs/authentication.md): JWT, cookies, the current user
8. [WebSockets](https://getsodajs.github.io/docs/websockets.md): gateways, messages, rooms
9. [Rate limiting](https://getsodajs.github.io/docs/rate-limiting.md): limits per client and route
10. [OpenAPI](https://getsodajs.github.io/docs/openapi.md): the document and Swagger UI from your routes
11. [Logging](https://getsodajs.github.io/docs/logging.md): the logger, levels, JSON output
12. [Testing](https://getsodajs.github.io/docs/testing.md): the application over HTTP, replaced providers
13. [Production](https://getsodajs.github.io/docs/production.md): build, shutdown, proxies, limits, Docker

## Recipes

- [Database](https://getsodajs.github.io/docs/recipes/database.md): `Bun.sql`, Drizzle, Prisma
- [File uploads](https://getsodajs.github.io/docs/recipes/file-uploads.md): forms, files, limits, storage

## Coming from Nest

[From Nest](https://getsodajs.github.io/docs/from-nest.md) maps each Nest feature to Soda's, and says what differs.
