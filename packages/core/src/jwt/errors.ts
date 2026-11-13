/**
 * @module
 * Why a token was refused.
 */

export type JwtErrorCode =
  /** Not three base64url parts holding JSON objects. */
  | 'malformed'
  /** Signed with another algorithm than the one configured, or with critical extensions. */
  | 'algorithm'
  /** The signature does not match. */
  | 'signature'
  /** `exp` is past. */
  | 'expired'
  /** `nbf` is still to come. */
  | 'not-active'
  /** A registered claim has the wrong type, or `iss` or `aud` is not the expected one. */
  | 'claims'

/** A token that `JwtService.verify()` refused. */
export class JwtError extends Error {
  override readonly name = 'JwtError'

  constructor(
    readonly code: JwtErrorCode,
    message: string
  ) {
    super(message)
  }
}
