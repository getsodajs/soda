/**
 * @module
 * Percent-decoding that is byte-for-byte compatible with the decoding Bun
 * applies to native route parameters (`req.params`).
 *
 * `decodeURIComponent` throws on malformed input and `TextDecoder` replaces
 * invalid UTF-8 differently, so neither can be used: a value computed by the
 * compiler must never differ from the value Bun would have produced.
 *
 * ```ts
 * '%41'        => 'A'
 * 'a%zzb'      => 'a�b'   // malformed escape: '%' plus two characters
 * 'a%z'        => 'a�z'   // malformed escape at the end: '%' only
 * '%E2%9C'     => '�'     // truncated sequence: one replacement
 * '%ED%A0%80'  => '�'     // surrogate: one replacement for the whole sequence
 * '%C0%AF'     => '�'     // overlong: one replacement for the whole sequence
 * '%F8%80'     => '��' // invalid lead byte and lone continuation byte
 * ```
 */

const REPLACEMENT = '�'
const PERCENT = 0x25

/** Smallest code point allowed for a sequence of the given length (rejects overlong forms). */
const MIN_CODE_POINT = [0, 0, 0x80, 0x800, 0x10000] as const

const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30
  }

  const lower = code | 0x20

  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1
}

/** Byte encoded by a valid `%XX` escape at `index`, or `-1`. */
const byteAt = (value: string, index: number): number => {
  if (value.charCodeAt(index) !== PERCENT) {
    return -1
  }

  const high = hexValue(value.charCodeAt(index + 1))
  const low = hexValue(value.charCodeAt(index + 2))

  return high === -1 || low === -1 ? -1 : (high << 4) | low
}

/** Length of the UTF-8 sequence started by `lead`, or `0` if `lead` cannot start one. */
const sequenceLength = (lead: number): number => {
  if (lead >= 0xc0 && lead <= 0xdf) {
    return 2
  }

  if (lead >= 0xe0 && lead <= 0xef) {
    return 3
  }

  return lead >= 0xf0 && lead <= 0xf7 ? 4 : 0
}

/**
 * Decodes a percent-encoded URL component the way Bun decodes route parameters.
 */
export const decodeComponent = (value: string): string => {
  const first = value.indexOf('%')

  if (first === -1) {
    return value
  }

  const length = value.length
  let result = value.slice(0, first)

  // Each iteration consumes a whole unit (literal run, escape or UTF-8 sequence) and sets `next`.
  for (let index = first, next = first; index < length; index = next) {
    if (value.charCodeAt(index) !== PERCENT) {
      next = value.indexOf('%', index)

      if (next === -1) {
        next = length
      }

      result += value.slice(index, next)
      continue
    }

    const lead = byteAt(value, index)

    if (lead === -1) {
      // '%zz' => one replacement for three characters, a trailing '%z' => for '%' only
      next = index + (index + 2 < length ? 3 : 1)
      result += REPLACEMENT
      continue
    }

    next = index + 3

    if (lead < 0x80) {
      result += String.fromCharCode(lead)
      continue
    }

    const size = sequenceLength(lead)

    if (size === 0) {
      result += REPLACEMENT
      continue
    }

    let codePoint = lead & (0xff >> (size + 1))
    let read = 1

    // Continuation bytes (0x80-0xBF), up to the length announced by the lead byte.
    for (let byte = byteAt(value, next); read < size && byte >= 0x80 && byte <= 0xbf; byte = byteAt(value, next)) {
      codePoint = (codePoint << 6) | (byte & 0x3f)
      next += 3
      read++
    }

    if (
      read < size ||
      codePoint < MIN_CODE_POINT[size as 2 | 3 | 4] ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      result += REPLACEMENT
    } else {
      result += String.fromCodePoint(codePoint)
    }
  }

  return result
}
