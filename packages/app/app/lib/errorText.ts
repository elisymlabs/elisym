import { classifyJobError, excerptUntrusted, hasVisibleText } from '@elisym/sdk';
import { storedRefusal } from './refusal';

/**
 * What an unexplained failure may occupy on screen.
 *
 * The same budget as a refusal: an error from the wire is the same stranger's
 * text, and a paragraph is as much of one as a toast or an inline note can
 * carry without becoming the page.
 */
export const MAX_DISPLAYED_ERROR_CHARS = 400;

/** Said when the error carries nothing a reader could act on. */
export const UNSTATED_FAILURE = 'The job could not be completed.';

/**
 * One line of an error, fit to show a customer.
 *
 * EVERY surface that renders a buy-flow error goes through here. Most of these
 * strings are the app's own ("Insufficient balance"), but a job error can be
 * the provider's `error` feedback verbatim - unbounded, and free to carry the
 * control characters and direction overrides that turn one toast into
 * something that reads as the app speaking. Classifying it and then rendering
 * the raw string anyway, as the toast did, is the same bug as not classifying
 * it at all.
 */
export function customerErrorText(error: string): string {
  const kind = classifyJobError(error);
  if (kind === 'agent-unavailable') {
    return 'Agent unavailable. Try again later.';
  }
  if (kind === 'provider-refused') {
    return `The agent refused: ${storedRefusal(error)}`;
  }
  const excerpt = excerptUntrusted(error, MAX_DISPLAYED_ERROR_CHARS);
  return hasVisibleText(excerpt) ? excerpt : UNSTATED_FAILURE;
}
