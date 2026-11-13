/**
 * @module
 * HTTP exceptions: thrown anywhere in a handler, turned into an error response.
 *
 * Same contract as Nest: the body is `{ statusCode, message, error }`, or the
 * object given to the exception; any other thrown value becomes a
 * `500 Internal server error` whose details never reach the client.
 *
 * ```ts
 * throw new NotFoundException(`User ${id} not found`)
 * // 404 { "statusCode": 404, "message": "User 7 not found", "error": "Not Found" }
 * ```
 */

/**
 * Body of an error response built from a message.
 */
export interface HttpExceptionBody {
  readonly statusCode: number
  readonly message: string | readonly string[]
  readonly error?: string
}

/**
 * Options of an `HttpException`.
 */
export interface HttpExceptionOptions {
  /** Original error, kept for logs, never sent. */
  readonly cause?: unknown
  /** Response headers, e.g. `WWW-Authenticate` for a 401. */
  readonly headers?: ResponseInit['headers']
}

/**
 * Exception with an HTTP status and a response body.
 *
 * `response` is either a message (or a list of messages, as validation errors
 * are), wrapped into `{ statusCode, message, error }`, or an object sent as is.
 */
export class HttpException extends Error {
  readonly status: number
  readonly response: HttpExceptionBody | Readonly<Record<string, unknown>>
  readonly headers: ResponseInit['headers']

  constructor(
    response: string | readonly string[] | Readonly<Record<string, unknown>>,
    status: number,
    options: HttpExceptionOptions & { readonly error?: string } = {}
  ) {
    const body =
      typeof response === 'string' || Array.isArray(response)
        ? { statusCode: status, message: response as string | readonly string[], error: options.error }
        : (response as Readonly<Record<string, unknown>>)

    super(typeof body.message === 'string' ? body.message : (options.error ?? `HTTP ${status}`), { cause: options.cause })
    this.name = new.target.name
    this.status = status
    this.response = body
    this.headers = options.headers
  }
}

/**
 * Declares an exception class for one status, as Nest's `BadRequestException` and friends.
 */
const exceptionFor = (status: number, error: string) =>
  class extends HttpException {
    constructor(message: string | readonly string[] = error, options: HttpExceptionOptions = {}) {
      super(message, status, { ...options, error })
    }
  }

export class BadRequestException extends exceptionFor(400, 'Bad Request') {}

export class UnauthorizedException extends exceptionFor(401, 'Unauthorized') {}

export class ForbiddenException extends exceptionFor(403, 'Forbidden') {}

export class NotFoundException extends exceptionFor(404, 'Not Found') {}

export class ConflictException extends exceptionFor(409, 'Conflict') {}

export class PayloadTooLargeException extends exceptionFor(413, 'Payload Too Large') {}

export class UnsupportedMediaTypeException extends exceptionFor(415, 'Unsupported Media Type') {}

export class UnprocessableEntityException extends exceptionFor(422, 'Unprocessable Entity') {}

export class TooManyRequestsException extends exceptionFor(429, 'Too Many Requests') {}

export class InternalServerErrorException extends exceptionFor(500, 'Internal Server Error') {}

export class ServiceUnavailableException extends exceptionFor(503, 'Service Unavailable') {}

const INTERNAL_ERROR_BODY = { statusCode: 500, message: 'Internal server error' }

/**
 * Response for a thrown value: the exception's own response for an `HttpException`,
 * a generic 500 for anything else, reported through `onUnknown` (logs).
 */
export const errorResponse = (error: unknown, onUnknown: (error: unknown) => void): Response => {
  if (error instanceof HttpException) {
    return Response.json(error.response, { status: error.status, headers: error.headers })
  }

  onUnknown(error)

  return Response.json(INTERNAL_ERROR_BODY, { status: 500 })
}
