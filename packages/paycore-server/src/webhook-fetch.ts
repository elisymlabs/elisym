import {
  MAX_WEBHOOKS_IN_FLIGHT,
  WEBHOOK_MAX_ANSWER_BYTES,
  WEBHOOK_TIMEOUT_MS,
} from '@merchant-node/constants';
import type { FetchLike } from '@merchant-node/webhook';
import {
  type FetchGuardDeps,
  FetchGuardError,
  type GuardedResponse,
  guardedFetch,
} from './connectors/fetch-guard';

/** Webhook requests in flight across every store of the process; the rest wait in line. */
export const WEBHOOK_FETCH_MAX_CONCURRENT = 32;

/** Sends one store may have waiting for a slot: merchant-node runs at most this many per store. */
export const WEBHOOK_MAX_QUEUED_PER_STORE = MAX_WEBHOOKS_IN_FLIGHT;

/** Statuses a `Response` must be built without a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface WebhookSlotsOptions {
  /** Defaults to `WEBHOOK_FETCH_MAX_CONCURRENT`. */
  maxConcurrent?: number;
  /** Defaults to `WEBHOOK_MAX_QUEUED_PER_STORE`; a send past it is refused. */
  maxQueuedPerStore?: number;
  /** One request's budget, counted from when it leaves the queue. Defaults to `WEBHOOK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Process shutdown: every waiting send is refused and every running one aborted. */
  signal?: AbortSignal;
  deps?: FetchGuardDeps;
}

export interface StoreWebhookOptions {
  /** This store's stop: only its waiting sends are refused and its running ones aborted. */
  signal?: AbortSignal;
}

interface Waiter {
  grant: () => void;
}

function shutdownError(): FetchGuardError {
  return new FetchGuardError('timeout', 'The server is shutting down');
}

function storeStoppedError(): FetchGuardError {
  return new FetchGuardError('timeout', 'The store is stopping');
}

function bodyOf(body: RequestInit['body']): string | Uint8Array {
  if (typeof body === 'string' || body instanceof Uint8Array) {
    return body;
  }
  throw new TypeError('webhookFetch sends a string or byte body only');
}

function headersOf(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

/**
 * The webhook HTTP client shared by every store node of the process, over the
 * fetch guard: POST only, https on port 443 to a public address, no redirect
 * followed (a 3xx fails), at most `WEBHOOK_MAX_ANSWER_BYTES` of the answer
 * read. At most `maxConcurrent` requests run at once. The others wait in one
 * line per store, and a freed slot goes to the stores in turn (round robin),
 * so stores whose endpoints stall cannot starve the rest; a waiting send is
 * never failed for waiting. The answer `Response` carries the status and the
 * (cut) body only, no headers.
 */
export class WebhookSlots {
  private active = 0;
  /** Each store's waiting sends; the map's order is the round-robin order. */
  private readonly lanes = new Map<string, Waiter[]>();
  private readonly limit: number;
  private readonly maxQueuedPerStore: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: WebhookSlotsOptions = {}) {
    this.limit = options.maxConcurrent ?? WEBHOOK_FETCH_MAX_CONCURRENT;
    this.maxQueuedPerStore = options.maxQueuedPerStore ?? WEBHOOK_MAX_QUEUED_PER_STORE;
    this.timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  }

  /** Requests running now. */
  get running(): number {
    return this.active;
  }

  /** Sends waiting for a slot, across every store. */
  get queued(): number {
    let total = 0;
    for (const lane of this.lanes.values()) {
      total += lane.length;
    }
    return total;
  }

  /**
   * The `fetch` for one store's `WebhookSender`. Its `signal` is the store's
   * stop. Stop the store node first (or in the same synchronous turn) and
   * abort this signal after: the refused or aborted send then ends in
   * `{ ok: false }`, whose commit the stopped node's queue drops, so the
   * entry keeps its attempts and is sent again by the next run.
   */
  forStore(owner: string, options: StoreWebhookOptions = {}): FetchLike {
    const signals = [options.signal, this.options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const running = signals.length === 0 ? undefined : AbortSignal.any(signals);
    return async (input, init) => {
      if ((init.method ?? 'GET').toUpperCase() !== 'POST') {
        throw new TypeError('webhookFetch sends POST only');
      }
      const body = bodyOf(init.body);
      const headers = headersOf(init);
      // `init.signal` is ignored on purpose: sendWebhook starts its timeout when
      // it calls, so in a full queue it would expire before the request starts.
      // The request's own `timeoutMs` starts once it leaves the queue instead.
      await this.acquire(owner, options.signal);
      let answer: GuardedResponse;
      try {
        answer = await guardedFetch(
          input,
          {
            method: 'POST',
            body,
            headers,
            maxBytes: WEBHOOK_MAX_ANSWER_BYTES,
            overflow: 'truncate',
            maxRedirects: 0,
            timeoutMs: this.timeoutMs,
            ...(running === undefined ? {} : { signal: running }),
          },
          this.options.deps,
        );
      } finally {
        this.release();
      }
      if (answer.status < 200 || answer.status > 599) {
        throw new FetchGuardError('network', `Unexpected HTTP status ${answer.status}`);
      }
      return new Response(NULL_BODY_STATUSES.has(answer.status) ? null : answer.body, {
        status: answer.status,
      });
    };
  }

  private acquire(owner: string, storeSignal: AbortSignal | undefined): Promise<void> {
    const shutdown = this.options.signal;
    // A refusal at stop or shutdown fails this attempt in sendWebhook; the
    // stopped store node drops its commit (its queue takes no task once
    // stopped), so the ledger entry is left as it was.
    if (shutdown?.aborted) {
      return Promise.reject(shutdownError());
    }
    if (storeSignal?.aborted) {
      return Promise.reject(storeStoppedError());
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    const lane = this.lanes.get(owner) ?? [];
    if (lane.length >= this.maxQueuedPerStore) {
      return Promise.reject(
        new FetchGuardError('network', 'Too many webhooks of this store are waiting'),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const stopListening = (): void => {
        shutdown?.removeEventListener('abort', onShutdown);
        storeSignal?.removeEventListener('abort', onStoreStop);
      };
      const leave = (error: FetchGuardError): void => {
        stopListening();
        const index = lane.indexOf(waiter);
        if (index !== -1) {
          lane.splice(index, 1);
        }
        if (lane.length === 0 && this.lanes.get(owner) === lane) {
          this.lanes.delete(owner);
        }
        reject(error);
      };
      const onShutdown = (): void => leave(shutdownError());
      const onStoreStop = (): void => leave(storeStoppedError());
      const waiter: Waiter = {
        grant: () => {
          stopListening();
          resolve();
        },
      };
      shutdown?.addEventListener('abort', onShutdown, { once: true });
      storeSignal?.addEventListener('abort', onStoreStop, { once: true });
      lane.push(waiter);
      if (!this.lanes.has(owner)) {
        this.lanes.set(owner, lane);
      }
    });
  }

  private release(): void {
    for (const [owner, lane] of this.lanes) {
      const next = lane.shift();
      // This store goes to the back of the turn, if it still has sends waiting.
      this.lanes.delete(owner);
      if (lane.length > 0) {
        this.lanes.set(owner, lane);
      }
      if (next !== undefined) {
        // The slot passes straight to the next waiter: `active` stays the same.
        next.grant();
        return;
      }
    }
    this.active -= 1;
  }
}
