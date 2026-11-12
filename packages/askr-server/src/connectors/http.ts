import { DEFAULT_SHOP_GAP_MS, MAX_REQUESTS_PER_SYNC } from './constants';
import {
  type FetchGuardDeps,
  type GuardedRequest,
  type GuardedResponse,
  guardedFetch,
} from './fetch-guard';

const MAX_TRACKED_SHOPS = 10_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-shop rate limit: requests to one origin are spaced at least `gapMs`
 * apart, whatever store or sync makes them. Share one instance across syncs.
 */
export class ShopRateLimiter {
  private readonly nextAt = new Map<string, number>();

  constructor(
    private readonly gapMs: number = DEFAULT_SHOP_GAP_MS,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** Wait for this origin's next slot and take it. */
  async acquire(origin: string): Promise<void> {
    const now = this.clock();
    if (this.nextAt.size > MAX_TRACKED_SHOPS) {
      for (const [stored, at] of this.nextAt) {
        if (at <= now) {
          this.nextAt.delete(stored);
        }
      }
    }
    const at = Math.max(now, this.nextAt.get(origin) ?? 0);
    this.nextAt.set(origin, at + this.gapMs);
    if (at > now) {
      await this.sleep(at - now);
    }
  }
}

export class RequestBudgetError extends Error {
  constructor() {
    super('Too many requests for one sync');
    this.name = 'RequestBudgetError';
  }
}

export interface ShopHttpDeps {
  fetch?: FetchGuardDeps;
  limiter?: ShopRateLimiter;
  maxRequests?: number;
}

/** Guarded, rate-limited GETs for one sync, with a request budget. */
export class ShopHttp {
  private requests = 0;
  private readonly limiter: ShopRateLimiter;
  private readonly maxRequests: number;

  constructor(private readonly deps: ShopHttpDeps = {}) {
    this.limiter = deps.limiter ?? new ShopRateLimiter();
    this.maxRequests = deps.maxRequests ?? MAX_REQUESTS_PER_SYNC;
  }

  get requestCount(): number {
    return this.requests;
  }

  async get(url: string, request: GuardedRequest): Promise<GuardedResponse> {
    this.requests += 1;
    if (this.requests > this.maxRequests) {
      throw new RequestBudgetError();
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = url;
    }
    await this.limiter.acquire(origin);
    return guardedFetch(url, request, this.deps.fetch);
  }
}

/** The public source is closed: 401/403/404, or an answer that is not the expected JSON. */
export class SourceClosedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
    readonly httpStatus?: number,
  ) {
    super(`Source closed: ${reason}`);
    this.name = 'SourceClosedError';
  }
}

const CLOSED_STATUSES = new Set([401, 403, 404]);

/**
 * Read JSON from a platform endpoint. On the first request of a source a
 * closed status or a non-JSON answer (a password page, a login redirect) is
 * `SourceClosedError`; later requests fail with a plain error, since a partial
 * read must never be synced as the whole catalog.
 */
export async function getJson(
  http: ShopHttp,
  url: string,
  request: GuardedRequest,
  firstOfSource: boolean,
): Promise<unknown> {
  const response = await http.get(url, {
    ...request,
    accept: 'application/json',
  });
  if (response.status !== 200) {
    if (firstOfSource && CLOSED_STATUSES.has(response.status)) {
      throw new SourceClosedError(url, `HTTP ${response.status}`, response.status);
    }
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    if (firstOfSource) {
      throw new SourceClosedError(url, 'not JSON', response.status);
    }
    throw new Error(`Not JSON from ${url}`);
  }
}
