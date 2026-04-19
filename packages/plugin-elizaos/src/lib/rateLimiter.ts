import {
  MAX_TRACKED_CUSTOMERS,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from '../constants';

export interface RateLimiterOptions {
  windowMs?: number;
  maxPerWindow?: number;
  maxTrackedKeys?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Wall-clock timestamp (ms) when the limit window will reset for this key. */
  resetAt: number;
  /** Number of hits inside the current window after this call (or attempted hit if denied). */
  count: number;
}

interface Entry {
  /** Sliding-window timestamps in ms. Sorted ascending. */
  hits: number[];
}

/**
 * Bounded sliding-window rate limiter keyed by customer pubkey.
 *
 * Each key gets at most `maxPerWindow` requests inside a rolling
 * `windowMs`. Stale timestamps are GC'd lazily on every `check`. When the
 * tracked-key set grows past `maxTrackedKeys`, the least-recently-used
 * key is evicted to bound memory under attack.
 *
 * Thread-safety: not required - the plugin is single-threaded, all calls
 * happen on the JS event loop.
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly maxTrackedKeys: number;
  // LRU is implemented via Map's insertion-order: every check refreshes
  // the entry by deleting and re-setting it, moving it to the tail.
  private readonly entries = new Map<string, Entry>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.maxPerWindow = options.maxPerWindow ?? RATE_LIMIT_MAX_PER_WINDOW;
    this.maxTrackedKeys = options.maxTrackedKeys ?? MAX_TRACKED_CUSTOMERS;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const entry = this.entries.get(key) ?? { hits: [] };
    const cutoff = now - this.windowMs;
    const fresh = entry.hits.filter((ts) => ts > cutoff);

    if (fresh.length >= this.maxPerWindow) {
      // Refresh LRU order even on denial so an attacker hammering the
      // same key cannot push other tracked keys out via eviction.
      this.entries.delete(key);
      this.entries.set(key, { hits: fresh });
      return {
        allowed: false,
        resetAt: (fresh[0] ?? now) + this.windowMs,
        count: fresh.length,
      };
    }
    fresh.push(now);
    this.entries.delete(key);
    this.entries.set(key, { hits: fresh });
    this.evictIfNeeded();
    return {
      allowed: true,
      resetAt: (fresh[0] ?? now) + this.windowMs,
      count: fresh.length,
    };
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxTrackedKeys) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }

  size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
  }
}
