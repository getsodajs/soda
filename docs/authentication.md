# Authentication

## JWT

`@getsoda/core/jwt` signs and verifies JSON Web Tokens with WebCrypto, without dependencies: HS256/384/512, RS, PS, ES and EdDSA; keys as secrets, PEM, JWK or `CryptoKey`. The algorithm comes from the options, never from the token, so `alg: none` and algorithm confusion are refused; the signature is checked before any claim is read.

```ts
import { JwtModule } from '@getsoda/core/jwt'

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config) => ({ secret: config.JWT_SECRET, expiresIn: 15 * 60, cookie: 'token' }),
      global: true,
    }),
  ],
})
export class AuthModule {}
```

`JwtModule.register(options)` takes the options directly. `expiresIn` is in seconds.

### Signing in

```ts
const Login = z.object({ email: z.email(), password: z.string() })

@Controller('auth')
export class AuthController {
  readonly #jwt = inject(JwtService)
  readonly #users = inject(UsersService)

  @Post('login', [body(Login), context()])
  async login(input: z.infer<typeof Login>, ctx: Context) {
    const user = await this.#users.verify(input.email, input.password) // throws UnauthorizedException

    const token = await this.#jwt.sign({ sub: String(user.id) })

    // For browsers: a cookie scripts cannot read. API clients use the returned token.
    ctx.cookies.set('token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 15 * 60 })

    return { token }
  }

  @Post('logout', [context()])
  @HttpCode(204)
  logout(ctx: Context) {
    ctx.cookies.delete('token')
  }
}
```

For passwords, `Bun.password.hash()` and `Bun.password.verify()` (argon2id) are built in.

### Protecting routes

`JwtGuard` reads the token from `Authorization: Bearer <token>`, or from the cookie named by the `cookie` option when the header is absent. A valid token lets the request in and puts its payload under `JWT_PAYLOAD`; anything else is a `401` with the `WWW-Authenticate` challenge of RFC 6750.

```ts
@Get('me', [value(JWT_PAYLOAD)])
@UseGuards(JwtGuard)
me(payload: JwtPayload) {
  return { id: payload.sub }
}
```

To protect everything but a few routes, make the guard global and skip it with metadata:

```ts
export const Public = createDecorator<true>('Public')

export class AuthGuard implements CanActivate {
  readonly #jwt = new JwtGuard()

  canActivate(ctx: Context) {
    return ctx.metadata(Public) === true || this.#jwt.canActivate(ctx)
  }
}

await createApp(AppModule, { guards: [AuthGuard] })

@Post('login')
@Public(true)
login() {}
```

### The current user

A guard after `JwtGuard` can load the user once and attach it:

```ts
export const USER = new ContextKey<User>('user')

export class CurrentUserGuard implements CanActivate {
  readonly #users = inject(UsersService)

  async canActivate(ctx: Context) {
    ctx.set(USER, await this.#users.findOrFail(ctx.get(JWT_PAYLOAD).sub!))

    return true
  }
}

@Get('me', [value(USER)])
@UseGuards(JwtGuard, CurrentUserGuard)
me(user: User) {}
```

### Without the module

`new JwtService({ secret })` signs and verifies anywhere: in a script, a worker, a test.

## Cookies

`ctx.cookies` is Bun's `CookieMap` for the request: what you set or delete is sent with the response as `Set-Cookie`, whatever the response is. `cookie(name)` in an argument list reads one.

```ts
ctx.cookies.set('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
ctx.cookies.delete('theme')
```

For a session cookie: `httpOnly` (scripts cannot read it), `secure` (HTTPS only), `sameSite: 'strict'` or `'lax'` (not sent from other sites), and a name starting with `__Host-`, which browsers refuse from subdomains and over HTTP.

### Signed cookies

A signed cookie can be read by the client but not changed: the signature is an HMAC of the value.

```ts
const signer = new CookieSigner(process.env.COOKIE_SECRET!) // or [current, previous] to rotate keys

ctx.cookies.set('session', signer.sign('user-1'), { httpOnly: true, secure: true })

@Get('me', [cookie('session', signed(signer))])            // 400 when missing or forged
me(userId: string) {}

@Get('home', [cookie('session', signed(signer).optional())]) // undefined when missing or forged
home(userId: string | undefined) {}
```

With a list of secrets, cookies are signed with the first and accepted with any: add a new secret first, remove the old one once its cookies have expired.

## WebSockets

Browsers send cookies with the WebSocket handshake but cannot set an `Authorization` header there: a gateway is protected by `JwtGuard` reading the cookie. See [WebSockets](./websockets.md#guards).
