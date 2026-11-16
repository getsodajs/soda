/**
 * @module
 * The summary `ConsoleLogger` draws when an application listens.
 *
 * ```
 *   soda 0.4.0  ready in 41 ms  →  http://localhost:3000/
 *
 *   3 modules · 12 providers · 4 routes · 1 gateway
 *   middleware   cors
 *   every route  ThrottlerGuard
 *
 *   GET     /users        UsersController.findAll    query page
 *   GET     /users/:id    UsersController.findOne    JwtGuard
 *   POST    /users        UsersController.create     body  JwtGuard
 *   WS      /chat         ChatGateway                message, typing
 * ```
 */

import type { StartupReport, StartupRoute } from './logger.ts'
import type { Palette } from './palette.ts'

const INDENT = '  '

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Pads after painting, by the width of the text itself. */
const pad = (text: string, painted: string, width: number): string => painted + ' '.repeat(Math.max(0, width - text.length))

/** `/users/:id` with its parameters stand out. */
const paintPath = (path: string, palette: Palette): string => path.replaceAll(/[:*][^/]*/g, (segment) => palette.aqua(segment))

const extras = (route: StartupRoute, palette: Palette): string => {
  const parts: string[] = []

  if (route.sse) {
    parts.push(palette.aqua('sse'))
  }

  if (route.inputs.length > 0) {
    parts.push(palette.dim(route.inputs.join('  ')))
  }

  if (route.guards.length > 0) {
    parts.push(palette.violet(route.guards.join(' ')))
  }

  if (route.interceptors.length > 0) {
    parts.push(palette.dim(route.interceptors.join(' ')))
  }

  return parts.join('  ')
}

const header = (report: StartupReport, palette: Palette): string[] => {
  const { bold, dim, lime, aqua } = palette
  const gateways = report.routes.filter((route) => route.method === 'WS').length
  const figures = [count(report.modules, 'module'), count(report.providers, 'provider'), count(report.routes.length - gateways, 'route')]

  if (gateways > 0) {
    figures.push(count(gateways, 'gateway'))
  }

  const lines = [
    '',
    `${INDENT}${bold(lime('soda'))} ${dim(report.version)}  ${dim('ready in')} ${bold(`${Math.round(report.duration)} ms`)}  ${lime('→')}  ${aqua(report.url)}`,
    '',
    INDENT + figures.map((figure) => figure.replace(/^\d+/, (n) => bold(n))).join(dim(' · ')),
  ]
  const shared = [...report.guards.map((name) => palette.violet(name)), ...report.interceptors.map((name) => dim(name))]

  if (report.middleware.length > 0) {
    lines.push(`${INDENT}${dim('middleware ')}  ${report.middleware.join(dim(' · '))}`)
  }

  if (shared.length > 0) {
    lines.push(`${INDENT}${dim('every route')}  ${shared.join('  ')}`)
  }

  return lines
}

/** Lines of the summary, blank lines around. */
export const drawStartup = (report: StartupReport, palette: Palette): string => {
  const lines = header(report, palette)
  let methodWidth = 0
  let pathWidth = 0
  let handlerWidth = 0

  for (const route of report.routes) {
    methodWidth = Math.max(methodWidth, route.method.length)
    pathWidth = Math.max(pathWidth, route.path.length)
    handlerWidth = Math.max(handlerWidth, route.handler.length)
  }

  if (report.routes.length > 0) {
    lines.push('')
  }

  for (const route of report.routes) {
    const method = pad(route.method, palette.method(route.method)(route.method), methodWidth + 2)
    const path = pad(route.path, paintPath(route.path, palette), pathWidth + 2)
    const rest = extras(route, palette)
    const handler = rest === '' ? route.handler : pad(route.handler, route.handler, handlerWidth + 2)

    lines.push(`${INDENT}${method}${path}${handler}${rest}`)
  }

  lines.push('')

  return lines.join('\n')
}
