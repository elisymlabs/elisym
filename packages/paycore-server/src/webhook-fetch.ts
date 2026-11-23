import { WEBHOOK_MAX_ANSWER_BYTES, WEBHOOK_TIMEOUT_MS } from '@merchant-node/constants';
import type { FetchLike } from '@merchant-node/webhook';
import {
  type FetchGuardDeps,
  FetchGuardError,
  type GuardedResponse,
  guardedFetch,
} from './connectors/fetch-guard';

/** Webhook requests in flight across every store of the process; the rest wait in line. */
export const WEBHOOK_FETCH_MAX_CONCURRENT = 32;

/** Statuses a `Response` must be built without a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface WebhookFetchOptions {
  /** Defaults to `WEBHOOK_FETCH_MAX_CONCURRENT`. */
  maxConcurrent?: number;
  /** One request's budget, counted from when it leaves the queue. Defaults to `WEBHOOK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Shutdown: waiting sends are refused and running ones aborted. */
  signal?: AbortSignal;
  deps?: FetchGuardDeps;
}

function shutdownError(): FetchGuardError {
  return new FetchGuardError('timeout', 'The server is shutting down');
}

/** A FIFO counting semaphore. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(shutdownError());
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) {
          this.waiting.splice(index, 1);
        }
        reject(shutdownError());
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    // The slot passes straight to the next waiter: `active` stays the same.
    next();
  }
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
 * merchant-node's webhook `fetch` over the fetch guard, shared by every store
 * node of the process: POST only, https on port 443 to a public address, no
 * redirect followed (a 3xx fails), at most `WEBHOOK_MAX_ANSWER_BYTES` of the
 * answer read. At most `maxConcurrent` requests run at once; the others queue
 * and are never failed for waiting. The answer `Response` carries the status
 * and the (cut) body only, no headers.
 */
export function webhookFetch(options: WebhookFetchOptions = {}): FetchLike {
  const slots = new Slots(options.maxConcurrent ?? WEBHOOK_FETCH_MAX_CONCURRENT);
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  return async (input, init) => {
    if ((init.method ?? 'GET').toUpperCase() !== 'POST') {
      throw new TypeError('webhookFetch sends POST only');
    }
    const body = bodyOf(init.body);
    const headers = headersOf(init);
    // `init.signal` is ignored on purpose: sendWebhook starts its timeout when
    // it calls, so in a full queue it would expire before the request starts.
    // The request's own `timeoutMs` starts once it leaves the queue instead.
    await slots.acquire(options.signal);
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
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        options.deps,
      );
    } finally {
      slots.release();
    }
    if (answer.status < 200 || answer.status > 599) {
      throw new FetchGuardError('network', `Unexpected HTTP status ${answer.status}`);
    }
    return new Response(NULL_BODY_STATUSES.has(answer.status) ? null : answer.body, {
      status: answer.status,
    });
  };
}
