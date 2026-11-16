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

  /**
   * Wait for this origin's next slot and take it. With `maxWaitMs`, a slot
   * further off is not booked: the caller gives up at once instead of holding
   * a place in a long queue (an owner key proof, K21).
   */
  async acquire(origin: string, maxWaitMs?: number): Promise<void> {
    const now = this.clock();
    if (this.nextAt.size > MAX_TRACKED_SHOPS) {
      for (const [stored, at] of this.nextAt) {
        if (at <= now) {
          this.nextAt.delete(stored);
        }
      }
    }
    const at = Math.max(now, this.nextAt.get(origin) ?? 0);
    if (maxWaitMs !== undefined && at - now > maxWaitMs) {
      throw new ShopBusyError();
    }
    this.nextAt.set(origin, at + this.gapMs);
    if (at > now) {
      await this.sleep(at - now);
    }
  }
}

/** An origin's next slot is further off than the caller would wait. */
export class ShopBusyError extends Error {
  constructor() {
    super('The shop is busy with other reads');
    this.name = 'ShopBusyError';
  }
}

export class RequestBudgetError extends Error {
  constructor() {
    super('Too many requests for one sync');
    this.name = 'RequestBudgetError';
  }
}

/** The sync ran past its overall deadline: nothing it read is used. */
export class SyncDeadlineError extends Error {
  constructor() {
    super('The sync took longer than its deadline');
    this.name = 'SyncDeadlineError';
  }
}

export interface ShopHttpDeps {
  fetch?: FetchGuardDeps;
  limiter?: ShopRateLimiter;
  maxRequests?: number;
  /** The sync's overall deadline: once aborted, every request in flight or to come fails. */
  signal?: AbortSignal;
  /** Wait at most this long for an origin's slot; a later one fails the request at once. */
  maxSlotWaitMs?: number;
  /**
   * Pages read lately, shared by every ShopHttp given the same cache: a page
   * read within `ttlMs` is answered from it, with no request and no slot.
   */
  cache?: PageCache;
}

/**
 * Recent page reads by URL (K21): many proofs of one store read its pages
 * once. Only reads that succeeded are kept: a read still running belongs to
 * its own proof (its deadline, its budget), and a failed one says nothing of
 * the page.
 */
export class PageCache {
  private readonly pages = new Map<string, { at: number; response: GuardedResponse }>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A recent successful read of `url`, or `read`'s, kept once it succeeds. */
  async get(url: string, read: () => Promise<GuardedResponse>): Promise<GuardedResponse> {
    const cached = this.pages.get(url);
    if (cached !== undefined && this.clock() - cached.at < this.ttlMs) {
      return cached.response;
    }
    const response = await read();
    const now = this.clock();
    if (this.pages.size >= MAX_CACHED_PAGES) {
      for (const [stored, entry] of this.pages) {
        if (now - entry.at >= this.ttlMs) {
          this.pages.delete(stored);
        }
      }
    }
    if (this.pages.size < MAX_CACHED_PAGES) {
      this.pages.set(url, { at: now, response });
    }
    return response;
  }
}

/** Pages a PageCache keeps at most. */
const MAX_CACHED_PAGES = 1_000;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Guarded, rate-limited GETs for one sync, with a request budget and an
 * overall deadline. Every request counts, redirect hops included.
 */
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

  private checkDeadline(): void {
    if (this.deps.signal?.aborted) {
      throw new SyncDeadlineError();
    }
  }

  /** Count one request against the budget and wait for its origin's slot. */
  private async take(origin: string): Promise<void> {
    this.checkDeadline();
    this.requests += 1;
    if (this.requests > this.maxRequests) {
      throw new RequestBudgetError();
    }
    await this.limiter.acquire(origin, this.deps.maxSlotWaitMs);
  }

  async get(url: string, request: GuardedRequest): Promise<GuardedResponse> {
    const cache = this.deps.cache;
    return cache === undefined
      ? this.read(url, request)
      : cache.get(url, () => this.read(url, request));
  }

  private async read(url: string, request: GuardedRequest): Promise<GuardedResponse> {
    await this.take(originOf(url));
    try {
      return await guardedFetch(
        url,
        {
          ...request,
          ...(this.deps.signal ? { signal: this.deps.signal } : {}),
          beforeRedirect: (next) => this.take(next.origin),
        },
        this.deps.fetch,
      );
    } catch (error) {
      this.checkDeadline();
      throw error;
    }
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
