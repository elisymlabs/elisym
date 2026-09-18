import {
  AGENT_REFUSED_LABEL,
  classifyJobError,
  excerptOwnMessage,
  hasVisibleText,
  PROVIDER_FAILED_MESSAGE,
  refusalFromJobError,
  SCRIPT_REFUSAL_MAX_CHARS,
  type JobErrorKind,
} from '@elisym/sdk';
import { LEGACY_INTERNAL_MASK } from './heldPaymentNote';

/**
 * What an unexplained failure may occupy on screen.
 *
 * THE refusal budget, not a copy of its number: an error from the wire is the
 * same stranger's text, and a paragraph is as much of one as a toast or an
 * inline note can carry without becoming the page. Raising one raises both.
 */
export const MAX_DISPLAYED_ERROR_CHARS = SCRIPT_REFUSAL_MAX_CHARS;

/**
 * How a refusal is introduced wherever one is shown.
 *
 * Re-exported from the SDK, which owns it beside the wire label so the two
 * cannot drift into two names for one actor - and so the SDK can strip this one
 * too, for a skill author who read the app and wrote it into their reason file.
 * "Agent", not "provider": a buyer here has only ever seen the word agent, on
 * the page they are standing on.
 */
export { AGENT_REFUSED_LABEL };

/**
 * Said when the error carries nothing a reader could act on.
 *
 * Deliberately NOT a near-copy of the runtime's own crash sentence ("The agent
 * could not complete this job."), which carries different advice about the
 * money: two sentences a glance cannot tell apart would hand the same reader
 * opposite guidance about a paid job.
 */
export const UNSTATED_FAILURE = 'The agent sent an error with nothing readable in it.';

/**
 * The same, for a failure the AGENT never saw.
 *
 * Several Solana wallet adapters throw an empty message when someone cancels a
 * signature, so this is the common case rather than an edge one - and blaming
 * the agent for it, as the sentence above would, is simply false.
 */
export const UNSTATED_LOCAL_FAILURE = 'The request could not be completed.';

/**
 * One line of an error, whoever wrote it.
 *
 * Nothing here interprets the string - it only refuses to paint an unbounded
 * one, or one carrying the control characters and direction overrides that make
 * a line read as something other than what it says.
 *
 * Two callers, both deliberate. An error the APP produced (a wallet rejection,
 * an RPC failure) is not a job verdict, and classifying it would answer
 * "insufficient SOL" with "Agent unavailable". A job error the classifier could
 * not place is a provider's own free text, and it comes here for the same reason
 * a refusal does: no credential pass, because the sentence is meant to be acted
 * on and redaction eats the half that says what to do. What a script PRINTED is
 * a different matter and is redacted at the source, in the runtime.
 */
export function boundedErrorText(error: string, fallback = UNSTATED_LOCAL_FAILURE): string {
  // `excerptOwnMessage`: no credential redaction. A wallet or RPC sentence
  // mentioning a token or an authorization header is the app's own words to the
  // person who caused it, and redacting it would eat the informative half.
  const excerpt = excerptOwnMessage(error, MAX_DISPLAYED_ERROR_CHARS);
  return hasVisibleText(excerpt) ? excerpt : fallback;
}

/**
 * The same, for an error that came back from a JOB.
 *
 * Every surface that renders one goes through here. The string may be the
 * provider's `error` feedback verbatim - a stranger's text, unbounded - so
 * classifying it and then rendering the raw version anyway, as the toast did,
 * is the same bug as not classifying it at all.
 */
export function customerErrorText(error: string, known?: JobErrorKind): string {
  // `known` for a caller that has already classified this string: three modules
  // render one error together, and three passes over the marker list are three
  // places that can drift about what `provider-refused` means.
  const kind = known ?? classifyJobError(error);
  if (kind === 'agent-unavailable') {
    return 'Agent unavailable. Try again later.';
  }
  if (kind === 'provider-refused') {
    return `${AGENT_REFUSED_LABEL}${refusalFromJobError(error)}`;
  }
  // The sentence agents sent before the runtime had one of its own. It means the
  // same thing, and `heldPaymentNote` already answers it the same way, so it
  // should not be the one error a buyer reads as internal jargon.
  if (error === LEGACY_INTERNAL_MASK) {
    return PROVIDER_FAILED_MESSAGE;
  }
  // A job error with nothing readable in it DID come from the agent.
  return boundedErrorText(error, UNSTATED_FAILURE);
}
