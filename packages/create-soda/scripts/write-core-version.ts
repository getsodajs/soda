/**
 * Writes the version of @getsoda/core next to the build, so that a published
 * create-soda creates projects depending on the core it was released with.
 */

const core = (await Bun.file(new URL('../../core/package.json', import.meta.url)).json()) as { version: string }

await Bun.write(new URL('../core-version.json', import.meta.url), `${JSON.stringify({ version: core.version })}\n`)
