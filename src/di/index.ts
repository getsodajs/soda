/**
 * @module
 * Dependency injection for Soda.
 */

export { createContainer } from './container.ts'
export type { Container, ContainerOptions, ControllerEntry, ResolveOptions } from './container.ts'
export { inject } from './context.ts'
export type { InjectOptions } from './context.ts'
export { Injectable, Module } from './decorators.ts'
export type { DynamicModule, InjectableOptions, ModuleClass, ModuleDefinition, ModuleImport } from './decorators.ts'
export { DiError } from './errors.ts'
export type { DiErrorCode } from './errors.ts'
export type { OnDestroy, OnInit } from './lifecycle.ts'
export { optional, provide } from './provider.ts'
export type { Dependency, DependencyValues, OptionalDependency, Provider, Scope } from './provider.ts'
export { InjectionToken } from './token.ts'
export type { ClassToken, Constructor, Token, TokenValue } from './token.ts'
