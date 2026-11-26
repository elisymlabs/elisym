import { ASKR_API_BASE } from '@elisym/askr';

/**
 * The `llms.txt` a merchant puts at their site's root, so an AI agent
 * visiting the site learns the store's assistant is Askr and where its
 * products and policies are, read without a chat. The CLI's `askr embed`
 * prints the same text (`packages/cli/src/commands/askr/llms-txt.ts`): a test
 * keeps the two equal.
 */

/** The page the site's llms.txt names as its shopping assistant. */
export const ASKR_SITE_URL = 'https://askr.elisym.network';
const STORE_FILES_BASE = `${ASKR_API_BASE}/s`;

/** The store's own llms.txt on the Askr server: every product and policy, read-only. */
export function storeLlmsTxtUrl(npub: string): string {
  return `${STORE_FILES_BASE}/${npub}/llms.txt`;
}

export function storeCatalogJsonUrl(npub: string): string {
  return `${STORE_FILES_BASE}/${npub}/catalog.json`;
}

/** The store name as one line of a heading. */
function headingName(name: string): string {
  const line = name
    .replace(/\s+/gu, ' ')
    .replace(/^[#\s]+/u, '')
    .trim();
  return line === '' ? 'This store' : line;
}

/** The Askr part alone, from its heading on: what is appended to a site's own llms.txt. */
export function siteLlmsTxtSection(npub: string): string {
  return [
    '## Shopping assistant',
    '',
    `- [Products and policies for AI agents](${storeLlmsTxtUrl(npub)}): every product with its price and page, and the store's policies, read-only`,
    `- [Catalog as JSON](${storeCatalogJsonUrl(npub)}): the same, machine-readable`,
    `- [Askr](${ASKR_SITE_URL}): the shopping assistant this store uses. Purchases happen on this site.`,
    '',
  ].join('\n');
}

/** The whole file, for a site that has no llms.txt yet. */
export function siteLlmsTxt(npub: string, storeName: string): string {
  const name = headingName(storeName);
  return [
    `# ${name}`,
    '',
    `> ${name} has a shopping assistant, Askr: the chat on every page of this site answers questions about products, prices and policies.`,
    '',
    siteLlmsTxtSection(npub),
  ].join('\n');
}
