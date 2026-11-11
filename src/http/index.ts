/**
 * @module
 * HTTP layer for Soda: controllers, route decorators, request context, validation, exceptions.
 */

export { body, context, header, param, query } from './arguments'
export type { Argument, ArgumentFor, ArgumentKind, ArgumentValues } from './arguments'
export { Context } from './context'
export type { ContextParams, ParamNameOf } from './context'
export { All, Controller, Delete, Get, Head, Header, HttpCode, Options, Patch, Post, Put, Route } from './decorators'
export type {
  ArgumentsRouteDecorator,
  MethodMetadataDecorator,
  MethodRouteDecoratorFactory,
  RouteDecorator,
  RouteDecoratorFactory,
  RouteHandlerMethod,
} from './decorators'
export { ControllerError } from './errors'
export type { ControllerErrorCode } from './errors'
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
} from './exceptions'
export type { HttpExceptionBody, HttpExceptionOptions } from './exceptions'
export { boolean, int, number, uuid } from './parsers'
export type { Parsed, Parser, ParserOptions, ValueParser } from './parsers'
export { buildRoutes, controllerRoutes } from './routes'
export type { BuiltRoutes, ControllerRoutesOptions } from './routes'
export type { InferOutput, StandardSchemaV1 } from './schema'
export type { AnyParams, PathParams } from './types'
export { Catch, createDecorator, UseFilters, UseGuards, UseInterceptors } from './enhancers'
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
} from './enhancers'
export type { RouteInfo } from './context'
