import {
  createSlidingWindowLimiter,
  type RateLimitDecision,
  type SlidingWindowLimiter,
} from '@elisym/sdk';
import {
  MAX_TRACKED_CUSTOMERS,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from '../constants';

export type { RateLimitDecision };

export interface RateLimiterOptions {
  windowMs?: number;
  maxPerWindow?: number;
  maxTrackedKeys?: number;
}

/**
 * Thin wrapper around the SDK sliding-window limiter that keeps the
 * historical constructor shape used across the plugin (defaults sourced
 * from plugin constants, `maxTrackedKeys` naming).
 */
export class RateLimiter {
  private readonly inner: SlidingWindowLimiter;

  constructor(options: RateLimiterOptions = {}) {
    this.inner = createSlidingWindowLimiter({
      windowMs: options.windowMs ?? RATE_LIMIT_WINDOW_MS,
      maxPerWindow: options.maxPerWindow ?? RATE_LIMIT_MAX_PER_WINDOW,
      maxKeys: options.maxTrackedKeys ?? MAX_TRACKED_CUSTOMERS,
    });
  }

  check(key: string, now?: number): RateLimitDecision {
    return this.inner.check(key, now);
  }

  size(): number {
    return this.inner.size();
  }

  reset(): void {
    this.inner.reset();
  }
}
