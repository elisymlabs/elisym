import {
  classifyJobError,
  excerptUntrusted,
  hasVisibleText,
  refusalFromJobError,
} from '@elisym/sdk';

/**
 * What an unexplained failure may occupy on screen.
 *
 * The same budget as a refusal: an error from the wire is the same stranger's
 * text, and a paragraph is as much of one as a toast or an inline note can
 * carry without becoming the page.
 */
export const MAX_DISPLAYED_ERROR_CHARS = 400;

/**
 * How a refusal is introduced wherever one is shown.
 *
 * One constant, because two surfaces say it: the failed bubble in the thread
 * and this module's own line. The sentence after it is the AGENT's and the
 * label is the app's, so it has to be unmistakably ours.
 */
export const AGENT_REFUSED_LABEL = 'The agent refused: ';

/** Said when the error carries nothing a reader could act on. */
export const UNSTATED_FAILURE = 'The job could not be completed.';

/**
 * One line of an error, whoever wrote it.
 *
 * Nothing here interprets the string - it only refuses to paint an unbounded
 * one, or one carrying the control characters and direction overrides that
 * make a line read as something other than what it says. Use this for an error
 * the app itself produced (a wallet rejection, an RPC failure): those are not
 * job verdicts, and classifying them would answer "insufficient SOL" with
 * "Agent unavailable".
 */
export function boundedErrorText(error: string): string {
  const excerpt = excerptUntrusted(error, MAX_DISPLAYED_ERROR_CHARS);
  return hasVisibleText(excerpt) ? excerpt : UNSTATED_FAILURE;
}

/**
 * The same, for an error that came back from a JOB.
 *
 * Every surface that renders one goes through here. The string may be the
 * provider's `error` feedback verbatim - a stranger's text, unbounded - so
 * classifying it and then rendering the raw version anyway, as the toast did,
 * is the same bug as not classifying it at all.
 */
export function customerErrorText(error: string): string {
  const kind = classifyJobError(error);
  if (kind === 'agent-unavailable') {
    return 'Agent unavailable. Try again later.';
  }
  if (kind === 'provider-refused') {
    return `${AGENT_REFUSED_LABEL}${refusalFromJobError(error)}`;
  }
  return boundedErrorText(error);
}
