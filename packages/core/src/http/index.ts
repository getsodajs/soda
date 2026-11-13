/**
 * @module
 * HTTP layer for Soda: controllers, route decorators, request context, validation, exceptions.
 */

export { body, context, cookie, form, header, param, query, value } from './arguments.ts'
export type { Argument, ArgumentFor, ArgumentKind, ArgumentValues } from './arguments.ts'
export { Context } from './context.ts'
export { CookieSigner, signed } from './cookies.ts'
export { ContextKey } from './context-key.ts'
export type { ContextParams, ParamNameOf } from './context.ts'
export { All, Controller, Delete, Get, Head, Header, HttpCode, Options, Patch, Post, Put, Route } from './decorators.ts'
export type {
  ArgumentsRouteDecorator,
  MethodMetadataDecorator,
  MethodRouteDecoratorFactory,
  RouteDecorator,
  RouteDecoratorFactory,
  RouteHandlerHint,
  RouteHandlerMethod,
} from './decorators.ts'
export { ControllerError } from './errors.ts'
export type { ControllerErrorCode } from './errors.ts'
export {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from './exceptions.ts'
export type { HttpExceptionBody, HttpExceptionOptions } from './exceptions.ts'
export { boolean, int, number, uuid } from './parsers.ts'
export type { Parsed, Parser, ParserOptions, ValueParser } from './parsers.ts'
export { buildRoutes, controllerRoutes } from './routes.ts'
export type { BuiltRoutes, ControllerRoutesOptions, MappedController } from './routes.ts'
export type { InferOutput, StandardSchemaV1 } from './schema.ts'
export type { AnyParams, PathParams } from './types.ts'
export { Catch, createDecorator, UseFilters, UseGuards, UseInterceptors } from './enhancers.ts'
export type {
  CallHandler,
  CanActivate,
  ClassOrMethodDecorator,
  Enhancers,
  ExceptionFilter,
  FilterFunction,
  FilterLike,
  Guard,
  GuardFunction,
  Interceptor,
  InterceptorFunction,
  InterceptorLike,
  MetadataDecorator,
} from './enhancers.ts'
export type { RouteInfo } from './context.ts'
export { cors } from './cors.ts'
export type { CorsOptions } from './cors.ts'
export type { Middleware, MiddlewareFunction, NestMiddleware, Next } from './middleware.ts'
export type { FormFields, FormLimits, FormValue } from './body.ts'
