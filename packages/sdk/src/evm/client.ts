/**
 * The only thing the EVM rail asks of an rpc: an EIP-1193 `request`. A browser
 * wallet provider has this shape, and so does any JSON-RPC library's transport -
 * so verification and the config read need no EVM library at all.
 */
export interface Eip1193Client {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

/**
 * A node that accepts the connection and never answers is worse than one that
 * refuses: it cannot become an error, so no fallback and no deadline it is not
 * told about can fire. Every request carries its own ceiling.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export interface JsonRpcClientOptions {
  timeoutMs?: number;
}

/** A plain JSON-RPC client over `fetch`, for callers that hold a URL and nothing else. */
export function createJsonRpcClient(url: string, options?: JsonRpcClientOptions): Eip1193Client {
  let nextId = 1;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  return {
    async request({ method, params }) {
      const id = nextId++;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`rpc ${method} answered HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) {
        throw new Error(`rpc ${method} answered something that is not a JSON-RPC response`);
      }
      if ('error' in body && body.error !== undefined && body.error !== null) {
        throw new EvmRpcError(method, body.error);
      }
      if (!('result' in body)) {
        throw new Error(`rpc ${method} answered with neither a result nor an error`);
      }
      // One request per call, so an answer carrying somebody else's id is a
      // mismatched pipe, not our answer. A node that omits the id (some do on
      // errors) is tolerated; one that names a different one is not.
      const answeredId = 'id' in body ? body.id : undefined;
      if (answeredId !== undefined && answeredId !== null && String(answeredId) !== String(id)) {
        throw new Error(`rpc ${method} answered the wrong request id`);
      }
      return body.result;
    },
  };
}

/**
 * A JSON-RPC error object, kept WHOLE: a node's errors are told apart by `code`
 * and `data`, never by `message` (four different Tempo errors share one code, and
 * a message is a debug string).
 */
export class EvmRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  /**
   * The node's own `message`, kept apart from ours. Tempo answers four different
   * `eth_getLogs` failures with ONE code and no `data`, and telling "the range was
   * too wide" (retry smaller) from "these params are nonsense" (do not retry) is
   * only possible from this string. It is never interpolated into `message`: a
   * node is remote input, and elisym's own errors stay elisym's own words.
   */
  readonly rpcMessage: string | undefined;

  constructor(method: string, error: unknown) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'number'
        ? error.code
        : undefined;
    super(`rpc ${method} failed${code === undefined ? '' : ` with code ${code}`}`);
    this.name = 'EvmRpcError';
    this.code = code;
    this.data =
      typeof error === 'object' && error !== null && 'data' in error ? error.data : undefined;
    this.rpcMessage =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : undefined;
  }
}

/**
 * Give up waiting when `signal` aborts, without pretending the request stopped.
 *
 * An EIP-1193 `request` takes no signal - a browser wallet has no such notion -
 * so a caller with a deadline can only stop AWAITING. The original promise keeps
 * its own rejection handler so that losing the race never surfaces as an
 * unhandled one.
 */
function abandoned(): Error {
  const error = new Error('The rpc request was abandoned before it answered.');
  // What every `AbortSignal` consumer looks for, so a caller can tell a deadline
  // from a node that answered badly.
  error.name = 'AbortError';
  return error;
}

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abandoned());
      return;
    }
    const onAbort = (): void => reject(abandoned());
    signal.addEventListener('abort', onAbort, { once: true });
    // Dropped BEFORE settling, not in a `finally`: one request-scoped signal
    // outlives many reads, and a listener that is only removed a microtask later
    // is one a caller can still observe piling up.
    const onSettled = (value: T): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onFailed = (error: unknown): void => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    promise.then(onSettled, onFailed);
  });
}
