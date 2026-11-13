/**
 * @module
 * Hot reload support for `bun --hot`.
 *
 * Under `--hot`, Bun re-evaluates the changed modules in the same process:
 * `globalThis` survives, a second `Bun.serve()` on the same port reuses the
 * running server instead of failing, and there is no hook telling the old
 * module it is unloaded (`import.meta.hot` does not exist on the server).
 * So the previous application, with its timers and connections, would stay
 * alive forever.
 *
 * Applications that listen are registered here by port, in `globalThis`; a new
 * application listening on a port takes it over and destroys the previous one
 * without stopping the server they share. Without `--hot`, two applications
 * cannot listen on the same port, so this never happens.
 *
 * Requests the old version is still serving at that moment may meet its
 * destroyed services: a development-only window, as with any hot reload.
 */

/** What the registry needs from an application. */
export interface HotApp {
  /** Destroys the application without stopping its server. */
  handOver(): Promise<void>
}

const REGISTRY = Symbol.for('soda.app.listening')

const registry = (): Map<number, HotApp> => {
  const holder = globalThis as typeof globalThis & { [REGISTRY]?: Map<number, HotApp> }

  holder[REGISTRY] ??= new Map()

  return holder[REGISTRY]
}

/**
 * Registers `app` as listening on `port`, destroying the application that listened there before.
 */
export const takeOver = async (port: number, app: HotApp): Promise<void> => {
  const apps = registry()
  const previous = apps.get(port)

  apps.set(port, app)

  if (previous !== undefined && previous !== app) {
    await previous.handOver()
  }
}

/**
 * Unregisters `app` from `port`, unless another application already took it over.
 */
export const release = (port: number, app: HotApp): void => {
  const apps = registry()

  if (apps.get(port) === app) {
    apps.delete(port)
  }
}
