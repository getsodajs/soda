import { expect, it } from 'bun:test'
import { param } from './arguments.ts'
import type { Context } from './context.ts'
import { Controller, Get } from './decorators.ts'

// Checked by the type checker: each @ts-expect-error must stay an error.
@Controller('teams/:team')
class Handlers {
  // A parameter of the controller path is a string, in a list and in the context.
  @Get(':token', [param('team'), param('token')])
  controllerParam(team: string, token: string) {
    return [team, token]
  }

  @Get(':token')
  controllerParamInContext(ctx: Context) {
    return [ctx.param('team'), ctx.param('token')]
  }

  @Get(':token')
  context(ctx: Context<':token'>) {
    return ctx.param('token')
  }

  @Get(':token')
  anyContext(ctx: Context) {
    return ctx.url
  }

  @Get()
  nothing() {
    return null
  }

  // A parameter the path requires is a string; an optional one may be undefined.
  @Get(':token/:page?', [param('token'), param('page')])
  listed(token: string, page: string | undefined) {
    return [token, page]
  }

  // @ts-expect-error An optional parameter may be missing.
  @Get(':token/:page?', [param('page')])
  optional(page: string) {
    return page
  }

  // A value without an argument list: the error explains how to receive it.
  // @ts-expect-error Without an argument list, the method receives the context: (ctx: Context<':token'>)...
  @Get(':token')
  value(token: string) {
    return token
  }

  // @ts-expect-error The context of another path.
  @Get(':id')
  otherPath(ctx: Context<':other'>) {
    return ctx
  }
}

it('accepts the handler signatures a route allows', () => {
  expect(new Handlers().nothing()).toBeNull()
})
