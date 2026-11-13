import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test'
import { createHmac, verify as nodeVerify } from 'node:crypto'
import type { webcrypto } from 'node:crypto'
import type { JwtAlgorithm } from './algorithms.ts'
import { JwtError } from './errors.ts'
import { JwtService } from './service.ts'
import type { JwtOptions } from './service.ts'

const SECRET = 'a-secret-long-enough-for-hs256-tokens'
const NOW = new Date('2026-01-01T00:00:00Z')
const now = NOW.getTime() / 1000

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A token built by hand, HMAC-signed with node:crypto. */
const handmade = (header: unknown, payload: unknown, secret = SECRET): string => {
  const input = `${base64url(header)}.${base64url(payload)}`

  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}

/** The JwtError code `promise` rejects with. */
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(JwtError)

    return `${(error as JwtError).code}: ${(error as JwtError).message}`
  }

  throw new Error('The token was accepted')
}

type GenerateParams = webcrypto.RsaHashedKeyGenParams | webcrypto.EcKeyGenParams | webcrypto.Algorithm

const toPem = (bytes: ArrayBuffer, label: string): string =>
  `-----BEGIN ${label}-----\n${new Uint8Array(bytes).toBase64().replace(/.{64}/g, '$&\n')}\n-----END ${label}-----\n`

const keyPair = async (params: GenerateParams) => {
  const pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair

  return {
    pair,
    privatePem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'),
    publicPem: toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  }
}

