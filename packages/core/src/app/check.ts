/**
 * @module
 * `checkApp()`: what would stop the application from starting, all of it at
 * once, without starting it. What `soda check` runs.
 *
 * ```ts
 * const report = await checkApp(AppModule)
 *
 * report.problems
 * // [{ code: 'NO_PROVIDER', message: 'No provider for UsersRepository in UsersModule (UsersService → UsersRepository).',
 * //    fix: 'DatabaseModule provides it but does not export it: add it to the exports of DatabaseModule.',
 * //    file: 'src/users/users.service.ts', line: 4, column: 24 }]
 * ```
 *
 * The graph is resolved as `createApp()` does, dry: classes are created
 * (their `inject()` calls are their dependencies), factories are not called
 * but configurations are loaded, no `onInit` runs, nothing listens. The
 * routes are built and compiled, so conflicts and unknown parameters are found too.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { ConfigError } from '../config/config.ts'
import { createDryContainer } from '../di/container.ts'
import { DiError, provide } from '../di/index.ts'
import type { ModuleImport } from '../di/index.ts'
import { buildRoutes, ControllerError, ROUTES } from '../http/index.ts'
import { resolveMiddleware } from '../http/middleware.ts'
import { Logger, SilentLogger } from '../logger/index.ts'
import { compileRoutes } from '../routing/index.ts'
import { RouteError } from '../routing/errors.ts'
import { FRAMEWORK, siteOf } from '../utils/errors.ts'
import type { SourceSite } from '../utils/errors.ts'
import type { AppOptions } from './app.ts'
import { withGateways } from './serve.ts'

/** One thing that would stop the application from starting. */
export interface CheckProblem {
  /** `NO_PROVIDER`, `UNKNOWN_PARAM`, `INVALID_CONFIG`... the `code` of the error; `FAILED` for any other error. */
  readonly code: string
  readonly message: string
  /** What to change, when there is one obvious way. */
  readonly fix?: string
  /** Where in the application's code, relative to the working directory, when the error points there. */
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

export interface CheckReport {
  readonly ok: boolean
  readonly problems: readonly CheckProblem[]
  /** Milliseconds the check took. */
  readonly duration: number
  readonly modules: number
  readonly providers: number
  /** Routes and gateways. */
  readonly routes: number
}

/** `at new UsersService (/app/src/users.ts:4:24)` or `at /app/src/main.ts:3:1`. */
const FRAME = /^\s*at (?:.*?\()?(.+?):(\d+):(\d+)\)?$/

type Place = Pick<CheckProblem, 'file' | 'line' | 'column'>

const SOURCE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** Source files under `directory`, dependencies, builds and hidden directories left out. */
const walk = (directory: string, files: Map<string, readonly string[]>): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = directory === '.' ? entry.name : `${directory}/${entry.name}`

    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)) {
      walk(path, files)
    } else if (entry.isFile() && SOURCE.test(entry.name) && !files.has(path)) {
      files.set(path, readFileSync(path, 'utf8').split('\n'))
    }
  }
}

/** Sources of the application, read once per check: `src/` first, the rest of the working directory after. */
const sources = (): ReadonlyMap<string, readonly string[]> => {
  const files = new Map<string, readonly string[]>()

  if (existsSync('src')) {
    walk('src', files)
  }

  walk('.', files)

  return files
}

/** The first line from `from` holding one of `text`. */
const find = (lines: readonly string[], text: readonly string[], from: number): Place | undefined => {
  for (let i = from; i < lines.length; i++) {
    const column = Math.max(...text.map((needle) => lines[i]!.indexOf(needle)))

    if (column >= 0) {
      return { line: i + 1, column: column + 1 }
    }
  }

  return undefined
}

