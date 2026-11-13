/**
 * @module
 * Turns what a handler returns into a `Response`.
 *
 * Same rules as Nest's response controller, for the Fetch API:
 *
 * - a `Response` is sent as is;
 * - `undefined` and `null` give an empty body;
 * - a string is sent as `text/plain`;
 * - binary data and streams are sent as they are;
 * - anything else is serialized as JSON.
 *
 * Statuses without a body (`204`, `205`, `304`, Fetch "null body status") never
 * get one: `new Response(body, { status: 204 })` would throw.
 */

const NULL_BODY_STATUSES = new Set([204, 205, 304])
const TEXT = 'text/plain;charset=utf-8'

const isBinary = (value: unknown): value is Bun.BodyInit =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob || value instanceof ReadableStream

/**
 * Creates the function building responses of one route. The response
 * options are computed once here, not per request.
 */
export const createResponder = (status: number, headers: readonly [string, string][]): ((value: unknown) => Response) => {
  let hasContentType = false

  for (let i = 0, len = headers.length; i < len; i++) {
    if (headers[i]![0].toLowerCase() === 'content-type') {
      hasContentType = true
    }
  }

  // A content type from @Header() replaces the default one instead of being appended to it.
  const plain: ResponseInit = { status, headers: [...headers] }
  const text: ResponseInit = hasContentType ? plain : { status, headers: [['content-type', TEXT], ...headers] }

  if (NULL_BODY_STATUSES.has(status)) {
    return (value) => (value instanceof Response ? value : new Response(null, plain))
  }

  return (value) => {
    if (value instanceof Response) {
      return value
    }

    if (value === undefined || value === null) {
      return new Response(null, plain)
    }

    if (typeof value === 'string') {
      return new Response(value, text)
    }

    if (isBinary(value)) {
      return new Response(value, plain)
    }

    return Response.json(value, plain)
  }
}
