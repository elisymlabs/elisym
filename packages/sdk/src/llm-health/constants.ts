/**
 * LLM health monitor and heartbeat tunable defaults. CLI and plugin consumers
 * can override via `process.env.ELISYM_LLM_HEALTH_TTL_MS` and
 * `ELISYM_LLM_HEARTBEAT_INTERVAL_MS` and pass the resolved values into
 * the monitor/heartbeat options.
 */

export const DEFAULT_HEALTH_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Interval between recovery probes after the LLM health monitor enters an
 * unhealthy state. The recovery loop is paused while the pair is healthy
 * and only kicks in reactively (after `markUnhealthyFromJob` or a failed
 * job). On the first successful probe the monitor returns to healthy and
 * the loop stops on its own.
 */
export const LAZY_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Exit code contract: a `dynamic-script` / `static-script` skill returns
 * this code from the script process to signal that the upstream LLM
 * provider rejected the request because credits / billing are exhausted.
 * The agent runtime treats this as the script's equivalent of the
 * `mode: 'llm'` 402 path: it calls `markUnhealthyFromJob(provider, model)`
 * on the health monitor (which starts the lazy recovery loop) and rejects
 * subsequent jobs against the same pair until a recovery probe succeeds.
 *
 * Any other non-zero exit is a generic failure and does NOT touch health
 * state - operators should reserve this code for billing-exhausted only.
 *
 * 42 was chosen because it sits outside POSIX shell conventions (1-2
 * generic, 126-128 shell-internal, 130+ signals) and `sysexits.h`
 * (64-78 - usage / data / host / config errors), so it doesn't collide
 * with other meaningful exit codes a script might naturally produce.
 */
export const SCRIPT_EXIT_BILLING_EXHAUSTED = 42;

/**
 * Exit code contract: a script skill returns this code to say "I understood the
 * request and will not do it", with the reason for the CUSTOMER on stdout.
 *
 * Every other non-zero exit is a failure, and a failure's output stays
 * operator-side because raw subprocess output is not safe to forward. A refusal
 * is the other thing that can happen: the job was well-formed and the answer is
 * no. Without a channel for it the customer pays, receives a generic failure,
 * and has no way to learn what to change - which makes a capability that
 * refuses precisely (a mandate parser, a policy check, a validator)
 * indistinguishable from one that is simply broken.
 *
 * The contract is narrow on purpose. What reaches the customer is what the
 * script wrote to STDOUT, cleaned and capped at `SCRIPT_REFUSAL_MAX_CHARS`;
 * stderr keeps its existing guarantee of never crossing that boundary. A
 * refusal does NOT touch health state, because it is an answer rather than a
 * fault.
 *
 * 43 sits beside 42 and outside the same ranges: 1-2 generic, 64-78
 * `sysexits.h`, 126-128 shell-internal, 130+ signals.
 */
export const SCRIPT_EXIT_REFUSED = 43;

/** How much of a refusal reaches the customer - long enough for a sentence or three. */
export const SCRIPT_REFUSAL_MAX_CHARS = 400;

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
