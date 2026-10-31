/**
 * What a merchant pastes into their page for one product: the buy tag naming
 * the product's naddr, and the pinned checkout loader with its integrity hash.
 * A direct merchant gets `<elisym-buy>` and pay.elisym.network's v3 (the same
 * one the React wrapper loads); a partner's merchant gets the partner hostname's
 * v4 and its neutral `<pay-buy>`.
 */
import { encodeProductNaddr } from '@elisym/commerce';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '@elisym/react/constants';
import type { CheckoutLoader } from './settings';

/** The runbook an AI agent follows to install the buttons (and to set a store up). */
export const AGENT_RUNBOOK_URL = 'https://docs.elisym.network/commerce/cloud-agents';

/** The product names the cloud takes (a PRODUCT.md directory): lowercase letters, digits, dashes. */
export const PRODUCT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A new product's PRODUCT.md: the merchant fills in its title, price and description. */
export const NEW_PRODUCT = '---\ntitle: \npriceUsd: "10"\n---\n\nWhat the buyer pays for.\n';

/** One product's buy button: the tag naming its naddr, on this network. */
export function buyTag(
  storePubkey: string,
  product: string,
  relayHints: readonly string[],
  network: string,
  loader?: CheckoutLoader,
): string {
  const naddr = encodeProductNaddr({ storePubkey, d: product }, [...relayHints]);
  const tag = loader === undefined ? 'elisym-buy' : 'pay-buy';
  return `<${tag} product="${naddr}" network="${network}"></${tag}>`;
}

/** The pinned checkout loader, included once per page whatever the number of buttons. */
export function loaderScript(loader?: CheckoutLoader): string {
  return [
    '<script',
    `  src="${loader?.src ?? V3_LOADER_SRC}"`,
    `  integrity="${loader?.integrity ?? V3_LOADER_INTEGRITY}"`,
    '  crossorigin="anonymous"',
    '></script>',
  ].join('\n');
}

/** The HTML snippet for a product of this store, on this network: its button and the loader. */
export function productSnippet(
  storePubkey: string,
  product: string,
  relayHints: readonly string[],
  network: string,
  loader?: CheckoutLoader,
): string {
  return [buyTag(storePubkey, product, relayHints, network, loader), loaderScript(loader)].join(
    '\n',
  );
}
