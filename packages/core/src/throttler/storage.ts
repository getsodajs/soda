/**
 * @module
 * Where the throttler counts requests: in memory by default, or anywhere a
 * `ThrottlerStorage` puts it (Redis, for several instances of the application).
 */

import type { OnDestroy } from '../di/index.ts'

/** The count of one key after a request, as `@nestjs/throttler`'s `ThrottlerStorageRecord`. */
export interface ThrottlerRecord {
  /** Requests in the current window, this one included. */
  readonly totalHits: number
  /** Milliseconds until the window ends and the count starts over. */
  readonly timeToExpire: number
  readonly isBlocked: boolean
  /** Milliseconds until the key is let in again; `0` when it is not blocked. */
  readonly timeToBlockExpire: number
}

/**
 * Counts the requests of a key in windows of `ttl` milliseconds. Past `limit`
 * in a window, the key is blocked for `blockDuration` milliseconds.
 */
export interface ThrottlerStorage {
  increment(key: string, ttl: number, limit: number, blockDuration: number): ThrottlerRecord | Promise<ThrottlerRecord>
}

interface Entry {
  hits: number
  expiresAt: number
  blockedUntil: number
}

/** The window of an entry is over, or its block when it has one. */
const hasEnded = (entry: Entry, now: number): boolean => (entry.blockedUntil === 0 ? entry.expiresAt : entry.blockedUntil) <= now

/** How often expired keys are dropped, in milliseconds. */
const SWEEP_INTERVAL = 60_000

/**
 * Storage in the memory of this process: right for one instance. Expired keys
 * are dropped every minute, so memory follows the active clients, not every
 * client ever seen; the timer never keeps the process alive.
 */
export class MemoryThrottlerStorage implements ThrottlerStorage, OnDestroy {
  readonly #entries = new Map<string, Entry>()
  readonly #sweeper: Timer

  constructor() {
    this.#sweeper = setInterval(() => this.#sweep(Date.now()), SWEEP_INTERVAL)
    this.#sweeper.unref()
  }

  /** Keys being counted or blocked. */
  get size(): number {
    return this.#entries.size
  }

  increment(key: string, ttl: number, limit: number, blockDuration: number): ThrottlerRecord {
    const now = Date.now()
    let entry = this.#entries.get(key)

    // A block outlasts the window it started in: the count starts over once it ends.
    if (entry === undefined || hasEnded(entry, now)) {
      entry = { hits: 0, expiresAt: now + ttl, blockedUntil: 0 }
      this.#entries.set(key, entry)
    }

    if (entry.blockedUntil > now) {
      return { totalHits: entry.hits, timeToExpire: Math.max(0, entry.expiresAt - now), isBlocked: true, timeToBlockExpire: entry.blockedUntil - now }
    }

    entry.hits++

    if (entry.hits > limit) {
      entry.blockedUntil = now + blockDuration

      return { totalHits: entry.hits, timeToExpire: entry.expiresAt - now, isBlocked: true, timeToBlockExpire: blockDuration }
    }

    return { totalHits: entry.hits, timeToExpire: entry.expiresAt - now, isBlocked: false, timeToBlockExpire: 0 }
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (hasEnded(entry, now)) {
        this.#entries.delete(key)
      }
    }
  }

  onDestroy(): void {
    clearInterval(this.#sweeper)
  }
}
