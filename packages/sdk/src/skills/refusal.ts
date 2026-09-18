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
import { AGENT_REFUSED_LABEL, PROVIDER_REFUSED_PREFIX } from '../services/jobErrors';
import type { RefusalFileRead } from './refusal-file';
import {
  clipToCharacters,
  excerptOwnMessage,
  excerptUntrustedTail,
  hasVisibleText,
} from './untrusted-text';

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

/**
 * Told when something is at that path but the agent would not, or could not,
 * read it. Names the symlink case first: it is the one the channel REFUSES on
 * purpose, and an operator sent to check permissions would never find it.
 */
export const REFUSAL_UNREADABLE_HINT =
  `exit ${SCRIPT_EXIT_REFUSED} with a ${SCRIPT_REFUSAL_FILE_ENV} this agent would not read - a ` +
  'symlink or a directory rather than a regular file, or one it lacks permission for (or it ran ' +
  'out of descriptors) - so the customer was told nothing about their request:';

/**
 * Told when the agent could not give the script a file to write its reason to.
 *
 * Carried on the operator's half of a `ScriptRefusalError`, not on a failure: the
 * script's 43 was a decision, and the only thing lost is the sentence.
 */
export const REFUSAL_CHANNEL_MISSING_HINT =
  'this agent could not create a scratch file, so ELISYM_REFUSAL_FILE was never set and the ' +
  'script had nowhere to put its reason (check the temp directory):';

/** Told when a reason was written but the exit code says the script crashed. */
export const REFUSAL_WRONG_EXIT_HINT =
  `wrote a reason to ${SCRIPT_REFUSAL_FILE_ENV} and then exited non-zero with something other ` +
  `than ${SCRIPT_EXIT_REFUSED}, so this was handled as the crash the exit code describes and the ` +
  'customer was told nothing about their request - a refusal must exit 43 (or 0):';

/** All three arms, so none of them can be left out of a reader by accident. */
const REFUSAL_HINTS = [REFUSAL_CONTRACT_HINT, REFUSAL_UNREADABLE_HINT, REFUSAL_WRONG_EXIT_HINT];

/**
 * Whether this detail opens with one of the hints above.
 *
 * For DISPLAY only - which excerpt of a failure an operator is shown - never
 * for a decision. A script can print any of these sentences itself; all that
 * buys it is having its own output quoted from the front.
 */
export function startsWithRefusalHint(detail: string): boolean {
  return REFUSAL_HINTS.some((hint) => detail.startsWith(hint));
}

/**
 * How much of a reason is walked before the labels come off and the 400-character
 * clip lands.
 *
 * Exactly what the channel itself allows. `readRefusalFile` stops at
 * `SCRIPT_REFUSAL_FILE_MAX_BYTES`, and UTF-8 never decodes to more characters
 * than it has bytes, so no reason a SCRIPT can write is cut before its labels
 * are looked for - which is what keeps a cut from landing inside a label and
 * handing the customer half of one.
 *
 * The same function also runs in the browser on a wire string, where a provider
 * can publish hundreds of KB; that path is bounded by this window rather than
 * covered by it, and a run of labels longer than the whole channel survives as a
 * truncated fragment carrying the ellipsis, which no reader can mistake for the
 * app's own label.
 */
const REFUSAL_STRIP_WINDOW_CHARS = SCRIPT_REFUSAL_FILE_MAX_BYTES;

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
  // A script writing a LABEL gets it taken off - either the runtime's wire one
  // or the one clients print on screen. The label says who is speaking, the
  // runtime and the client put it there, and a doubled one reaches a reader as
  // the provider's own words wearing the app's voice.
  //
  // FLATTENED FIRST, then stripped, then clipped. `trimStart` alone is not
  // something to strip against: a NUL or an escape byte ahead of a label is not
  // whitespace, so `\u0001The provider refused: ...` walks past the test and a
  // later flatten turns it back into a clean forged label. Control characters
  // and deceptive marks must be gone BEFORE the label is looked for, which is
  // why the clip below must not flatten again.
  //
  // One loop over both labels, because `The agent refused: The provider refused:
  // ...` interleaves them and a pass per label leaves whichever came second; and
  // stripped before the clip, so the customer's 400 characters are spent on the
  // reason rather than on a label.
  // `excerptOwnMessage` FIRST, for the flatten: it windows a long input before
  // walking it - this function also runs on a wire string in the browser's
  // render path, where a provider can publish hundreds of KB - and it keeps the
  // fallback that finds a sentence sitting behind four thousand newlines, which
  // a plain front window would cut away.
  //
  // Wide enough to hold everything the CHANNEL can carry, not a little over the
  // 400: a script writing `'The provider refused: '.repeat(200)` and then its
  // real sentence would otherwise have the window cut inside the run of labels,
  // leaving half of one to strip against and throwing away the reason the
  // provider did write. The clip below is what enforces the real cap.
  let sentence = excerptOwnMessage(reason, REFUSAL_STRIP_WINDOW_CHARS);
  for (;;) {
    const stripped = withoutLeadingLabel(sentence);
    if (stripped === sentence) {
      break;
    }
    sentence = stripped;
  }
  // `clipToCharacters`, not an excerpt: the text is already flat, and flattening
  // it a second time is exactly what would bring back a label stripped above.
  // Bounded by character so a cut cannot leave half of one.
  //
  // No credential pass either, deliberately. Redaction is for text this runtime
  // SCRAPED - a script's stderr, an upstream's body - where a key appears
  // because someone printed it by accident. This sentence was written on
  // purpose, for this customer, and a refusal reading "set Authorization: Bearer
  // YOUR_VENUE_TOKEN first" is the whole point of the channel; gutting it to
  // "[redacted]" would leave the buyer with nothing to act on. The provider docs
  // carry the other half of that trade: never put a credential in a reason,
  // because this sentence is passed through as written, onto a public relay and
  // into the operator log.
  const excerpt = clipToCharacters(sentence, SCRIPT_REFUSAL_MAX_CHARS);
  // The cut marker does not count as something to read: a reason that clipped
  // down to nothing else would otherwise be handed over as the provider's
  // sentence, since `…` is a perfectly visible character.
  return hasVisibleText(excerpt.replace(/…/gu, '')) ? excerpt : SCRIPT_REFUSAL_UNSTATED;
}

