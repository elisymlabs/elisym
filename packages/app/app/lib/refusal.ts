import { excerptUntrusted, PROVIDER_REFUSED_PREFIX } from '@elisym/sdk';

/**
 * What a refusal is allowed to occupy in the thread store.
 *
 * The runtime caps its own at 400 characters, but only a provider running that
 * build does - and the thread keeps 500 entries per agent in IndexedDB.
 */
export const MAX_STORED_REFUSAL_CHARS = 400;

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
  return excerptUntrusted(sentence, MAX_STORED_REFUSAL_CHARS);
}
