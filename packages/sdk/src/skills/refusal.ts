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
 * The reason travels OUT OF BAND, in the file named by `ELISYM_REFUSAL_FILE`,
 * exactly as a file result travels through `ELISYM_OUTPUT_FILE` and a metered
 * charge through `ELISYM_CHARGE_FILE`. Nothing a script prints can be a refusal,
 * which matters because stdout is frequently not the script's own words: an LLM
 * proxy echoes a model's completion, and a customer able to influence that
 * completion could otherwise destroy their own paid job and have their own
 * sentence handed back to them under the runtime's "The provider refused"
 * label. Writing a file is something a script does on purpose.
 *
 * This lives beside the script runners rather than with the health monitor: the
 * defining property of a refusal is that it does NOT touch health state, and a
 * script author reaching for it should not have to import from `llm-health`.
 */
import { ScriptExecutionError } from '../llm-health/types';
import { PROVIDER_REFUSED_PREFIX } from '../services/jobErrors';
import type { RefusalFileRead } from './refusal-file';
import { excerptUntrusted, flattenUntrusted, hasVisibleText } from './untrusted-text';

/**
 * The exit code that says "what I wrote in the refusal file is why".
 *
 * It is not what makes a refusal - the file is - but a refusing script should
 * still exit non-zero, and a dedicated code lets the runner tell an honoured
 * contract from a crash that happened to leave a file behind.
 *
 * 43 sits beside `SCRIPT_EXIT_BILLING_EXHAUSTED` and outside the same ranges:
 * 1-2 generic, 64-78 `sysexits.h`, 126-128 shell-internal, 130+ signals. It is
 * also `CURLE_BAD_FUNCTION_ARGUMENT`, which is one more reason the code alone
 * decides nothing.
 */
export const SCRIPT_EXIT_REFUSED = 43;

/** Environment variable naming the file a refusing script writes its reason to. */
export const SCRIPT_REFUSAL_FILE_ENV = 'ELISYM_REFUSAL_FILE';

/** How much of a refusal reaches the customer - long enough for a sentence or three. */
export const SCRIPT_REFUSAL_MAX_CHARS = 400;

/**
 * The most of the refusal file that is ever read into memory, in BYTES.
 *
 * Generous against the 400-character cap because flattening only shortens, and
 * bounded because a subprocess writes this file: a runaway script must not be
 * able to make the agent read an arbitrary amount of it.
 */
export const SCRIPT_REFUSAL_FILE_MAX_BYTES = 8 * 1024;

/**
 * Said when a script refuses but leaves the file empty.
 *
 * A fragment, not a sentence: the runtime prefixes every refusal with its own
 * label, and "The provider refused: The capability refused this request" says
 * the same thing twice with two nouns for one actor.
 */
export const SCRIPT_REFUSAL_UNSTATED = 'no reason was given.';

/** How much of a refusing script's stderr the error carries for the operator. */
export const SCRIPT_REFUSAL_STDERR_CHARS = 500;

/** Told to the operator when a script exits 43 without writing the file. */
export const REFUSAL_CONTRACT_HINT =
  `exit ${SCRIPT_EXIT_REFUSED} without writing ${SCRIPT_REFUSAL_FILE_ENV}, so this was handled as a ` +
  'failure rather than a refusal - the customer was told nothing about their request:';

/** Told when the file is there but the agent could not read it. */
export const REFUSAL_UNREADABLE_HINT =
  `exit ${SCRIPT_EXIT_REFUSED} with a ${SCRIPT_REFUSAL_FILE_ENV} this agent could not read ` +
  '(permissions, or too many open files), so the customer was told nothing about their request:';

/** Told instead when the runtime never gave the script a file to write. */
export const REFUSAL_CHANNEL_MISSING_HINT =
  `exit ${SCRIPT_EXIT_REFUSED}, but this agent could not create a scratch file, so ` +
  `${SCRIPT_REFUSAL_FILE_ENV} was never set and the script had nowhere to put its reason ` +
  '(check the temp directory):';

/**
 * Whether a written reason says anything a reader would SEE.
 *
 * Not `!== ''`: a file holding one newline, a NUL or a zero-width joiner is as
 * empty as no bytes at all, and this is the same question `refusalMessage` asks
 * of the text it is about to hand a customer.
 */
export function statesAReason(reason: string): boolean {
  return hasVisibleText(flattenUntrusted(reason));
}

/**
 * What the customer is allowed to read of a refusal.
 *
 * The provider chose to write this, so it crosses the trust boundary - but as
 * one plain paragraph and nothing else: `flattenUntrusted` drops the control
 * characters and deceptive format marks, and the result is capped by character
 * so no half of one survives the cut.
 *
 * Exported for the web app, which renders the same sentence from the wire and
 * must apply the same rule to it - a second copy of "excerpt, then fall back"
 * would be two caps to keep in step.
 */
