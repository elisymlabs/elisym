// Shared env-var helpers. All k6 scenarios pull URLs and tunables through these
// so a single command-line override (`-e KEY=value`) is enough to retarget a run.

export const STRFRY_WS = __ENV.STRFRY_WS || 'ws://localhost:7777';
export const STRFRY_HTTP = __ENV.STRFRY_HTTP || 'http://localhost:7777';
export const RPC_URL = __ENV.RPC_URL || 'http://localhost:8899';
export const BRIDGE_URL = __ENV.BRIDGE_URL || 'http://localhost:3030';
export const PROVIDER_METRICS_URL = __ENV.PROVIDER_METRICS_URL || 'http://localhost:9464/metrics';

export const SCENARIO = __ENV.SCENARIO || 'unnamed';
export const RUN_ID = __ENV.RUN_ID || `${SCENARIO}-${Date.now()}`;

export function intEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env ${name}=${raw} is not a valid integer`);
  }
  return parsed;
}

export function floatEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env ${name}=${raw} is not a valid float`);
  }
  return parsed;
}

export function boolEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}
