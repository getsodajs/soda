/**
 * @module
 * Dependency injection for Soda.
 */

export { createContainer } from './container'
export type { Container, ContainerOptions, ControllerEntry, ResolveOptions } from './container'
export { inject } from './context'
export type { InjectOptions } from './context'
export { Injectable, Module } from './decorators'
export type { DynamicModule, InjectableOptions, ModuleClass, ModuleDefinition, ModuleImport } from './decorators'
export { DiError } from './errors'
export type { DiErrorCode } from './errors'
export type { OnDestroy, OnInit } from './lifecycle'
export { optional, provide } from './provider'
export type { Dependency, DependencyValues, OptionalDependency, Provider, Scope } from './provider'
export { InjectionToken } from './token'
export type { ClassToken, Constructor, Token, TokenValue } from './token'
