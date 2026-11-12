import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from './constants';

/** Doublings past this would only re-hit the cap. */
const MAX_EXPONENT = 16;

/**
 * Reconnect backoff (2.4): exponential with jitter, 1 s doubling to 60 s. The
 * jitter spreads tabs out after a relay or proxy restart, so they do not all
 * come back at once.
 */
export class Backoff {
  private attempt = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /** The next delay: half the step plus a random part of the other half. */
  next(): number {
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, MAX_EXPONENT);
    const half = step / 2;
    return Math.round(half + this.random() * half);
  }

  reset(): void {
    this.attempt = 0;
  }
}
