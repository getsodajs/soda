/**
 * @module
 * Signed cookies. Reading and writing cookies is Bun's: `ctx.cookies` is the
 * request's `CookieMap`, whose changes Bun sends with the response as
 * `Set-Cookie`. This module adds what `@fastify/cookie` and `cookie-signature`
 * add on top: values signed with HMAC-SHA256, so the client can read them but
 * not forge them.
 *
 * ```ts
 * const signer = new CookieSigner(process.env.COOKIE_SECRET!)
 *
 * ctx.cookies.set('session', signer.sign(id), { httpOnly: true, secure: true })
 *
 * @Get('me', [cookie('session', signed(signer))])
 * me(id: string) {}
 * ```
 *
 * A signature proves the value was set by the server, not that it is secret
 * or recent: store secrets server-side, and limit the lifetime with `maxAge`.
 */

import { timingSafeEqual } from 'node:crypto'
import { failure } from './parsers.ts'
import type { Parser, ParserOptions } from './parsers.ts'

const hmac = (secret: string, value: string): string =>
  new Bun.CryptoHasher('sha256', secret).update(value).digest('base64url')

/**
 * Signs cookie values as `value.signature` and checks them. Several secrets
 * allow rotation: the first signs, every one verifies.
 *
 * ```ts
 * new CookieSigner([process.env.COOKIE_SECRET!, process.env.OLD_COOKIE_SECRET!])
 * ```
 */
export class CookieSigner {
  readonly #secrets: readonly string[]

  /** Secrets should be random and long: `openssl rand -base64 32`. */
  constructor(secrets: string | readonly string[]) {
    const list = typeof secrets === 'string' ? [secrets] : [...secrets]

    if (list.length === 0 || list.includes('')) {
      throw new TypeError('CookieSigner needs at least one secret, and no empty ones')
    }

    this.#secrets = list
  }

  /** `value` followed by `.` and its signature, in base64url. */
  sign(value: string): string {
    return `${value}.${hmac(this.#secrets[0]!, value)}`
  }

  /** The value of a signed string, or `undefined` if it is not signed by one of the secrets. */
  unsign(signed: string): string | undefined {
    const dot = signed.lastIndexOf('.')

    if (dot === -1) {
      return undefined
    }

    const value = signed.slice(0, dot)
    const signature = Buffer.from(signed.slice(dot + 1))

    for (const secret of this.#secrets) {
      const expected = Buffer.from(hmac(secret, value))

      if (expected.length === signature.length && timingSafeEqual(expected, signature)) {
        return value
      }
    }

    return undefined
  }
}

type Result<O extends ParserOptions> = O extends { readonly optional: true } ? string | undefined : string

/**
 * Parser of a signed cookie: its value, `400` when it is missing or its
 * signature is wrong. With `{ optional: true }`, both give `undefined`, as a
 * forged cookie is no better than none.
 */
export const signed = <const O extends ParserOptions = {}>(signer: CookieSigner, options?: O): Parser<Result<O>> => ({
  jsonSchema: { type: 'string' },
  optional: options?.optional === true,
  parse: (value, name) => {
    const unsigned = value === undefined ? undefined : signer.unsign(value)

    if (unsigned === undefined && options?.optional !== true) {
      throw failure(name, 'signed cookie')
    }

    return unsigned as Result<O>
  },
})
