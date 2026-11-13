/**
 * @module
 * Signing and verifying JSON Web Tokens (RFC 7519) with WebCrypto.
 */

import { parseJson } from '../http/body.ts'
import { importKey, isHmac, isJwtAlgorithm, signBytes, verifyBytes } from './algorithms.ts'
import type { JwtAlgorithm, JwtKey } from './algorithms.ts'
import { JwtError } from './errors.ts'

/** Claims of a token: the registered ones (RFC 7519, section 4.1) and any other. */
export interface JwtPayload {
  readonly iss?: string
  readonly sub?: string
  readonly aud?: string | readonly string[]
  /** Expiration time, in seconds since the epoch. */
  readonly exp?: number
  /** Not before, in seconds since the epoch. */
  readonly nbf?: number
  /** Issued at, in seconds since the epoch. */
  readonly iat?: number
  readonly jti?: string
  readonly [claim: string]: unknown
}

export interface JwtOptions {
  /** Defaults to `HS256`. The only algorithm accepted when verifying. */
  readonly algorithm?: JwtAlgorithm
  /** Secret of an `HS*` algorithm. Random and at least as long as the hash: `openssl rand -base64 32`. */
  readonly secret?: string
  /** Key signing with an asymmetric algorithm. */
  readonly privateKey?: JwtKey
  /** Key verifying with an asymmetric algorithm. */
  readonly publicKey?: JwtKey
  /** Lifetime of signed tokens, in seconds: sets `exp`. */
  readonly expiresIn?: number
  /** Sets `iss` when signing; required when verifying. */
  readonly issuer?: string
  /** Sets `aud` when signing; when verifying, `aud` must hold one of these. */
  readonly audience?: string | readonly string[]
  /** Seconds of clock difference allowed when checking `exp` and `nbf`. Defaults to 0. */
  readonly clockTolerance?: number
}

export interface JwtSignOptions {
  /** Lifetime of this token, in seconds, instead of the configured one. */
  readonly expiresIn?: number
}

const BASE64URL = /^[\w-]+$/
const TIME_CLAIMS = ['exp', 'nbf', 'iat'] as const
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const encodePart = (bytes: Uint8Array): string => bytes.toBase64({ alphabet: 'base64url', omitPadding: true })

const decodeBytes = (part: string): Uint8Array<ArrayBuffer> => Uint8Array.fromBase64(part, { alphabet: 'base64url' })

/** The JSON object in a part of a token. */
const decodeObject = (part: string, name: string): Record<string, unknown> => {
  let value: unknown

  try {
    value = parseJson(decoder.decode(decodeBytes(part)))
  } catch {
    value = undefined
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JwtError('malformed', `Token ${name} is not a JSON object`)
  }

  return value as Record<string, unknown>
}

const seconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Signs and verifies tokens with one algorithm and its keys, imported once.
 *
 * ```ts
 * const jwt = new JwtService({ secret: process.env.JWT_SECRET!, expiresIn: 15 * 60 })
 * const token = await jwt.sign({ sub: user.id })
 * const payload = await jwt.verify(token) // throws JwtError
 * ```
 *
 * The algorithm comes from the options, never from the token: a token signed
 * otherwise, or not signed (`alg: none`), is refused. The signature is
 * checked before any claim is trusted.
 */
export class JwtService {
  readonly #options: JwtOptions
  readonly #algorithm: JwtAlgorithm
  #signingKey: Promise<CryptoKey> | undefined
  #verifyingKey: Promise<CryptoKey> | undefined

  constructor(options: JwtOptions) {
    const algorithm = options.algorithm ?? 'HS256'

    if (!isJwtAlgorithm(algorithm)) {
      throw new TypeError(`Unsupported JWT algorithm: ${String(algorithm)}`)
    }

    const hasKeys = options.privateKey !== undefined || options.publicKey !== undefined

    if (isHmac(algorithm) && (options.secret === undefined || options.secret === '' || hasKeys)) {
      throw new TypeError(`${algorithm} takes a non-empty secret, not keys`)
    }

    if (!isHmac(algorithm) && (options.secret !== undefined || !hasKeys)) {
      throw new TypeError(`${algorithm} takes privateKey to sign and publicKey to verify, not a secret`)
    }

    this.#options = options
    this.#algorithm = algorithm
  }

