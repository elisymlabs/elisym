export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/**
 * Reconnect backoff: exponential with jitter, from `baseMs` doubling to
 * `maxMs`. The caller resets it once a connection has proven itself.
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly baseMs: number = BACKOFF_BASE_MS,
    private readonly maxMs: number = BACKOFF_MAX_MS,
  ) {}

  /** The delay before the next attempt, in milliseconds, and count it. */
  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    // Full jitter in the upper half: never zero, never a thundering herd.
    return Math.round(ceiling / 2 + (ceiling / 2) * this.random());
  }

  reset(): void {
    this.attempt = 0;
  }
}