/** `site` in the sources: in its class when it names one, the class itself otherwise. */
const search = (site: SourceSite, files: ReadonlyMap<string, readonly string[]>): Place => {
  const declaration = site.class === undefined ? undefined : new RegExp(`\\bclass ${site.class.replaceAll('$', '\\$')}\\b`)

  for (const [file, lines] of files) {
    if (declaration === undefined) {
      const found = find(lines, site.text, 0)

      if (found !== undefined) {
        return { file, ...found }
      }

      continue
    }

    const start = lines.findIndex((line) => declaration.test(line))

    if (start >= 0) {
      return { file, ...(find(lines, site.text, start) ?? { line: start + 1, column: lines[start]!.indexOf('class') + 1 }) }
    }
  }

  return {}
}

/** The first frame of the stack in the application's own code. */
const frameOf = (error: Error): Place => {
  for (const line of (error.stack ?? '').split('\n')) {
    const match = FRAME.exec(line)

    if (match === null) {
      continue
    }

    const file = match[1]!.replace(/^file:\/\//, '')

    if (file.includes('/node_modules/') || file.startsWith(FRAMEWORK) || !file.startsWith('/')) {
      continue
    }

    return { file: relative(process.cwd(), file), line: Number(match[2]), column: Number(match[3]) }
  }

  return {}
}

const CODED = [DiError, ControllerError, RouteError] as const

let files: ReadonlyMap<string, readonly string[]> | undefined

/** Where the error is: its site in the sources when it has one, the first frame of the application otherwise. */
const locate = (error: Error): Place => {
  const site = siteOf(error)

  if (site === undefined) {
    return frameOf(error)
  }

  files ??= sources()

  return search(site, files)
}

/** An error as a problem: its code, its message without the fix, the fix, the place. */
export const problemOf = (error: unknown): CheckProblem => {
  if (!(error instanceof Error)) {
    return { code: 'FAILED', message: String(error) }
  }

  const where = locate(error)

  if (error instanceof ConfigError) {
    return {
      code: 'INVALID_CONFIG',
      message: error.message,
      fix: 'Set the variables in the environment or in .env, as the schema of the configuration expects.',
      ...where,
    }
  }

  if (error instanceof DiError && error.fix !== undefined) {
    return { code: error.code, message: error.message.slice(0, -error.fix.length - 1), fix: error.fix, ...where }
  }

  if (CODED.some((type) => error instanceof type)) {
    return { code: (error as DiError).code, message: error.message, ...where }
  }

  return { code: 'FAILED', message: `${error.name}: ${error.message}`, ...where }
}

/**
 * Checks `root` with the options `createApp()` would get, and reports every
 * problem found. Never throws and leaves nothing open.
 */
export const checkApp = async (root: ModuleImport, options: AppOptions = {}): Promise<CheckReport> => {
  const started = performance.now()
  const problems = new Map<string, CheckProblem>()

  // The same problem met from several places is reported once.
  const report = (error: unknown): void => {
    const problem = problemOf(error)

    problems.set(`${problem.code} ${problem.message}`, problem)
  }

  let modules = 0
  let providers = 0
  let routes = 0

  try {
    const container = await createDryContainer(
      root,
      {
        ...options,
        providers: [...(options.providers ?? []), provide(Logger, { useValue: new SilentLogger() }), provide(ROUTES, { useValue: { controllers: [] } })],
      },
      report
    )

    modules = container.modules.length
    providers = container.providerCount

    try {
      resolveMiddleware(options.middleware ?? [], (fn) => container.runInContext(fn), () => undefined)
    } catch (error) {
      report(error)
    }

    const built = buildRoutes(container, options, report)

    routes = built.routes.length + built.gateways.length
    withGateways(compileRoutes(built.routes, options), built.gateways)
  } catch (error) {
    report(error)
  }

  files = undefined

  return { ok: problems.size === 0, problems: [...problems.values()], duration: performance.now() - started, modules, providers, routes }
}

/** Where `soda check` waits for the report: `createApp()` hands it over instead of starting. */
export const CHECK_HOOK = Symbol.for('soda.check')

/** Receives the report as soon as `createApp()` is called, before the check ends. */
export type CheckHook = (report: Promise<CheckReport>) => void
