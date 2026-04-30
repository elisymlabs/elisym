/**
 * LLM health monitor and heartbeat tunable defaults. CLI and plugin consumers
 * can override via `process.env.ELISYM_LLM_HEALTH_TTL_MS` and
 * `ELISYM_LLM_HEARTBEAT_INTERVAL_MS` and pass the resolved values into
 * the monitor/heartbeat options.
 */

export const DEFAULT_HEALTH_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Number of consecutive `unavailable` results tolerated before
 * `assertReady` starts throwing. The first `unavailable - 1` are treated
 * as transient blips so a brief network hiccup does not block jobs.
 */
export const UNAVAILABLE_TOLERANCE = 3;

/**
 * Free-LLM rate-limit defaults. Applied when a SKILL.md with
 * `mode: 'llm'` and `price: 0` does not declare its own `rate_limit`.
 */
export const DEFAULT_FREE_LLM_PER_CUSTOMER_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_FREE_LLM_PER_CUSTOMER_MAX = 3;

export const DEFAULT_FREE_LLM_GLOBAL_WINDOW_MS = 60 * 1000;
export const DEFAULT_FREE_LLM_GLOBAL_MAX = 30;

export const DEFAULT_FREE_LLM_MAX_TRACKED_KEYS = 1000;