export function refusalMessage(reason: string): string {
  const excerpt = excerptUntrusted(reason, SCRIPT_REFUSAL_MAX_CHARS);
  return statesAReason(excerpt) ? excerpt : SCRIPT_REFUSAL_UNSTATED;
}

/**
 * The same sentence, recovered from the wire on the customer's side.
 *
 * The runtime prefixes a refusal with `PROVIDER_REFUSED_PREFIX` so a client can
 * tell one from an outage; a client that goes on to RENDER it wants the
 * provider's words without the label, since its own surface already says who
 * refused. Here rather than in each client, because the label, the cap and the
 * fallback are one rule and every client would otherwise re-implement it.
 */
export function refusalFromJobError(message: string): string {
  const sentence = message.startsWith(PROVIDER_REFUSED_PREFIX)
    ? message.slice(PROVIDER_REFUSED_PREFIX.length)
    : message;
  return refusalMessage(sentence);
}

/**
 * Thrown when a script wrote a reason to `ELISYM_REFUSAL_FILE`.
 *
 * Unlike `ScriptExecutionError`, `message` is the PROVIDER's own sentence rather
 * than a fixed summary, and it is meant to reach the customer - that is the
 * whole point of the channel. `stderr` is the operator's half, kept separate and
 * already flattened and bounded: a caller logging it should not have to know
 * that the raw version can be a megabyte of terminal escapes.
 */
export class ScriptRefusalError extends Error {
  readonly exitCode: number | null;
  /** Flattened, single-line excerpt of the script's stderr. May be empty. */
  readonly stderr: string;

  constructor(exitCode: number | null, reason: string, stderr: string) {
    super(refusalMessage(reason));
    this.name = 'ScriptRefusalError';
    this.exitCode = exitCode;
    this.stderr = excerptUntrusted(stderr, SCRIPT_REFUSAL_STDERR_CHARS);
  }
}

/**
 * Type guard by name and shape rather than `instanceof`.
 *
 * The SDK builds each entry point as its own bundle (`splitting: false`), so a
 * class imported from `@elisym/sdk/llm-health` is a DIFFERENT class object from
 * the copy inside `@elisym/sdk/skills`, and `instanceof` across the two is
 * false however the source reads. Every consumer should use this.
 */
export function isScriptRefusalError(value: unknown): value is ScriptRefusalError {
  return (
    value instanceof Error &&
    value.name === 'ScriptRefusalError' &&
    typeof (value as ScriptRefusalError).stderr === 'string'
  );
}

/**
 * The refusal contract, for any script runner, in one place.
 *
 * A written reason is a refusal whatever the exit code says - the script went
 * out of its way to produce it - EXCEPT when the process was killed rather than
 * exited (`code === null`). A builder cut short by the execution timeout after
 * writing its file decided nothing, and reporting that to a customer as a
 * deliberate refusal would be a lie.
 *
 * Exit 43 with no reason is a failure, and the operator is told the contract was
 * not kept: a mistyped variable name otherwise looks exactly like a crash,
 * and the customer pays for "Internal processing error".
 */
export function throwIfRefused(
  result: { code: number | null; stdout: string; stderr: string },
  file: RefusalFileRead,
  channelOffered = true,
): void {
  if (file.state === 'read' && result.code !== null) {
    // A reason the script actually wrote is a refusal whatever the exit code
    // says. A file with nothing READABLE in it is only one when the script also
    // exited 43: opening the channel early (`: > "$ELISYM_REFUSAL_FILE"`) is a
    // common shape, and turning a finished, paid job into a refusal would throw
    // its answer away. `statesAReason`, because `echo >` leaves a newline and a
    // newline is no more a reason than no bytes at all.
    if (statesAReason(file.reason) || result.code === SCRIPT_EXIT_REFUSED) {
      throw new ScriptRefusalError(result.code, file.reason, result.stderr);
    }
  }
  if (result.code === SCRIPT_EXIT_REFUSED) {
    // Which hint depends on whose fault it was: a script that never wrote the
    // file, a file the agent could not read, or a runtime that never named one.
    // Blaming the script for the last two sends an operator hunting a typo in
    // code that is correct.
    let hint = REFUSAL_CONTRACT_HINT;
    // And so does the health gate. The slip exemption exists for a COPY BUG in
    // the skill - a mistyped variable name is no evidence about the operator's
    // API key. The other two are the HOST failing: no descriptors left, or a
    // temp directory it cannot write. An agent that can no longer make or read
    // its own scratch file is exactly what the breaker is for, so those keep
    // the ordinary gating and stop the agent selling jobs it cannot run.
    let contractSlip = true;
    if (!channelOffered) {
      hint = REFUSAL_CHANNEL_MISSING_HINT;
      contractSlip = false;
    } else if (file.state === 'unreadable') {
      hint = REFUSAL_UNREADABLE_HINT;
      contractSlip = false;
    }
    throw new ScriptExecutionError(
      result.code,
      `${hint} ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
      undefined,
      result.stderr,
      contractSlip,
    );
  }
}
