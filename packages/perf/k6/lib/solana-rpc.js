// Minimal JSON-RPC helpers for k6 scenarios that hit Solana RPC directly.
// Centralised so scenarios share one error-classification policy and one URL.

import { check } from 'k6';
import http from 'k6/http';
import { RPC_URL } from './env.js';

let requestId = 0;

function nextId() {
  requestId = (requestId + 1) % Number.MAX_SAFE_INTEGER;
  return requestId;
}

/**
 * Issue a JSON-RPC request and return { result, error, status, durationMs }.
 * Does NOT throw on RPC errors; scenarios decide how to count them.
 */
export function rpcCall(method, params = [], { url = RPC_URL, tags = {} } = {}) {
  const start = Date.now();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId(),
    method,
    params,
  });
  const res = http.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    tags: { rpc_method: method, ...tags },
  });
  const durationMs = Date.now() - start;

  let parsed = null;
  try {
    parsed = res.json();
  } catch (_err) {
    parsed = null;
  }
  return {
    status: res.status,
    durationMs,
    result: parsed?.result,
    error: parsed?.error,
  };
}

/** Returns the value (number) of getSlot, or null on error. */
export function getSlot(opts) {
  const r = rpcCall('getSlot', [], opts);
  return r.error ? null : r.result;
}

/** Returns getBalance value (lamports as number), or null on error. */
export function getBalance(address, opts) {
  const r = rpcCall('getBalance', [address], opts);
  return r.error ? null : (r.result?.value ?? null);
}

/** Sanity check, used in scenario setup(). */
export function pingRpc(url = RPC_URL) {
  const r = rpcCall('getHealth', [], { url });
  check(r, {
    [`rpc ${url} responds`]: () => r.status === 200 && !r.error,
  });
  return r.status === 200 && !r.error;
}