  /**
   * Signs `payload`, adding `iat`, and `exp`, `iss`, `aud` from the options.
   * Claims in `payload` win over the added ones.
   */
  async sign(payload: JwtPayload, options?: JwtSignOptions): Promise<string> {
    const now = seconds()
    const expiresIn = options?.expiresIn ?? this.#options.expiresIn
    const { issuer, audience } = this.#options
    const claims = {
      iat: now,
      ...(expiresIn === undefined ? {} : { exp: now + expiresIn }),
      ...(issuer === undefined ? {} : { iss: issuer }),
      ...(audience === undefined ? {} : { aud: audience }),
      ...payload,
    }
    const input = `${encodePart(encoder.encode(JSON.stringify({ alg: this.#algorithm, typ: 'JWT' })))}.${encodePart(encoder.encode(JSON.stringify(claims)))}`

    this.#signingKey ??= importKey(this.#key('privateKey'), this.#algorithm, 'sign')

    return `${input}.${encodePart(await signBytes(this.#algorithm, await this.#signingKey, encoder.encode(input)))}`
  }

  /** The payload of a valid token; throws a {@link JwtError} otherwise. */
  async verify<T extends JwtPayload = JwtPayload>(token: string): Promise<T> {
    const parts = token.split('.')

    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
      throw new JwtError('malformed', 'Token is not three base64url parts')
    }

    const [header, body, signature] = parts as [string, string, string]
    const { alg, crit } = decodeObject(header, 'header')

    if (alg !== this.#algorithm) {
      throw new JwtError('algorithm', `Token is signed with ${String(alg)}, ${this.#algorithm} is expected`)
    }

    if (crit !== undefined) {
      throw new JwtError('algorithm', 'Token has critical header extensions, which are not supported')
    }

    this.#verifyingKey ??= importKey(this.#key('publicKey'), this.#algorithm, 'verify')

    const valid = await verifyBytes(this.#algorithm, await this.#verifyingKey, decodeBytes(signature), encoder.encode(`${header}.${body}`))

    if (!valid) {
      throw new JwtError('signature', 'Token signature does not match')
    }

    const payload = decodeObject(body, 'payload')

    this.#checkClaims(payload)

    return payload as T
  }

  #key(kind: 'privateKey' | 'publicKey'): JwtKey {
    const key = isHmac(this.#algorithm) ? this.#options.secret : this.#options[kind]

    if (key === undefined) {
      throw new TypeError(`${this.#algorithm} needs ${kind} to ${kind === 'privateKey' ? 'sign' : 'verify'}`)
    }

    return key
  }

  #checkClaims(payload: Record<string, unknown>): void {
    for (const claim of TIME_CLAIMS) {
      if (payload[claim] !== undefined && !Number.isFinite(payload[claim])) {
        throw new JwtError('claims', `Token claim "${claim}" is not a number`)
      }
    }

    const { exp, nbf, iss, aud } = payload as JwtPayload
    const { issuer, audience, clockTolerance = 0 } = this.#options
    const now = seconds()

    if (exp !== undefined && now >= exp + clockTolerance) {
      throw new JwtError('expired', 'Token expired')
    }

    if (nbf !== undefined && now + clockTolerance < nbf) {
      throw new JwtError('not-active', 'Token is not active yet')
    }

    if (issuer !== undefined && iss !== issuer) {
      throw new JwtError('claims', `Token issuer is not "${issuer}"`)
    }

    if (audience !== undefined) {
      const expected: readonly string[] = typeof audience === 'string' ? [audience] : audience
      const actual: readonly unknown[] = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : []

      if (!actual.some((value) => expected.includes(value as string))) {
        throw new JwtError('claims', `Token audience is not ${expected.map((value) => `"${value}"`).join(' or ')}`)
      }
    }
  }
}
