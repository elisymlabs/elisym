export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/**
 * Reconnect backoff: exponential with jitter, from `BACKOFF_BASE_MS` doubling
 * to `BACKOFF_MAX_MS`. The caller resets it once a connection has proven itself.
 */
export class Backoff {
  private attempt = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /** The delay before the next attempt, in milliseconds, and count it. */
  next(): number {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    // Full jitter in the upper half: never zero, never a thundering herd.
    return Math.round(ceiling / 2 + (ceiling / 2) * this.random());
  }

  reset(): void {
    this.attempt = 0;
  }
}
