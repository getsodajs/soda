/**
 * @module
 * Colors of the console: Soda's lime, and a few around it.
 *
 * Written in hex and turned into terminal codes once, at startup: in 24-bit
 * color where the terminal says it has it (`COLORTERM`), the nearest of 256 otherwise.
 */

import type { LogLevel } from './logger.ts'

export type Paint = (text: string) => string

export interface Palette {
  /** Soda's own: the name, `GET`, `LOG`. */
  readonly lime: Paint
  /** Contexts, the URL, path parameters, `POST`. */
  readonly aqua: Paint
  /** Guards, WebSockets, `debug`. */
  readonly violet: Paint
  readonly amber: Paint
  readonly coral: Paint
  /** What is there to be skimmed: times, separators, data keys. */
  readonly dim: Paint
  readonly bold: Paint
  readonly level: Readonly<Record<LogLevel, Paint>>
  readonly method: (method: string) => Paint
}

const HEX = {
  lime: '#a3e635',
  aqua: '#67e8f9',
  violet: '#c4b5fd',
  amber: '#fbbf24',
  coral: '#f87171',
  dim: '#7c7c86',
} as const

const plain: Paint = (text) => text

const foreground = (hex: string, depth: 'ansi-16m' | 'ansi-256'): Paint => {
  const code = Bun.color(hex, depth) ?? ''

  return (text) => `${code}${text}\u001B[39m`
}

const create = (paint: (hex: string) => Paint, bold: Paint): Palette => {
  const lime = paint(HEX.lime)
  const aqua = paint(HEX.aqua)
  const violet = paint(HEX.violet)
  const amber = paint(HEX.amber)
  const coral = paint(HEX.coral)
  const dim = paint(HEX.dim)
  const methods: Readonly<Record<string, Paint>> = {
    GET: lime,
    HEAD: dim,
    OPTIONS: dim,
    POST: aqua,
    PUT: amber,
    PATCH: amber,
    DELETE: coral,
    WS: violet,
  }

  return {
    lime,
    aqua,
    violet,
    amber,
    coral,
    dim,
    bold,
    level: {
      verbose: dim,
      debug: violet,
      log: lime,
      warn: amber,
      error: coral,
      fatal: (text) => bold(coral(text)),
    },
    method: (method) => methods[method] ?? plain,
  }
}

/** Every paint leaves the text as it is: no colors. */
export const PLAIN: Palette = create(() => plain, plain)

let colored: Palette | undefined

/** The palette in colors, created on first use. */
export const colors = (): Palette => {
  const term = process.env.COLORTERM
  const depth = term === 'truecolor' || term === '24bit' ? 'ansi-16m' : 'ansi-256'

  colored ??= create(
    (hex) => foreground(hex, depth),
    (text) => `\u001B[1m${text}\u001B[22m`
  )

  return colored
}
