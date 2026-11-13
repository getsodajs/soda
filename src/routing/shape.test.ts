import { describe, expect, it } from 'bun:test'
import { parsePath } from './path.ts'
import { compareShapes, containsShape, intersectShapes, shapeId, shapeKey, shapeOf } from './shape.ts'
import type { Shape } from './shape.ts'

const shape = (path: string): Shape => shapeOf(parsePath(path))

describe('shapeId and shapeKey', () => {
  it('ignore names and regexes, keep statics', () => {
    expect(shapeId(shape('/users/:id{\\d+}/*rest'))).toBe('/users/:/*')
    expect(shapeId(shape('/'))).toBe('/')
    expect(shapeId(shape('/*'))).toBe('/*')
    expect(shapeKey(shape('/users/:a/x/:b'), ['id', 'tab'])).toBe('/users/:id/x/:tab')
    expect(shapeKey(shape('/'), [])).toBe('/')
  })
})

describe('intersectShapes', () => {
  const intersect = (a: string, b: string): string | undefined => {
    const result = intersectShapes(shape(a), shape(b))
    const reverse = intersectShapes(shape(b), shape(a))

    expect(reverse === undefined ? undefined : shapeId(reverse)).toBe(result === undefined ? undefined : shapeId(result))

    return result === undefined ? undefined : shapeId(result)
  }

  it.each([
    ['/a/:x', '/:y/b', '/a/b'],
    ['/x/*', '/x/:a/y', '/x/:/y'],
    ['/a/*', '/:p/:q/*', '/a/:/*'],
    ['/*', '/a', '/a'],
    ['/*', '/', undefined],
    ['/a', '/a/*', undefined],
    ['/a/*', '/a/', '/a/'],
    ['/a/:x', '/b/:y', undefined],
    ['/:x', '/:x/:y', undefined],
    ['/a/*', '/b/*', undefined],
    ['/:x/*', '/a/*', '/a/*'],
  ])('%s ∩ %s = %s', (a, b, expected) => {
    expect(intersect(a, b)).toBe(expected)
  })
})

describe('containsShape', () => {
  it.each([
    ['/:x', '/a', true],
    ['/a', '/:x', false],
    ['/*', '/a/b/*', true],
    ['/a/*', '/a', false],
    ['/a/*', '/a/', true],
    ['/:x/*', '/:x/:y/*', true],
    ['/:x/:y/*', '/:x/*', false],
  ])('%s ⊇ %s is %p', (outer, inner, expected) => {
    expect(containsShape(shape(outer), shape(inner))).toBe(expected)
  })
})

describe('compareShapes', () => {
  // Order verified against Bun in the differential tests; here: the rules themselves.
  it('puts static before parameter before tail, segment by segment', () => {
    const sorted = ['/*', '/:x/*', '/:x/:y', '/a/*', '/a/:y', '/:x/b', '/a/b'].map(shape).sort(compareShapes).map(shapeId)

    expect(sorted).toEqual(['/a/b', '/a/:', '/a/*', '/:/b', '/:/:', '/:/*', '/*'])
  })
})
