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
import { readFile, stat } from 'node:fs/promises';
import { ScriptExecutionError } from '../llm-health/types';
import { clipToCharacters, flattenUntrusted, withoutDanglingSurrogate } from './untrusted-text';

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
 * The most of the refusal file that is ever read into memory.
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

/**
 * What the customer is allowed to read of a refusal.
 *
 * The provider chose to write this, so it crosses the trust boundary - but as
 * one plain paragraph and nothing else: `flattenUntrusted` drops the control
 * characters and deceptive format marks, and the result is capped by character
 * so no half of one survives the cut.
 */
export function refusalMessage(reason: string): string {
  const flattened = flattenUntrusted(withoutDanglingSurrogate(reason));
  return flattened === ''
    ? SCRIPT_REFUSAL_UNSTATED
    : clipToCharacters(flattened, SCRIPT_REFUSAL_MAX_CHARS);
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
    this.stderr = clipToCharacters(
      flattenUntrusted(withoutDanglingSurrogate(stderr.slice(0, SCRIPT_REFUSAL_STDERR_CHARS * 8))),
      SCRIPT_REFUSAL_STDERR_CHARS,
    );
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
 * Read what a script wrote to `ELISYM_REFUSAL_FILE`, or `undefined` for "it did
 * not refuse".
 *
 * Adoption rule as elsewhere in this package: the path must exist, be a regular
 * file and be non-empty. Anything unreadable is treated as no refusal rather
 * than as an empty one - a refusal the runtime invented would be worse than a
 * job that simply failed.
 */
export async function readRefusalFile(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile() || info.size === 0) {
    return undefined;
  }
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return undefined;
  }
  return raw.slice(0, SCRIPT_REFUSAL_FILE_MAX_BYTES);
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
  reason: string | undefined,
): void {
  if (reason !== undefined && result.code !== null) {
    throw new ScriptRefusalError(result.code, reason, result.stderr);
  }
  if (result.code === SCRIPT_EXIT_REFUSED) {
    throw new ScriptExecutionError(
      result.code,
      `${REFUSAL_CONTRACT_HINT} ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    );
  }
}
