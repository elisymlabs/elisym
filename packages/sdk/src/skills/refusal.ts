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
import { ScriptExecutionError } from '../llm-health/types';
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

/** Told to the operator when a script exits 43 without marking its stdout. */
export const UNMARKED_REFUSAL_HINT =
  `exit ${SCRIPT_EXIT_REFUSED} without a leading "${SCRIPT_REFUSAL_MARKER}" line on stdout, ` +
  'so this was handled as a failure rather than a refusal - the customer was told nothing about their request:';

/** How much of a refusing script's stderr the error carries for the operator. */
export const SCRIPT_REFUSAL_STDERR_CHARS = 500;

/**
 * How much of the refusal line is read.
 *
 * `runScript` captures up to a megabyte, and normalizing all of it to produce
 * 400 characters is work nobody asked for. The window is measured from the
 * first real character after the marker, so blank padding before the sentence
 * costs nothing - padding INSIDE it still counts, and a refusal that spends
 * 3200 characters on whitespace and prose gets the first 400 characters' worth
 * of what it said, not a "no reason given".
 */
const SCAN_LIMIT = SCRIPT_REFUSAL_MAX_CHARS * 8;

/**
 * Where the marker ends, or -1 when this stdout is not a refusal at all.
 *
 * Returns an index rather than a slice so the runners can decide and the error
 * can build its message from one scan of what may be a megabyte of stdout.
 */
export function refusalMarkerEnd(stdout: string): number {
  const marker = firstContentIndex(stdout);
  if (marker === -1 || !stdout.startsWith(SCRIPT_REFUSAL_MARKER, marker)) {
    return -1;
  }
  return marker + SCRIPT_REFUSAL_MARKER.length;
}

/**
 * Whether this stdout claims to be a refusal. Leading whitespace is allowed so
 * a heredoc or an indented `echo` still counts; anything else is not a refusal,
 * whatever the exit code said.
 */
export function isRefusal(stdout: string): boolean {
  return refusalMarkerEnd(stdout) !== -1;
}

/**
 * What the customer is allowed to read of a refusal: the rest of the MARKER'S
 * LINE, and nothing after it.
 *
 * Stopping at the newline is the part that matters. A script's stdout is not
 * written for a stranger - the line after the refusal is as likely to be a
 * debug dump with an internal hostname in it as anything else - and a contract
 * that forwards "everything after the marker" invites exactly that. One line is
 * also what the documentation can state without qualification.
 *
 * Within that line the provider chose to send this, so it crosses the trust
 * boundary - but as one plain paragraph and nothing else: `flattenUntrusted`
 * drops the control characters and deceptive format marks, and the result is
 * capped by character so no half of one survives the cut.
 */
export function refusalMessage(stdout: string, markerEnd = refusalMarkerEnd(stdout)): string {
  if (markerEnd === -1) {
    return SCRIPT_REFUSAL_UNSTATED;
  }
  const start = firstContentIndex(stdout, markerEnd);
  const lineEnd = stdout.indexOf('\n', markerEnd);
  if (start === -1 || (lineEnd !== -1 && start > lineEnd)) {
    return SCRIPT_REFUSAL_UNSTATED;
  }
  const end = Math.min(lineEnd === -1 ? stdout.length : lineEnd, start + SCAN_LIMIT);
  const flattened = flattenUntrusted(withoutDanglingSurrogate(stdout.slice(start, end)));
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

  constructor(exitCode: number, stdout: string, stderr: string, markerEnd?: number) {
    super(refusalMessage(stdout, markerEnd));
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
  return (
    value instanceof Error &&
    value.name === 'ScriptRefusalError' &&
    typeof (value as ScriptRefusalError).stderr === 'string'
  );
}

/**
 * The refusal contract, enforced in both directions, for any script runner.
 *
 * Exit 43 without the marker is a failure - 43 is also what a `set -eu` script
 * inherits from a failed `curl` - and the operator gets a hint on the error's
 * operator-side detail, because a mistyped marker otherwise looks exactly like
 * a crash and the buyer is charged for "Internal processing error".
 *
 * The MARKER without exit 43 is a refusal too. A script that prints it and then
 * exits 0 (its `exit 43` behind a pipeline that reset `$?`, say) would otherwise
 * have `ELISYM-REFUSAL: ...` delivered to the buyer as the thing they paid for.
 */
export function throwIfRefused(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): void {
  const markerEnd = refusalMarkerEnd(result.stdout);
  if (markerEnd !== -1) {
    throw new ScriptRefusalError(
      result.code ?? SCRIPT_EXIT_REFUSED,
      result.stdout,
      result.stderr,
      markerEnd,
    );
  }
  if (result.code === SCRIPT_EXIT_REFUSED) {
    throw new ScriptExecutionError(
      result.code,
      `${UNMARKED_REFUSAL_HINT} ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    );
  }
}
