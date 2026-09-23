/**
 * Which cards this app can actually pay.
 *
 * The web catalog pays on Solana and nothing else yet: the wallet, the balance
 * reads and the whole `buy()` path are Solana. The SDK has read EVM cards
 * since the Tempo rail's phase 1, so such a card CAN reach the screen, and a
 * button that looks live would walk the buyer through connect, quote and sign
 * before anything could fail. A disabled button that says why is the honest
 * shape, and it is one rule so every send surface - Products, chat composer,
 * retry - reads the same answer.
 *
 * A card with no payment block is free and stays payable: an absent chain reads
 * as Solana, as it does in every other gate. A card that NAMES another chain is
 * held even at a price of zero - the buy path it would take has never run on
 * that rail.
 */

import type { CapabilityCard } from '@elisym/sdk';

/** The chains this app can settle a job on today. */
const WEB_PAYABLE_CHAINS = new Set(['solana']);

/** Is this card priced on a chain the web app cannot pay yet? */
export function paysOffSolana(card: Pick<CapabilityCard, 'payment'>): boolean {
  return !WEB_PAYABLE_CHAINS.has(card.payment?.chain ?? 'solana');
}

/**
 * What to tell the buyer, naming the chain only when it is one we know.
 *
 * `chain` is a field of an untrusted card, so it is never interpolated: a
 * known slug becomes a label, anything else stays "another chain".
 */
export function offSolanaTip(card: Pick<CapabilityCard, 'payment'>): string {
  const label = card.payment?.chain === 'tempo' ? 'Tempo' : 'another chain';
  return (
    `This capability is priced on ${label}, and the web app can only pay on Solana for now. ` +
    'Use the elisym CLI or MCP on a client that supports it.'
  );
}