describe('JwtService', () => {
  beforeAll(() => setSystemTime(NOW))
  afterAll(() => setSystemTime())

  it('signs HS256 tokens node:crypto can check, with the configured claims', async () => {
    const jwt = new JwtService({ secret: SECRET, expiresIn: 60, issuer: 'soda', audience: ['web', 'api'] })
    const token = await jwt.sign({ sub: 'user-1', role: 'admin' })
    const [header, payload, signature] = token.split('.') as [string, string, string]

    expect(createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')).toBe(signature)
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(await jwt.verify(token)).toEqual({
      iat: now,
      exp: now + 60,
      iss: 'soda',
      aud: ['web', 'api'],
      sub: 'user-1',
      role: 'admin',
    })
  })

  it('lets the payload and the sign options override the configured claims', async () => {
    const jwt = new JwtService({ secret: SECRET, expiresIn: 60 })

    expect(await jwt.verify(await jwt.sign({ exp: now + 5 }))).toMatchObject({ exp: now + 5 })
    expect(await jwt.verify(await jwt.sign({}, { expiresIn: 10 }))).toMatchObject({ exp: now + 10 })
  })

  it('accepts tokens signed by others with the same secret', async () => {
    const jwt = new JwtService({ secret: SECRET })

    expect(await jwt.verify(handmade({ alg: 'HS256', typ: 'JWT' }, { sub: 'x' }))).toEqual({ sub: 'x' })
  })

  const asymmetric: readonly [JwtAlgorithm, GenerateParams, (data: Buffer, key: string, signature: Buffer) => boolean][] = [
    [
      'RS256',
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      (data, key, signature) => nodeVerify('sha256', data, key, signature),
    ],
    [
      'PS256',
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      (data, key, signature) => nodeVerify('sha256', data, { key, padding: 6, saltLength: 32 }, signature),
    ],
    [
      'ES256',
      { name: 'ECDSA', namedCurve: 'P-256' },
      (data, key, signature) => nodeVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature),
    ],
    ['EdDSA', { name: 'Ed25519' }, (data, key, signature) => nodeVerify(null, data, key, signature)],
  ]

  it.each(asymmetric)('signs %s with PEM keys, verifiable by node:crypto, and verifies with a JWK', async (algorithm, params, check) => {
    const keys = await keyPair(params)
    const signer = new JwtService({ algorithm, privateKey: keys.privatePem })
    const verifier = new JwtService({ algorithm, publicKey: keys.publicJwk })
    const token = await signer.sign({ sub: 'user-1' })
    const [header, payload, signature] = token.split('.') as [string, string, string]

    expect(check(Buffer.from(`${header}.${payload}`), keys.publicPem, Buffer.from(signature, 'base64url'))).toBe(true)
    expect(await verifier.verify(token)).toEqual({ iat: now, sub: 'user-1' })
    expect(await new JwtService({ algorithm, privateKey: keys.pair.privateKey, publicKey: keys.publicPem }).verify(token)).toEqual({
      iat: now,
      sub: 'user-1',
    })
  })

  it('refuses tokens not signed with the configured algorithm', async () => {
    const jwt = new JwtService({ secret: SECRET })
    const keys = await keyPair({ name: 'ECDSA', namedCurve: 'P-256' })
    const ecdsa = new JwtService({ algorithm: 'ES256', publicKey: keys.publicPem })
    const unsigned = `${base64url({ alg: 'none' })}.${base64url({ sub: 'x' })}.`

    expect(await refusal(jwt.verify(unsigned))).toBe('malformed: Token is not three base64url parts')
    expect(await refusal(jwt.verify(`${unsigned}AAAA`))).toBe('algorithm: Token is signed with none, HS256 is expected')
    expect(await refusal(jwt.verify(handmade({ alg: 'HS512' }, {})))).toBe('algorithm: Token is signed with HS512, HS256 is expected')
    // Algorithm confusion: an HS256 token keyed with the public key must not pass an ES256 service.
    expect(await refusal(ecdsa.verify(handmade({ alg: 'HS256' }, {}, keys.publicPem)))).toBe(
      'algorithm: Token is signed with HS256, ES256 is expected'
    )
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256', crit: ['exp'] }, {})))).toBe(
      'algorithm: Token has critical header extensions, which are not supported'
    )
  })

  it('refuses forged and malformed tokens', async () => {
    const jwt = new JwtService({ secret: SECRET })
    const token = await jwt.sign({ sub: 'user-1' })
    const [header, , signature] = token.split('.') as [string, string, string]

    expect(await refusal(jwt.verify(`${header}.${base64url({ sub: 'admin' })}.${signature}`))).toBe('signature: Token signature does not match')
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256' }, {}, 'another-secret')))).toBe('signature: Token signature does not match')
    expect(await refusal(jwt.verify('a.b'))).toBe('malformed: Token is not three base64url parts')
    expect(await refusal(jwt.verify(`${header}.e30.a+b`))).toBe('malformed: Token is not three base64url parts')
    expect(await refusal(jwt.verify(`${Buffer.from('nope').toString('base64url')}.e30.AAAA`))).toBe('malformed: Token header is not a JSON object')
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256' }, [1])))).toBe('malformed: Token payload is not a JSON object')
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256' }, { exp: '9999999999' })))).toBe('claims: Token claim "exp" is not a number')
  })

  it('checks exp and nbf, with the clock tolerance', async () => {
    const strict = new JwtService({ secret: SECRET })
    const tolerant = new JwtService({ secret: SECRET, clockTolerance: 30 })
    const expired = handmade({ alg: 'HS256' }, { exp: now - 10 })
    const early = handmade({ alg: 'HS256' }, { nbf: now + 10 })

    expect(await refusal(strict.verify(handmade({ alg: 'HS256' }, { exp: now })))).toBe('expired: Token expired')
    expect(await refusal(strict.verify(expired))).toBe('expired: Token expired')
    expect(await refusal(strict.verify(early))).toBe('not-active: Token is not active yet')
    expect(await tolerant.verify(expired)).toEqual({ exp: now - 10 })
    expect(await tolerant.verify(early)).toEqual({ nbf: now + 10 })
  })

  it('checks the issuer and the audience', async () => {
    const jwt = new JwtService({ secret: SECRET, issuer: 'soda', audience: ['web', 'api'] })

    expect(await jwt.verify(handmade({ alg: 'HS256' }, { iss: 'soda', aud: 'api' }))).toEqual({ iss: 'soda', aud: 'api' })
    expect(await jwt.verify(handmade({ alg: 'HS256' }, { iss: 'soda', aud: ['cli', 'web'] }))).toMatchObject({ iss: 'soda' })
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256' }, { aud: 'api' })))).toBe('claims: Token issuer is not "soda"')
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256' }, { iss: 'soda', aud: 'cli' })))).toBe(
      'claims: Token audience is not "web" or "api"'
    )
    expect(await refusal(jwt.verify(handmade({ alg: 'HS256' }, { iss: 'soda' })))).toBe('claims: Token audience is not "web" or "api"')
  })

  it('refuses inconsistent options', async () => {
    const options: readonly [JwtOptions, string][] = [
      [{}, 'HS256 takes a non-empty secret, not keys'],
      [{ secret: '' }, 'HS256 takes a non-empty secret, not keys'],
      [{ secret: SECRET, publicKey: 'x' }, 'HS256 takes a non-empty secret, not keys'],
      [{ algorithm: 'RS256', secret: SECRET }, 'RS256 takes privateKey to sign and publicKey to verify, not a secret'],
      [{ algorithm: 'RS256' }, 'RS256 takes privateKey to sign and publicKey to verify, not a secret'],
      [{ algorithm: 'none' as JwtAlgorithm, secret: SECRET }, 'Unsupported JWT algorithm: none'],
    ]

    for (const [option, message] of options) {
      expect(() => new JwtService(option)).toThrow(message)
    }

    const keys = await keyPair({ name: 'Ed25519' })

    await expect(new JwtService({ algorithm: 'EdDSA', publicKey: keys.publicPem }).sign({})).rejects.toThrow('EdDSA needs privateKey to sign')
    await expect(new JwtService({ algorithm: 'EdDSA', privateKey: keys.publicPem }).sign({})).rejects.toThrow(
      'A EdDSA key must be a CryptoKey, a JWK or a PEM string: a PKCS #8 "PRIVATE KEY" to sign'
    )
  })
})
