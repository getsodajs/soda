/**
 * @module
 * JWS algorithms (RFC 7518) on WebCrypto, and the keys they take.
 */

import type { webcrypto } from 'node:crypto'

/** Algorithms a token can be signed with. `none` is not one of them. */
export type JwtAlgorithm =
  | 'HS256'
  | 'HS384'
  | 'HS512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA'

/**
 * A key: a `CryptoKey`, a JWK, a PEM string (`PRIVATE KEY` in PKCS #8 or
 * `PUBLIC KEY` in SPKI), or the secret of an HMAC algorithm.
 */
export type JwtKey = CryptoKey | webcrypto.JsonWebKey | string

type KeyParams = webcrypto.HmacImportParams | webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams | webcrypto.Algorithm
type SignParams = webcrypto.Algorithm | webcrypto.EcdsaParams | webcrypto.RsaPssParams

/** Import parameters, and the signing parameters where they differ. */
const ALGORITHMS: Readonly<Record<JwtAlgorithm, { readonly key: KeyParams; readonly sign: SignParams }>> = {
  HS256: hmac('SHA-256'),
  HS384: hmac('SHA-384'),
  HS512: hmac('SHA-512'),
  RS256: rsa('RSASSA-PKCS1-v1_5', 'SHA-256'),
  RS384: rsa('RSASSA-PKCS1-v1_5', 'SHA-384'),
  RS512: rsa('RSASSA-PKCS1-v1_5', 'SHA-512'),
  PS256: pss('SHA-256', 32),
  PS384: pss('SHA-384', 48),
  PS512: pss('SHA-512', 64),
  ES256: ecdsa('P-256', 'SHA-256'),
  ES384: ecdsa('P-384', 'SHA-384'),
  ES512: ecdsa('P-521', 'SHA-512'),
  EdDSA: { key: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
}

function hmac(hash: string) {
  const params = { name: 'HMAC', hash }

  return { key: params, sign: params }
}

function rsa(name: string, hash: string) {
  return { key: { name, hash }, sign: { name } }
}

function pss(hash: string, saltLength: number) {
  return { key: { name: 'RSA-PSS', hash }, sign: { name: 'RSA-PSS', saltLength } }
}

function ecdsa(namedCurve: string, hash: string) {
  return { key: { name: 'ECDSA', namedCurve }, sign: { name: 'ECDSA', hash } }
}

export const isJwtAlgorithm = (value: unknown): value is JwtAlgorithm => typeof value === 'string' && Object.hasOwn(ALGORITHMS, value)

export const isHmac = (algorithm: JwtAlgorithm): boolean => algorithm.startsWith('HS')

const pemBody = (pem: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.fromBase64(pem.replace(/-----(?:BEGIN|END) [A-Z ]+-----/g, '').replace(/\s/g, ''))

/** Imports `key` once for `usage` with `algorithm`. */
export const importKey = async (key: JwtKey, algorithm: JwtAlgorithm, usage: 'sign' | 'verify'): Promise<CryptoKey> => {
  const params = ALGORITHMS[algorithm].key

  if (key instanceof CryptoKey) {
    return key
  }

  if (typeof key === 'object') {
    return crypto.subtle.importKey('jwk', key, params, false, [usage])
  }

  if (isHmac(algorithm)) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(key), params, false, [usage])
  }

  if (key.includes('-----BEGIN PRIVATE KEY-----') && usage === 'sign') {
    return crypto.subtle.importKey('pkcs8', pemBody(key), params, false, [usage])
  }

  if (key.includes('-----BEGIN PUBLIC KEY-----') && usage === 'verify') {
    return crypto.subtle.importKey('spki', pemBody(key), params, false, [usage])
  }

  throw new TypeError(
    `A ${algorithm} key must be a CryptoKey, a JWK or a PEM string: ` +
      (usage === 'sign' ? 'a PKCS #8 "PRIVATE KEY" to sign' : 'an SPKI "PUBLIC KEY" to verify')
  )
}

export const signBytes = async (algorithm: JwtAlgorithm, key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.sign(ALGORITHMS[algorithm].sign, key, data))

export const verifyBytes = (
  algorithm: JwtAlgorithm,
  key: CryptoKey,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>
): Promise<boolean> => crypto.subtle.verify(ALGORITHMS[algorithm].sign, key, signature, data)
