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

/** Said when a script marks a refusal but prints nothing after the marker. */
export const SCRIPT_REFUSAL_UNSTATED = 'The capability refused this request and gave no reason.';

/**
 * Cheap upper bound on what the cap can possibly need.
 *
 * `runScript` captures up to a megabyte, and normalizing all of it to produce
 * 400 characters is work nobody asked for. Whitespace collapse and mark
 * stripping only ever shorten, so a prefix this long can never change the
 * capped result - an 8x allowance covers a refusal padded with whitespace.
 */
const SCAN_LIMIT = SCRIPT_REFUSAL_MAX_CHARS * 8;

/**
 * Format characters: invisible, and survivors of control-stripping. The class
 * covers what a provider could reach for to make a line read as something other
 * than what it says - direction overrides and isolates, zero-width joiners, the
 * byte-order mark, the tag block used to smuggle text past a human reader.
 * Mirrors `flattenForOperator` in the CLI's x402 driver.
 */
const UNICODE_FORMAT_MARKS = /\p{Cf}/gu;

/** Every C0 and C1 control character becomes a space. */
function withoutControlCharacters(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }
  return out;
}

/**
 * Whether this stdout claims to be a refusal. Leading whitespace is allowed so
 * a heredoc or an indented `echo` still counts; anything else is not a refusal,
 * whatever the exit code said.
 */
export function isRefusal(stdout: string): boolean {
  return stdout.trimStart().startsWith(SCRIPT_REFUSAL_MARKER);
}

/**
 * What the customer is allowed to read of a refusal.
 *
 * The provider chose to send this, so it crosses the trust boundary - but as
 * one plain paragraph and nothing else. Control characters and Unicode format
 * marks (escape sequences, direction overrides, anything that could redraw a
 * terminal or forge a line in a log) are dropped, runs of whitespace collapse,
 * and the result is capped.
 *
 * The cap counts CHARACTERS, not UTF-16 code units: cutting by code unit splits
 * a surrogate pair whenever a refusal carries an emoji near the limit, and the
 * half that survives is not valid UTF-8 once the message is serialized into the
 * result event.
 */
export function refusalMessage(stdout: string): string {
  const marked = stdout.trimStart();
  const body = marked.startsWith(SCRIPT_REFUSAL_MARKER)
    ? marked.slice(SCRIPT_REFUSAL_MARKER.length)
    : marked;
  const flattened = withoutControlCharacters(body.slice(0, SCAN_LIMIT))
    .replace(UNICODE_FORMAT_MARKS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened === '') {
    return SCRIPT_REFUSAL_UNSTATED;
  }
  const characters = [...flattened];
  if (characters.length > SCRIPT_REFUSAL_MAX_CHARS) {
    return `${characters
      .slice(0, SCRIPT_REFUSAL_MAX_CHARS - 1)
      .join('')
      .trimEnd()}…`;
  }
  return flattened;
}

/**
 * Thrown when a script exits with `SCRIPT_EXIT_REFUSED` AND marked its stdout.
 *
 * Unlike `ScriptExecutionError`, `message` is the PROVIDER's own sentence rather
 * than a fixed summary, and it is meant to reach the customer - that is the
 * whole point of the exit code. The raw halves stay separate, as on
 * `ScriptBillingExhaustedError`, so a caller logging the operator's copy is not
 * handed a megabyte of unflattened stdout by accident.
 */
export class ScriptRefusalError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(exitCode: number, stdout: string, stderr: string) {
    super(refusalMessage(stdout));
    this.name = 'ScriptRefusalError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}
