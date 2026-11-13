/**
 * @module
 * `OpenApiModule`: serves the OpenAPI document of the application, and a
 * Swagger UI page, as `SwaggerModule.setup()` of `@nestjs/swagger` does.
 */

import { inject, Module } from '../di/index.ts'
import type { DynamicModule } from '../di/index.ts'
import { Controller, Get } from '../http/decorators.ts'
import { ROUTES } from '../http/routes.ts'
import { ApiExclude } from './decorators.ts'
import { createOpenApiDocument } from './document.ts'
import type { OpenApiDocument, OpenApiOptions } from './document.ts'

export interface OpenApiModuleOptions extends OpenApiOptions {
  /** Path of the JSON document. Defaults to `/openapi.json`. */
  readonly path?: string
  /** Path of a Swagger UI page reading the document, such as `/docs`. None by default. */
  readonly ui?: string
}

/** Swagger UI, from a CDN at a fixed version. */
const SWAGGER_UI = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.34.0'

const page = (title: string, documentUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${Bun.escapeHTML(title)}</title>
<link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
</head>
<body>
<div id="docs"></div>
<script src="${SWAGGER_UI}/swagger-ui-bundle.js" crossorigin></script>
<script>SwaggerUIBundle({ url: ${JSON.stringify(documentUrl)}, dom_id: '#docs' })</script>
</body>
</html>
`

/**
 * ```ts
 * @Module({ imports: [OpenApiModule.forRoot({ info: { title: 'Shop', version: '1.0.0' }, ui: '/docs' })] })
 * class AppModule {}
 * ```
 *
 * The document is built on the first request, from every route of the
 * application (these two excepted), and kept.
 */
@Module({})
export class OpenApiModule {
  static forRoot(options: OpenApiModuleOptions): DynamicModule {
    const documentPath = options.path ?? '/openapi.json'

    @Controller()
    @ApiExclude()
    class OpenApiController {
      readonly #routes = inject(ROUTES)
      #document: OpenApiDocument | undefined

      @Get(documentPath)
      document(): OpenApiDocument {
        this.#document ??= createOpenApiDocument(this.#routes.controllers, options)

        return this.#document
      }
    }

    const controllers: (new () => unknown)[] = [OpenApiController]

    if (options.ui !== undefined) {
      const ui = options.ui

      @Controller()
      @ApiExclude()
      class OpenApiUiController {
        readonly #routes = inject(ROUTES)

        @Get(ui)
        page(): Response {
          // The document's own path, global prefix included.
          const documentUrl = this.#routes.controllers.find((mapped) => mapped.controller === OpenApiController)?.routes[0]?.info.path

          return new Response(page(options.info.title, documentUrl ?? documentPath), {
            headers: { 'content-type': 'text/html;charset=utf-8' },
          })
        }
      }

      controllers.push(OpenApiUiController)
    }

    return { module: OpenApiModule, controllers }
  }
}
