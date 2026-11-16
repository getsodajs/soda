# WebSockets

A gateway serves WebSocket connections on a path, with Bun's native WebSockets and their pub/sub. List it in the `controllers` of a module, like a controller.

```ts
import { data, socket, SubscribeMessage, WebSocketGateway } from '@getsoda/core'
import type { GatewaySocket, OnGatewayConnection, OnGatewayDisconnect } from '@getsoda/core'

const Say = z.object({ text: z.string().min(1).max(500) })

@WebSocketGateway('/chat')
@UseGuards(JwtGuard)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  handleConnection(client: GatewaySocket) {
    client.subscribe('lobby')
  }

  handleDisconnect(client: GatewaySocket, code: number) {}

  @SubscribeMessage('say', [data(Say), value(JWT_PAYLOAD), socket()])
  say(message: z.infer<typeof Say>, user: JwtPayload, client: GatewaySocket) {
    client.publish('lobby', JSON.stringify({ event: 'said', data: { user: user.sub, text: message.text } }))

    return { event: 'sent', data: null } // sent back to this client
  }
}
```

## Protocol

Frames are JSON text, as with Nest's `WsAdapter`:

```json
{ "event": "say", "data": { "text": "hello" } }
```

- What a handler returns, unless `undefined`, is sent back to the client as JSON.
- Frames that are not such JSON, binary frames, and events no handler subscribes to are dropped silently: anyone can send them.
- A handler that fails is answered with an `exception` event, as Nest's `BaseWsExceptionFilter` does. An `HttpException` sends its body; any other error is logged and sent as a bare `500`:

```json
{ "event": "exception", "data": { "statusCode": 400, "message": ["text: Too small: ..."], "error": "Bad Request", "event": "say" } }
```

The connection stays open after an error.

```ts
const ws = new WebSocket('ws://localhost:3000/chat')

ws.onmessage = (frame) => {
  const { event, data } = JSON.parse(frame.data)
}
ws.onopen = () => ws.send(JSON.stringify({ event: 'say', data: { text: 'hello' } }))
```

## Arguments

As on routes, `@SubscribeMessage(event, [...])` lists what the method receives:

| Argument | Value | Nest |
|---|---|---|
| `data(schema?)` | the `data` of the frame, validated: an invalid one is an `exception` event, status `400` | `@MessageBody()` |
| `socket()` | the connection | `@ConnectedSocket()` |
| `value(key)` | what the guards of the handshake attached | |
| `query(name)`, `header(name)`, `cookie(name)` | values of the handshake request | |
| `context()` | the context of the handshake | |

Without argument list, the method receives `(data, socket)`. `body()`, `form()` and `param()` have no meaning in a message: a gateway using them does not start.

## Guards

The guards of the gateway class, and global guards, run on the handshake: a refused handshake is answered over HTTP (`401`, `403`) and the connection is never opened. Browsers send cookies with the handshake, so `JwtGuard` with the `cookie` option protects a gateway; a non-browser client can send `Authorization`.

The guards of a method run on each of its messages, with the context of the handshake, so what the handshake guards attached is there:

```ts
@SubscribeMessage('kick', [data(Kick)])
@UseGuards(adminOnly) // (ctx) => ctx.get(USER).role === 'admin'
kick(input: Kick) {}
```

A refused message is answered with an `exception` event, status `403`. In Nest, class guards run on each message and nothing runs on the handshake; here a connection that should not exist is not opened.

Interceptors and exception filters apply to routes, not to message handlers: a handler with them does not start.

## Rooms and broadcasting

`GatewaySocket` is Bun's `ServerWebSocket`:

```ts
client.subscribe('room:42')
client.publish('room:42', JSON.stringify({ event: 'joined', data: user.sub })) // everyone in the room but this client
client.unsubscribe('room:42')
client.send(JSON.stringify({ event: 'welcome', data: null }))
client.close(1000, 'bye')
```

To send from outside a gateway (a service reacting to an event), use the server: `app.server!.publish('room:42', message)`.

## Limits

```ts
await app.listen({ port: 3000, websocket: { maxPayloadLength: 64 * 1024, idleTimeout: 60 } })
```

| Option | Bun's default | |
|---|---|---|
| `maxPayloadLength` | 16 MiB | a bigger frame closes the connection with `1009` |
| `idleTimeout` | 120 s | a connection without traffic is closed |
| `backpressureLimit` | 16 MiB | buffered bytes before sends are dropped |
| `sendPings` | `true` | pings keep the connection alive |
| `perMessageDeflate` | `false` | compression |

Lower `maxPayloadLength` to what your messages need: a client can make the server hold that much per frame.

## Shutdown

When the application closes, every connection is closed with code `1001` before services are destroyed, and `handleDisconnect` runs for each.