/**
 * Whitespace and the two marks flattening deliberately keeps, neither of which
 * a reader can see.
 *
 * `flattenUntrusted` leaves zero-width joiners alone because they spell words in
 * Persian - so a script can put one in front of a label and, a joiner not being
 * whitespace, walk it past a plain `trimStart` while showing the customer a
 * forged label with no visible seam.
 */
const LEADING_UNSEEN = /^[\s\u200c\u200d]+/u;

/**
 * One label off the front, if one is there.
 *
 * Matched up to the colon and then past whatever separator follows, because
 * flattening cannot put back a space the script never typed: `The provider
 * refused:size it in USD.` is the same forgery as the spaced form. The caller
 * has already flattened, so what can sit in front of a label here is whitespace
 * and the two joiners `LEADING_UNSEEN` covers.
 */
function withoutLeadingLabel(sentence: string): string {
  // The caller has already flattened, so what can sit in front of a label here
  // is whitespace and those two joiners.
  const trimmed = sentence.replace(LEADING_UNSEEN, '');
  const lowered = trimmed.toLowerCase();
  for (const label of [PROVIDER_REFUSED_PREFIX, AGENT_REFUSED_LABEL]) {
    // Case-INSENSITIVELY: a skill author copying the label out of prose rather
    // than out of the constant writes `the provider refused:`, and an exact-case
    // test leaves it standing for the runtime to prefix a second one in front of.
    const anchor = label.trimEnd().toLowerCase();
    if (lowered.startsWith(anchor)) {
      return trimmed.slice(anchor.length).replace(LEADING_UNSEEN, '');
    }
  }
  return sentence;
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
  // One strip here, the rest inside: `refusalMessage` takes off any the PROVIDER
  // wrote, so a script that typed the label itself cannot have it rendered back
  // as part of its sentence.
  return refusalMessage(
    message.startsWith(PROVIDER_REFUSED_PREFIX)
      ? message.slice(PROVIDER_REFUSED_PREFIX.length)
      : message,
  );
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
    // The END of stderr, like every other operator-facing quote of it: the
    // diagnostic lands after whatever progress meter the script's curl printed.
    this.stderr = excerptUntrustedTail(stderr, SCRIPT_REFUSAL_STDERR_CHARS);
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
 * Which of a failed script's two streams gets quoted, in ONE place.
 *
 * stderr first, stdout only as a fallback, and a placeholder when a script died
 * silently - so an operator reading two lines about one job (a log entry and a
 * health-gate reason, say) is never shown two different streams and left to
 * guess which one the script actually complained on. Callers bound the result
 * to their own budget; a log line read once beside its job can afford more than
 * a reason re-printed on every gated job.
 *
 * Unbounded and unflattened on purpose: this is raw subprocess output, so every
 * caller must excerpt it before it reaches a log, a relay or a screen.
 */
export function scriptOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || '(no output)';
}

/**
 * The script's own output, bounded HERE rather than left for the log to clip.
 *
 * An operator log excerpts a long detail from its END, and the hint in front of
 * this - the line saying the contract was broken, or that this host could not
 * make a scratch file - would otherwise be erased by a chatty script's progress
 * meter.
 */
function describeOutput(
  result: { stdout: string; stderr: string },
  budget = SCRIPT_REFUSAL_STDERR_CHARS,
): string {
  return excerptUntrustedTail(scriptOutput(result), budget);
}

