import { PROVIDER_REFUSED_PREFIX, refusalMessage, SCRIPT_REFUSAL_MAX_CHARS } from '@elisym/sdk';

/**
 * What a refusal is allowed to occupy in the thread store.
 *
 * The runtime's own cap, so the two move together - and a provider running
 * anything else is bounded here, where the thread keeps 500 entries per agent
 * in IndexedDB.
 */
export const MAX_STORED_REFUSAL_CHARS = SCRIPT_REFUSAL_MAX_CHARS;

/**
 * The provider's sentence, ready to store and render.
 *
 * The runtime's label is stripped: it is what `classifyJobError` matched on, and
 * repeating it inside a failed bubble says "refused" twice. What is left goes
 * through the runtime's own rule, applied by the runtime's own function -
 * flatten, cap by character so a cut cannot leave half of one in IndexedDB, and
 * say so when nothing readable survives. Its "no reason was given." is written
 * to follow a label, which is exactly what both surfaces here put in front of
 * it.
 */
export function storedRefusal(message: string): string {
  const sentence = message.startsWith(PROVIDER_REFUSED_PREFIX)
    ? message.slice(PROVIDER_REFUSED_PREFIX.length)
    : message;
  return refusalMessage(sentence);
}
