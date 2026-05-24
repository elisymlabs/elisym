/**
 * Shared HTTP helpers for provider clients: timeout-aware fetch and a
 * retry wrapper that handles 429/5xx with exponential backoff and
 * `Retry-After`. Provider descriptors compose these so each new
 * provider does not re-derive timeout/abort plumbing.
 */

// `ReadableStream` is a runtime global in Bun/Node but is not declared by this
// package's TS lib; import the typed constructor from node:stream/web.
import { ReadableStream } from 'node:stream/web';

// Per-HTTP-request timeout for LLM calls. This is a backstop against a hung
// socket, not the job's execution ceiling - the per-job AbortSignal (driven by
// the skill/agent execution budget) is wired into every fetch and is the real
// limit. Default is generous so one large single-shot generation is not cut
// off; operators with heavier skills raise it via `ELISYM_LLM_TIMEOUT_MS`. Kept
// modest enough that `max_tool_rounds x LLM_TIMEOUT_MS` stays a sane implicit
// ceiling when a skill runs with no execution budget (unlimited).
const DEFAULT_LLM_TIMEOUT_MS = 600_000; // 10 minutes

function resolveLlmTimeoutMs(): number {
  const raw = process.env.ELISYM_LLM_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_LLM_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LLM_TIMEOUT_MS;
}

const LLM_TIMEOUT_MS = resolveLlmTimeoutMs();
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function createAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let toreDown = false;
  const teardown = (): void => {
    if (toreDown) {
      return;
    }
    toreDown = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    // Headers phase failed or was aborted - nothing more to cover.
    teardown();
    throw error;
  }

  // FIX #31: the timeout/abort wiring (`timer` + parent `signal`) must stay
  // armed across the body read, not be torn down the moment `fetch()` resolves
  // the headers. Callers consume the body right after this returns
  // (`response.json()` / `.text()`), which still streams over the same socket;
  // tearing the wiring down in a `finally` here left that phase unbounded.
  //
  // The returned `Response`'s body methods are read-only, so instead of
  // patching them we tap the underlying body stream and rebuild the `Response`
  // over a stream we control. Teardown runs when the body is fully read
  // (reader reports `done`), when the read errors, or when the consumer
  // cancels the body (`response.body?.cancel()`) - covering every body-phase
  // exit. `controller.signal` still backs the original stream, so a stall
  // mid-body trips `timer`, which aborts the read and rejects the pull. The
  // new `Response` preserves status / statusText / headers and all
  // body-consuming methods, so there are no call-site changes. A 204/no-body
  // response has nothing to wait on, so teardown is immediate.
  const body = response.body;
  // No readable stream to bound (204/no-body, or a non-stream body e.g. in tests):
  // nothing to keep the wiring armed for, so tear down and return as-is.
  if (!body || typeof body.getReader !== 'function') {
    teardown();
    return response;
  }

  const reader = body.getReader();
  const tappedStream = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          teardown();
          streamController.close();
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        teardown();
        streamController.error(error);
      }
    },
    cancel(reason) {
      teardown();
      return reader.cancel(reason);
    },
  });

  return new Response(tappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, signal);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (attempt >= MAX_RETRIES || name === 'AbortError') {
        throw error;
      }
      await sleepWithSignal(Math.min(1000 * 2 ** attempt, 8000), signal);
      continue;
    }
    if (response.ok || attempt >= MAX_RETRIES || !RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000 || 1000 * 2 ** attempt, 30_000)
      : Math.min(1000 * 2 ** attempt, 8000);
    await response.body?.cancel().catch(() => undefined);
    await sleepWithSignal(delay, signal);
  }
}
