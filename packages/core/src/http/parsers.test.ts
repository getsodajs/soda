import { describe, expect, it } from 'bun:test'
import { HttpException } from './exceptions.ts'
import { boolean, int, number, uuid } from './parsers.ts'

const status = (run: () => unknown): number | undefined => {
  try {
    run()

    return undefined
  } catch (error) {
    return error instanceof HttpException ? error.status : undefined
  }
}

describe('parsers', () => {
  it('convert valid strings', () => {
    expect(int.parse('-42', 'id')).toBe(-42)
    expect(number.parse('1.5e3', 'n')).toBe(1500)
    expect(boolean.parse('false', 'flag')).toBe(false)
    expect(uuid.parse('550E8400-E29B-41D4-A716-446655440000', 'id')).toBe('550E8400-E29B-41D4-A716-446655440000')
  })

  it('give 400 for missing or invalid values', () => {
    expect(status(() => int.parse(undefined, 'id'))).toBe(400)
    expect(status(() => int.parse('1.5', 'id'))).toBe(400)
    expect(status(() => int.parse('99999999999999999999', 'id'))).toBe(400)
    expect(status(() => number.parse('Infinity', 'n'))).toBe(400)
    expect(status(() => boolean.parse('yes', 'flag'))).toBe(400)
    expect(status(() => uuid.parse('not-a-uuid', 'id'))).toBe(400)
  })

  it('accept a missing value with optional(), but still reject an invalid one', () => {
    const page = int.optional()

    expect(page.parse(undefined, 'page')).toBeUndefined()
    expect(page.parse('2', 'page')).toBe(2)
    expect(status(() => page.parse('two', 'page'))).toBe(400)
    expect(int.optional()).toBe(page)
  })

  it('say whether a value is required, for API descriptions', () => {
    expect(int.required).toBe(true)
    expect(int.optional().required).toBe(false)
    expect(uuid.jsonSchema).toEqual({ type: 'string', format: 'uuid' })
    expect(uuid.optional().jsonSchema).toEqual({ type: 'string', format: 'uuid' })
  })
})
