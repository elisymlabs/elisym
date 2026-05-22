/**
 * Shared HTTP helpers for provider clients: timeout-aware fetch and a
 * retry wrapper that handles 429/5xx with exponential backoff and
 * `Retry-After`. Provider descriptors compose these so each new
 * provider does not re-derive timeout/abort plumbing.
 */

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
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
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
