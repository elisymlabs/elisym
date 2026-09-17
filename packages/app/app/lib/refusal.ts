import {
  excerptUntrusted,
  hasVisibleText,
  PROVIDER_REFUSED_PREFIX,
  SCRIPT_REFUSAL_MAX_CHARS,
} from '@elisym/sdk';

/**
 * What a refusal is allowed to occupy in the thread store.
 *
 * The runtime's own cap, so the two move together - and a provider running
 * anything else is bounded here, where the thread keeps 500 entries per agent
 * in IndexedDB.
 */
export const MAX_STORED_REFUSAL_CHARS = SCRIPT_REFUSAL_MAX_CHARS;

/** Shown when an agent says it refused and gives nothing to act on. */
export const UNSTATED_REFUSAL = 'The agent gave no reason.';

/**
 * The provider's sentence, ready to store and render.
 *
 * The runtime's label is stripped: it is what `classifyJobError` matched on, and
 * repeating it inside a failed bubble says "refused" twice. `excerptUntrusted`
 * rather than `slice` because the text is a stranger's - the budget counts
 * characters, so a cut cannot leave half of one in IndexedDB.
 */
export function storedRefusal(message: string): string {
  const sentence = message.startsWith(PROVIDER_REFUSED_PREFIX)
    ? message.slice(PROVIDER_REFUSED_PREFIX.length)
    : message;
  const excerpt = excerptUntrusted(sentence, MAX_STORED_REFUSAL_CHARS);
  // `hasVisibleText`, not `!== ''`: a sentence of zero-width joiners survives
  // flattening (they spell words in Persian) and would render as a blank bubble
  // with the Retry button already withheld.
  return hasVisibleText(excerpt) ? excerpt : UNSTATED_REFUSAL;
}
