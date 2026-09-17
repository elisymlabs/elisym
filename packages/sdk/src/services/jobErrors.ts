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

/**
 * The runtime's label on the one customer-facing message a PROVIDER wrote: the
 * reason a skill refused the job (`SCRIPT_EXIT_REFUSED`).
 *
 * A cross-package contract, and matched as a PREFIX exactly like
 * `Payment timeout` is in the app: the text after it is the provider's own
 * sentence, and a refusal that says "insufficient detail in the brief" or
 * "check your billing address" would otherwise be read as an outage by the
 * substring markers below - telling the customer their payment is held for a
 * job that is already closed and already charged.
 *
 * NOT authenticated. The provider's own runtime writes it, so an agent running
 * anything else can send the same string; it says "this reads as a refusal",
 * never "this is certainly one". Anything a client does with it has to stay
 * within what a lying provider could already do - suppressing a retry button
 * is fine, asserting where the customer's money went is not.
 */
export const PROVIDER_REFUSED_PREFIX = 'The provider refused: ';

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

export type JobErrorKind = 'agent-unavailable' | 'provider-refused' | 'unknown';

/**
 * Classify a customer-facing error string surfaced via
 * `JobUpdateCallbacks.onError` into a stable kind the UI can branch on.
 *
 * Match is case-insensitive against the message text. Returns
 * `provider-refused` when the runtime labelled the message as a skill's own
 * refusal, `agent-unavailable` for any known billing/auth/invalid-key signal,
 * and `unknown` for everything else (timeouts, validation errors, transport).
 */
export function classifyJobError(message: string): JobErrorKind {
  // Before the markers, and by prefix: everything after the label is the
  // provider's own words, which may contain any of them innocently.
  if (message.startsWith(PROVIDER_REFUSED_PREFIX)) {
    return 'provider-refused';
  }
  const lower = message.toLowerCase();
  for (const marker of AGENT_UNAVAILABLE_MARKERS) {
    if (lower.includes(marker)) {
      return 'agent-unavailable';
    }
  }
  return 'unknown';
}

/**
 * Signalled via `JobUpdateCallbacks.onTimeout` (and thrown by helpers that
 * await a result) when the wait window expires without a result. This is a
 * distinct, structured signal from a genuine provider/transport error, so
 * callers can branch on the type instead of substring-matching "timed out"
 * on a free-form error message (which masks real errors that happen to
 * mention a timeout).
 */
export class JobWaitTimeoutError extends Error {
  constructor(timeoutMs?: number) {
    super(
      timeoutMs === undefined
        ? 'Timed out waiting for job result'
        : `Timed out waiting for job result (${Math.round(timeoutMs / 1000)}s)`,
    );
    this.name = 'JobWaitTimeoutError';
  }
}
