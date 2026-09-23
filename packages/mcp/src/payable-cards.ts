/**
 * The cards this server can actually pay for.
 *
 * The SDK has read EVM cards since the Tempo rail's phase 1, but this MCP pays
 * on Solana and nothing else: its wallet, its session limits, `send_payment`
 * and `buy_capability` are all Solana. A card it cannot pay is worse than no
 * card in a listing a model acts on - the model picks it, quotes a price
 * nobody here can settle, and the refusal arrives after the user has been
 * promised the work. So they are dropped on the way OUT of discovery, once,
 * rather than refused one surface at a time.
 *
 * A card with no payment block is free, and free is payable everywhere: the
 * chain of an absent block reads as `solana`, the same default the rest of the
 * server uses.
 *
 * This is temporary in the way the Tempo rail is unfinished, not in the way a
 * hack is: when the MCP grows an EVM wallet (phase 4), the filter is what
 * changes, and every listing follows it.
 */

import type { Agent, CapabilityCard } from '@elisym/sdk';

/** Can this server pay this card at all? */
export function isPayableCard(card: CapabilityCard): boolean {
  return (card.payment?.chain ?? 'solana') === 'solana';
}

/**
 * The same agents, carrying only the cards this server can pay, and without
 * the agents that are left with none.
 *
 * An agent whose cards were ALL dropped is dropped too: it would otherwise
 * appear in a search with an empty capability list, which reads as "online but
 * offering nothing" rather than "offering something you cannot buy here".
 */
export function withPayableCards(agents: readonly Agent[]): Agent[] {
  const kept: Agent[] = [];
  for (const agent of agents) {
    const cards = agent.cards.filter((card) => isPayableCard(card));
    if (cards.length === 0) {
      continue;
    }
    kept.push(cards.length === agent.cards.length ? agent : { ...agent, cards });
  }
  return kept;
}
