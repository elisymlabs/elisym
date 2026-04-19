/**
 * Sliding-window rate limiter keyed by an arbitrary string (typically a
 * customer pubkey). Each key gets at most `maxPerWindow` requests inside a
 * rolling `windowMs`. Stale timestamps are pruned lazily on every `check`.
 * When the tracked-key set grows past `maxKeys`, the least-recently-used
 * key is evicted so an attacker cannot exhaust memory by cycling keys.
 *
 * Thread-safety: not required. Designed for single-threaded JS consumers
 * (Node/Bun event loops, browser main thread). No timers - pruning happens
 * inside `check` and `prune`.
 */

export interface SlidingWindowLimiterOptions {
  /** Rolling window width, in ms. */
  windowMs: number;
  /** Max hits allowed per key inside the window. */
  maxPerWindow: number;
  /** Cap on total tracked keys. LRU-evicted past this cap. */
  maxKeys: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Wall-clock timestamp (ms) when the limit window will reset for this key. */
  resetAt: number;
  /** Number of hits inside the current window after this call (or the attempted hit if denied). */
  count: number;
}

export interface SlidingWindowLimiter {
  /** Record a hit against `key`; return whether it was allowed. */
  check(key: string, now?: number): RateLimitDecision;
  /** Drop entries whose windows have fully elapsed. Bounded memory hygiene. */
  prune(now?: number): void;
  /** Current number of tracked keys. */
  size(): number;
  /** Clear all state. */
  reset(): void;
}

interface Entry {
  /** Sliding-window timestamps in ms. Sorted ascending. */
  hits: number[];
}

export function createSlidingWindowLimiter(
  options: SlidingWindowLimiterOptions,
): SlidingWindowLimiter {
  const { windowMs, maxPerWindow, maxKeys } = options;
  if (windowMs <= 0) {
    throw new RangeError('windowMs must be > 0');
  }
  if (maxPerWindow <= 0) {
    throw new RangeError('maxPerWindow must be > 0');
  }
  if (maxKeys <= 0) {
    throw new RangeError('maxKeys must be > 0');
  }

  // LRU is implemented via Map's insertion-order: every check refreshes
  // the entry by deleting and re-setting it, moving it to the tail.
  const entries = new Map<string, Entry>();

  function evictIfNeeded(): void {
    while (entries.size > maxKeys) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      entries.delete(oldestKey);
    }
  }

  return {
    check(key, now = Date.now()): RateLimitDecision {
      const entry = entries.get(key) ?? { hits: [] };
      const cutoff = now - windowMs;
      const fresh = entry.hits.filter((timestamp) => timestamp > cutoff);

      if (fresh.length >= maxPerWindow) {
        // Refresh LRU order even on denial so an attacker hammering the
        // same key cannot push other tracked keys out via eviction.
        entries.delete(key);
        entries.set(key, { hits: fresh });
        return {
          allowed: false,
          resetAt: (fresh[0] ?? now) + windowMs,
          count: fresh.length,
        };
      }
      fresh.push(now);
      entries.delete(key);
      entries.set(key, { hits: fresh });
      evictIfNeeded();
      return {
        allowed: true,
        resetAt: (fresh[0] ?? now) + windowMs,
        count: fresh.length,
      };
    },
    prune(now = Date.now()): void {
      const cutoff = now - windowMs;
      for (const [key, entry] of entries) {
        const fresh = entry.hits.filter((timestamp) => timestamp > cutoff);
        if (fresh.length === 0) {
          entries.delete(key);
        } else if (fresh.length !== entry.hits.length) {
          entry.hits = fresh;
        }
      }
    },
    size(): number {
      return entries.size;
    },
    reset(): void {
      entries.clear();
    },
  };
}
