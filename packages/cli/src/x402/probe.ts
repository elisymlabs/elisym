/**
 * Unpaid 402 probe: request the upstream WITHOUT payment and parse the
 * advertised payment requirements. Used by `elisym x402 add` (skill
 * generation) and by the per-job preflight (live quote before the customer
 * pays). Supports both wire formats: the v2 base64 `PAYMENT-REQUIRED`
 * response header and the v1 JSON body.
 */
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/fetch';

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Cap on the buffered v1 402 body. A legitimate v1 challenge is a small JSON
 * document (well under this); the cap stops a hostile or compromised upstream
 * from streaming a multi-gigabyte body into memory on the unpaid probe path
 * (the response-header path is already bounded by undici's header limit).
 */
const MAX_PROBE_BODY_BYTES = 256 * 1024;

/** Number of distinct (method, url) probe results kept in the shared cache. */
const PROBE_CACHE_MAX_ENTRIES = 256;

/** Read a response body into text, aborting once it exceeds `maxBytes`. */
async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new X402ProbeError(`402 body exceeds ${maxBytes} bytes`, 402);
    }
    return new TextDecoder().decode(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new X402ProbeError(`402 body exceeds ${maxBytes} bytes`, 402);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export interface X402ResourceInfo {
  url?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
}

export interface X402ProbeResult {
  x402Version: number;
  accepts: PaymentRequirements[];
  resource?: X402ResourceInfo;
}

/** Raised when the endpoint responds but is not a parseable x402 resource. */
export class X402ProbeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'X402ProbeError';
    this.status = status;
  }
}

interface V1Requirement {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  payTo?: unknown;
  maxAmountRequired?: unknown;
  maxTimeoutSeconds?: unknown;
  extra?: unknown;
  resource?: unknown;
  description?: unknown;
  mimeType?: unknown;
}

function normalizeV1Requirement(raw: V1Requirement): PaymentRequirements {
  return {
    scheme: typeof raw.scheme === 'string' ? raw.scheme : '',
    network: (typeof raw.network === 'string' ? raw.network : 'unknown:unknown') as never,
    asset: typeof raw.asset === 'string' ? raw.asset : '',
    payTo: typeof raw.payTo === 'string' ? raw.payTo : '',
    amount: typeof raw.maxAmountRequired === 'string' ? raw.maxAmountRequired : '',
    maxTimeoutSeconds: typeof raw.maxTimeoutSeconds === 'number' ? raw.maxTimeoutSeconds : 60,
    extra: (raw.extra ?? {}) as Record<string, unknown>,
  };
}

function parseV1Body(bodyText: string): X402ProbeResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const body = parsed as { x402Version?: unknown; accepts?: unknown };
  if (body.x402Version !== 1 || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    return null;
  }
  // Keep only object entries: a hostile upstream can put `null`/scalars in
  // `accepts`, and mapping them straight into `normalizeV1Requirement` (which
  // reads `.scheme` etc.) would throw a TypeError instead of cleanly failing.
  const rawRequirements = body.accepts.filter(
    (item): item is V1Requirement => typeof item === 'object' && item !== null,
  );
  if (rawRequirements.length === 0) {
    return null;
  }
  const accepts = rawRequirements.map(normalizeV1Requirement);
  const first = rawRequirements[0];
  return {
    x402Version: 1,
    accepts,
    resource: {
      url: typeof first.resource === 'string' ? first.resource : undefined,
      description: typeof first.description === 'string' ? first.description : undefined,
      mimeType: typeof first.mimeType === 'string' ? first.mimeType : undefined,
    },
  };
}

/**
 * Probe the upstream with the declared method and an empty body. Throws
 * `X402ProbeError` when the response is not a parseable 402 (the caller maps
 * it to a preflight refusal or a friendly `add` message); network errors
 * propagate as-is for the caller to classify.
 */
export async function probePaymentRequired(
  url: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
): Promise<X402ProbeResult> {
  const probeSignal = signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS);
  // `redirect: 'error'` (not the default 'follow'): the upstream is untrusted,
  // and auto-following a 3xx would let it redirect the probe to an internal
  // address (SSRF, e.g. cloud metadata) or a different host. A real x402
  // resource answers 402 directly, so a redirect is a hard error here.
  const response = await fetch(url, { method, signal: probeSignal, redirect: 'error' });
  // Drain/ignore bodies we don't parse so undici can reuse the connection.
  if (response.status !== 402) {
    await response.body?.cancel().catch(() => {});
    throw new X402ProbeError(
      `expected HTTP 402 from ${url}, got ${response.status} - not an x402-paid endpoint (or it validates the request before the paywall; try the other method)`,
      response.status,
    );
  }

  const headerValue = response.headers.get('PAYMENT-REQUIRED');
  if (headerValue !== null) {
    await response.body?.cancel().catch(() => {});
    try {
      const paymentRequired = decodePaymentRequiredHeader(headerValue);
      return {
        x402Version: paymentRequired.x402Version,
        accepts: paymentRequired.accepts,
        resource: paymentRequired.resource,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new X402ProbeError(`could not decode PAYMENT-REQUIRED header: ${message}`, 402);
    }
  }

  const bodyText = await readTextCapped(response, MAX_PROBE_BODY_BYTES).catch((error) => {
    if (error instanceof X402ProbeError) {
      throw error;
    }
    return '';
  });
  const v1 = parseV1Body(bodyText);
  if (v1 !== null) {
    return v1;
  }
  throw new X402ProbeError(
    'got HTTP 402 but neither a v2 PAYMENT-REQUIRED header nor a v1 JSON body was parseable',
    402,
  );
}

interface ProbeCacheEntry {
  at: number;
  result: X402ProbeResult;
}

const PROBE_CACHE = new Map<string, ProbeCacheEntry>();

/**
 * TTL-cached probe shared across concurrent jobs, so an upstream that
 * rate-limits unpaid 402s sees at most one probe per TTL window instead of
 * one per job. The quote may be up to TTL old - the ceiling is enforced
 * again at signing time (payment policies), so the cache is availability
 * smoothing, not a money decision.
 */
export async function probePaymentRequiredCached(
  url: string,
  method: 'GET' | 'POST',
  ttlMs: number,
): Promise<X402ProbeResult> {
  const key = `${method} ${url}`;
  const cached = PROBE_CACHE.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < ttlMs) {
    return cached.result;
  }
  const result = await probePaymentRequired(url, method);
  // Bound the shared module-level cache: drop the oldest-inserted entry once
  // over the cap (Map preserves insertion order). Re-set moves the key to the
  // end so live URLs are not evicted. Stops unbounded growth if many distinct
  // upstream URLs are probed over a long-lived process.
  PROBE_CACHE.delete(key);
  PROBE_CACHE.set(key, { at: now, result });
  while (PROBE_CACHE.size > PROBE_CACHE_MAX_ENTRIES) {
    const oldest = PROBE_CACHE.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    PROBE_CACHE.delete(oldest);
  }
  return result;
}

/** Test hook: drop cached probes. */
export function clearProbeCache(): void {
  PROBE_CACHE.clear();
}
