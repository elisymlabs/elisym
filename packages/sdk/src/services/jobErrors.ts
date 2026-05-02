/**
 * Customer-facing error feedback that arrives via `subscribeToJobUpdates`'s
 * `onError` callback can come from many places:
 *
 *   - The runtime's stable `Agent temporarily unavailable` string when the
 *     LLM health gate refuses a job (preflight) or an in-flight skill
 *     surfaced a billing/invalid signal.
 *   - The runtime's `Internal processing error` sanitization mask for any
 *     "<Provider> API error: ..." string that leaks out of an LLM call.
 *   - Raw script-skill failures the runtime forwards as-is when the
 *     message does not contain "API" - e.g. shell scripts that reach
 *     Anthropic's `count_tokens` endpoint and exit 1 with the body in
 *     stderr instead of using the canonical exit-42 contract.
 *   - Generic transport errors (timeouts, "Provider returned an error",
 *     rate-limit refusals, payment errors).
 *
 * Customers don't care which path produced the error - they care whether
 * the agent is down (try later, payment recoverable) or something else
 * went wrong (their input, their wallet, etc). This classifier collapses
 * the first three categories into a single `agent-unavailable` kind so
 * the UI can render one stable message regardless of how the underlying
 * provider chose to surface the failure.
 *
 * Markers are kept as a permissive superset of every billing/auth phrase
 * the CLI and skill scripts are known to emit. Adding a new marker is
 * always safe; removing one risks classifying a real outage as `unknown`.
 */

const AGENT_UNAVAILABLE_MARKERS = [
  'agent temporarily unavailable',
  'internal processing error',
  'invalid x-api-key',
  'invalid api key',
  'invalid_api_key',
  'x-api-key',
  'credit balance',
  'billing',
  'insufficient',
  'insufficient_quota',
  'authentication_error',
  'unauthorized',
  'unauthenticated',
];

export type JobErrorKind = 'agent-unavailable' | 'unknown';

/**
 * Classify a customer-facing error string surfaced via
 * `JobUpdateCallbacks.onError` into a stable kind the UI can branch on.
 *
 * Match is case-insensitive against the message text. Returns
 * `agent-unavailable` for any known billing/auth/invalid-key signal;
 * `unknown` for everything else (timeouts, validation errors, transport).
 */
export function classifyJobError(message: string): JobErrorKind {
  const lower = message.toLowerCase();
  for (const marker of AGENT_UNAVAILABLE_MARKERS) {
    if (lower.includes(marker)) {
      return 'agent-unavailable';
    }
  }
  return 'unknown';
}
