/** Cookie holding the token for browsers; `JwtGuard` reads it when there is no `Authorization` header. */
export const TOKEN_COOKIE = 'token'

/** Lifetime of a token, in seconds. */
export const TOKEN_LIFETIME = 60 * 60
