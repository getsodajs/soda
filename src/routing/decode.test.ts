import { afterAll, describe, expect, it } from 'bun:test'
import { decodeComponent } from './decode.ts'
import { createRandom, pick } from './testing.ts'

describe('decodeComponent', () => {
  it.each([
    ['plain', 'plain'],
    ['a+b', 'a+b'],
    ['%41', 'A'],
    ['%2f%2F', '//'],
    ['%25', '%'],
    ['%e2%9c%93', '✓'],
    ['%F0%9F%98%80', '😀'],
    ['%C2%80', '\u0080'],
    ['%ED%9F%BF', '\uD7FF'],
    ['%EE%80%80', '\uE000'],
  ])('decodes %s', (input, expected) => {
    expect(decodeComponent(input)).toBe(expected)
  })

  it.each([
    ['a%zzb', 'a\uFFFDb'],
    ['a%zzz', 'a\uFFFDz'],
    ['a%z', 'a\uFFFDz'],
    ['%', '\uFFFD'],
    ['%4', '\uFFFD4'],
    ['%%41', '\uFFFD1'],
    ['%E2%9C', '\uFFFD'],
    ['%E2%9Cx%93', '\uFFFDx\uFFFD'],
    ['%C2%C2%80', '\uFFFD\u0080'],
    ['%C0%AF', '\uFFFD'],
    ['%E0%80%80', '\uFFFD'],
    ['%ED%A0%80', '\uFFFD'],
    ['%F4%90%80%80', '\uFFFD'],
    ['%F8%80', '\uFFFD\uFFFD'],
    ['%FF%FF', '\uFFFD\uFFFD'],
  ])('replaces malformed input %s like Bun', (input, expected) => {
    expect(decodeComponent(input)).toBe(expected)
  })

  describe('matches Bun on random input', () => {
    const server = Bun.serve({ port: 0, routes: { '/:value': (req) => Response.json(req.params.value) } })

    afterAll(() => server.stop(true))

    const TOKENS = [
      '%', '%z', '%zz', '%4', '%41', '%2F', '%25', '%C3', '%A9', '%E2', '%9C', '%93', '%F0', '%9F', '%98',
      '%80', '%BF', '%FF', '%ED', '%A0', '%C0', '%F4', '%F5', '%90', '%e2', '%8f', 'a', 'z', '4', '1', '+',
    ]

    it('produces the same value as req.params for 3000 random components', async () => {
      const seed = 20261113
      const random = createRandom(seed)

      for (let n = 0; n < 3000; n++) {
        let value = ''

        for (let i = 1 + Math.floor(random() * 6); i > 0; i--) {
          value += pick(random, TOKENS)
        }

        const res = await fetch(`${server.url.origin}/${value}`)

        expect({ seed, n, value, decoded: decodeComponent(value) }).toEqual({
          seed,
          n,
          value,
          decoded: (await res.json()) as string,
        })
      }
    })
  })
})
