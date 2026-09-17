/**
 * A refusal: the skill understood the request and will not do it.
 *
 * Every other non-zero exit is a failure, and a failure's output stays
 * operator-side because raw subprocess output is not safe to forward. That is
 * right for a crash and wrong for a refusal: a capability that validates its
 * input, applies a policy or parses an instruction then has no way to say what
 * to change, so the buyer pays, reads a generic failure and sends the same
 * request again. A capability that refuses precisely ends up indistinguishable
 * from one that is broken.
 *
 * This lives beside the script runners rather than with the health monitor: the
 * defining property of a refusal is that it does NOT touch health state, and a
 * script author reaching for it should not have to import from `llm-health`.
 */
import {
  clipToCharacters,
  firstContentIndex,
  flattenUntrusted,
  withoutDanglingSurrogate,
} from './untrusted-text';

/**
 * Exit code half of the contract. The other half is `SCRIPT_REFUSAL_MARKER` on
 * stdout, and BOTH are required.
 *
 * An exit code alone cannot carry this meaning. 43 is `CURLE_BAD_FUNCTION_ARGUMENT`,
 * and a `set -e` script whose `curl` fails that way exits 43 without meaning
 * anything by it - that script is broken, its buyers should be told nothing
 * about their input, and its health gate must still flip. Demanding a marker
 * the script had to print keeps an accident on the failure path.
 *
 * 43 sits beside `SCRIPT_EXIT_BILLING_EXHAUSTED` and outside the same ranges:
 * 1-2 generic, 64-78 `sysexits.h`, 126-128 shell-internal, 130+ signals.
 */
export const SCRIPT_EXIT_REFUSED = 43;

/** What stdout must start with for exit 43 to mean a refusal. */
export const SCRIPT_REFUSAL_MARKER = 'ELISYM-REFUSAL:';

/** How much of a refusal reaches the customer - long enough for a sentence or three. */
export const SCRIPT_REFUSAL_MAX_CHARS = 400;

/**
 * Said when a script marks a refusal but states nothing after the marker.
 *
 * A fragment, not a sentence: the runtime prefixes every refusal with its own
 * label, and "The provider refused: The capability refused this request" says
 * the same thing twice with two nouns for one actor.
 */
export const SCRIPT_REFUSAL_UNSTATED = 'no reason was given.';

/** How much of a refusing script's stderr the error carries for the operator. */
export const SCRIPT_REFUSAL_STDERR_CHARS = 500;

/**
 * Cheap upper bound on what the cap can possibly need, measured from the first
 * real character rather than from the marker - a refusal padded with blank
 * lines is still a refusal, and cutting on raw offset would drop its sentence
 * and report that none was given.
 *
 * `runScript` captures up to a megabyte, and normalizing all of it to produce
 * 400 characters is work nobody asked for. Whitespace collapse and mark
 * stripping only ever shorten, so an 8x window over real content cannot change
 * the capped result.
 */
const SCAN_LIMIT = SCRIPT_REFUSAL_MAX_CHARS * 8;

/**
 * Where the reason begins, or -1 when this stdout is not a refusal at all.
 * Indexes rather than slices: stdout can be a megabyte, and neither the check
 * nor the message needs a copy of it.
 */
function reasonStart(stdout: string): number {
  const marker = firstContentIndex(stdout);
  if (marker === -1 || !stdout.startsWith(SCRIPT_REFUSAL_MARKER, marker)) {
    return -1;
  }
  return firstContentIndex(stdout, marker + SCRIPT_REFUSAL_MARKER.length);
}

/**
 * Whether this stdout claims to be a refusal. Leading whitespace is allowed so
 * a heredoc or an indented `echo` still counts; anything else is not a refusal,
 * whatever the exit code said.
 */
export function isRefusal(stdout: string): boolean {
  const marker = firstContentIndex(stdout);
  return marker !== -1 && stdout.startsWith(SCRIPT_REFUSAL_MARKER, marker);
}

/**
 * What the customer is allowed to read of a refusal.
 *
 * The provider chose to send this, so it crosses the trust boundary - but as
 * one plain paragraph and nothing else: `flattenUntrusted` drops the control
 * characters and format marks that could redraw a terminal or reverse a line,
 * and the result is capped by character so no half of one survives the cut.
 */
export function refusalMessage(stdout: string): string {
  const start = reasonStart(stdout);
  if (start === -1) {
    return SCRIPT_REFUSAL_UNSTATED;
  }
  const flattened = flattenUntrusted(
    withoutDanglingSurrogate(stdout.slice(start, start + SCAN_LIMIT)),
  );
  return flattened === ''
    ? SCRIPT_REFUSAL_UNSTATED
    : clipToCharacters(flattened, SCRIPT_REFUSAL_MAX_CHARS);
}

/**
 * Thrown when a script exits with `SCRIPT_EXIT_REFUSED` AND marked its stdout.
 *
 * Unlike `ScriptExecutionError`, `message` is the PROVIDER's own sentence rather
 * than a fixed summary, and it is meant to reach the customer - that is the
 * whole point of the exit code. `stderr` is the operator's half, kept separate
 * and already flattened and bounded: a caller logging it should not have to
 * know that the raw version can be a megabyte of terminal escapes.
 */
export class ScriptRefusalError extends Error {
  readonly exitCode: number;
  /** Flattened, single-line excerpt of the script's stderr. May be empty. */
  readonly stderr: string;

  constructor(exitCode: number, stdout: string, stderr: string) {
    super(refusalMessage(stdout));
    this.name = 'ScriptRefusalError';
    this.exitCode = exitCode;
    this.stderr = clipToCharacters(
      flattenUntrusted(withoutDanglingSurrogate(stderr.slice(0, SCAN_LIMIT))),
      SCRIPT_REFUSAL_STDERR_CHARS,
    );
  }
}

/**
 * Type guard by name rather than `instanceof`.
 *
 * The SDK builds each entry point as its own bundle (`splitting: false`), so a
 * class imported from `@elisym/sdk/llm-health` is a DIFFERENT class object from
 * the copy inside `@elisym/sdk/skills`, and `instanceof` across the two is
 * false however the source reads. Every consumer should use these guards.
 */
export function isScriptRefusalError(value: unknown): value is ScriptRefusalError {
  return value instanceof Error && value.name === 'ScriptRefusalError';
}
