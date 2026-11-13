import { describe, expect, it } from 'bun:test'
import { RouteError } from './errors.ts'
import { expandOptional, parsePath } from './path.ts'
import type { Segment } from './path.ts'

const format = (segments: readonly Segment[]): string => {
  let path = ''

  for (const segment of segments) {
    path +=
      segment.type === 'static'
        ? `/${segment.value}`
        : segment.type === 'param'
          ? `/:${segment.name}${segment.pattern === undefined ? '' : `{${segment.pattern}}`}`
          : `/*${segment.name ?? ''}`
  }

  return path === '' ? '/' : path
}

const expectSyntaxError = (path: string, reason: RegExp): void => {
  let error: unknown

  try {
    expandOptional(path, parsePath(path))
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(RouteError)
  expect((error as RouteError).code).toBe('SYNTAX')
  expect((error as RouteError).message).toMatch(reason)
}

describe('parsePath', () => {
  it('parses every segment type', () => {
    expect(parsePath('/')).toEqual([])
    expect(parsePath('/users/:id{\\d+}/*rest')).toEqual([
      { type: 'static', value: 'users' },
      { type: 'param', name: 'id', pattern: '\\d+', optional: false },
      { type: 'wildcard', name: 'rest' },
    ])
    expect(parsePath('/a/:b?/*')).toEqual([
      { type: 'static', value: 'a' },
      { type: 'param', name: 'b', pattern: undefined, optional: true },
      { type: 'wildcard', name: undefined },
    ])
  })

  it('keeps slashes, braces and escapes inside a regex', () => {
    expect(format(parsePath('/:x{[^\\/]+}/:y{a{1,3}}/:z{\\}}'))).toBe('/:x{[^\\/]+}/:y{a{1,3}}/:z{\\}}')
  })

  it('keeps a trailing slash as an empty static segment', () => {
    expect(parsePath('/a/')).toEqual([
      { type: 'static', value: 'a' },
      { type: 'static', value: '' },
    ])
  })

  it('normalises static segments to the form clients send', () => {
    expect(format(parsePath('/café/a b/%c3%a9/100%25'))).toBe('/caf%C3%A9/a%20b/%C3%A9/100%25')
  })

  it.each([
    ['users', /must start with "\/"/],
    ['/a//b', /empty segment/],
    ['/:1x', /not a valid parameter name/],
    ['/:', /not a valid parameter name/],
    ['/*1', /not a valid wildcard name/],
    ['/:id/:id', /duplicate parameter "id"/],
    ['/:id/*id', /duplicate parameter "id"/],
    ['/:id{(}', /invalid regex for ":id"/],
    ['/:id{}', /empty regex for ":id"/],
    ['/:id{\\d+}x', /unexpected characters after the regex/],
    ['/:id{\\d+', /unbalanced "{"/],
    ['/:id}', /unbalanced "}"/],
    ['/*/a', /a wildcard must be the last segment/],
    ['/file.:ext', /not allowed in a static segment/],
    ['/assets*', /not allowed in a static segment/],
    ['/a\\b', /not allowed in a static segment/],
    ['/a/..', /dot segment/],
    ['/a/%2e', /dot segment/],
    ['/:a?/b', /only trailing parameters can be optional/],
    ['/:a?/:b', /only trailing parameters can be optional/],
    ['/:a?/*', /only trailing parameters can be optional/],
  ])('rejects %s', (path, reason) => {
    expectSyntaxError(path, reason)
  })
})

describe('expandOptional', () => {
  const expand = (path: string): string[] => expandOptional(path, parsePath(path)).map(format)

  it('expands trailing optional parameters', () => {
    expect(expand('/api/animals/:type?')).toEqual(['/api/animals', '/api/animals/:type'])
    expect(expand('/v1/:version?/:platform{ios|android}?')).toEqual([
      '/v1',
      '/v1/:version',
      '/v1/:version/:platform{ios|android}',
    ])
    expect(expand('/:id?')).toEqual(['/', '/:id'])
  })

  it('returns a path without optional parameters as is', () => {
    expect(expand('/plain/:id')).toEqual(['/plain/:id'])
  })
})