/**
 * Room left for the script's output once the hint in front of it is placed.
 *
 * `ScriptRefusalError` keeps the TAIL of whatever it is handed, at the full
 * budget - right for a bare stderr, wrong for a string whose first line is the
 * diagnosis. Bounding the output to what is left over means the hint is still
 * there after that second pass, so an operator whose script printed a progress
 * meter is still told the agent never offered it a channel.
 */
const CHANNEL_MISSING_OUTPUT_CHARS = Math.max(
  0,
  SCRIPT_REFUSAL_STDERR_CHARS - REFUSAL_CHANNEL_MISSING_HINT.length - 1,
);

/**
 * The refusal contract, for any script runner, in one place.
 *
 * A refusal is exit 43, or exit 0 with a reason written (a pipeline that
 * swallowed the 43). It is never a process the runtime KILLED (`code === null`):
 * a builder cut short by the execution timeout after writing its file decided
 * nothing, and reporting that as a deliberate refusal would be a lie. It is
 * never another non-zero exit either - that is the crash the code describes,
 * whatever the file says.
 *
 * Exit 43 with NO FILE AT ALL is a failure in every respect - the customer's
 * generic message, the operator log, the health gate - and treated as one
 * deliberately: 43 is also curl's `CURLE_BAD_FUNCTION_ARGUMENT`, so a script
 * that never meant to refuse lands here, and an exit code that exempted itself
 * from the breaker would be the one crash an agent could repeat forever while
 * taking payment. The hint is what separates a copy bug from a crash for the
 * operator.
 *
 * A file that IS there but says nothing readable is a different thing: the
 * script created it on purpose, so with exit 43 that is a refusal with
 * `SCRIPT_REFUSAL_UNSTATED` for a reason, and health is left alone.
 */
export function throwIfRefused(
  result: { code: number | null; stdout: string; stderr: string },
  file: RefusalFileRead,
  channelOffered = true,
): void {
  // `hasVisibleText`, not `!== ''`: a file holding one newline, a NUL or a
  // zero-width joiner is as empty as no bytes at all - the same question the
  // customer-facing message asks of the text it is about to hand over.
  const stated = file.state === 'read' && hasVisibleText(file.reason);
  // A process the runtime KILLED decided nothing: a builder cut short by the
  // execution timeout after writing its file is not a refusal, whatever the file
  // says.
  if (result.code === null) {
    return;
  }
  // Exit 43 is a refusal with or without a reason - an empty file still means
  // the script decided - and exit 0 with a reason is one too: `exit 43`
  // swallowed by a pipeline comes back as 0, and the script went out of its way
  // to write the sentence.
  if (result.code === SCRIPT_EXIT_REFUSED && file.state === 'read') {
    throw new ScriptRefusalError(result.code, file.reason, result.stderr);
  }
  // A 43 the agent had nowhere to record: the script decided, and this runner
  // could not make it a file to decide into. Still a REFUSAL - terminal, health
  // untouched, the customer told plainly that no reason was given - because
  // calling it a crash would charge them for a decision and gate the operator's
  // capability for a local disk problem. The operator's half carries the hint.
  if (result.code === SCRIPT_EXIT_REFUSED && !channelOffered) {
    throw new ScriptRefusalError(
      result.code,
      '',
      `${REFUSAL_CHANNEL_MISSING_HINT} ${describeOutput(result, CHANNEL_MISSING_OUTPUT_CHARS)}`,
    );
  }
  if (result.code === 0) {
    if (stated) {
      throw new ScriptRefusalError(result.code, file.reason, result.stderr);
    }
    return;
  }
  // Every other non-zero exit is the crash its code describes, reason or no
  // reason: a skill that validates its input early, writes why, and then falls
  // over further down has not refused. Reporting that as a decision would charge
  // the customer for a crash and - since a refusal deliberately leaves health
  // alone - let a chronically broken skill keep selling.
  if (result.code !== SCRIPT_EXIT_REFUSED && !stated) {
    return;
  }
  // Which hint depends on whose fault it was: a script that wrote a reason and
  // then crashed, one that never wrote the file, or a file the agent would not
  // read. Blaming the script for the last sends an operator hunting a typo in
  // code that is correct. (A runtime that could not make the file at all never
  // reaches here - that is a `HostScratchError` before the script runs.)
  let hint = REFUSAL_CONTRACT_HINT;
  if (stated) {
    hint = REFUSAL_WRONG_EXIT_HINT;
  } else if (file.state === 'unreadable') {
    hint = REFUSAL_UNREADABLE_HINT;
  }
  throw new ScriptExecutionError(
    result.code,
    `${hint} ${describeOutput(result)}`,
    undefined,
    result.stderr,
  );
}
