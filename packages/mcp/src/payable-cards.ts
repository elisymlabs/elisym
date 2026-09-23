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
 * A card with no payment block is free and stays: the chain of an absent block
 * reads as `solana`, the same default the rest of the server uses. A card that
 * NAMES another chain is dropped even at a price of zero - nothing on that rail
 * has been exercised end to end here, and a zero price is not a reason to send
 * a job somewhere this server cannot follow it.
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
 *
 * That is right for a LISTING and wrong for a lookup by npub: "not found on
 * the network" about an agent that just answered a ping is a lie the model
 * cannot recover from, because the same filter keeps it out of search too. A
 * by-npub caller uses `findAgentByNpub` below instead.
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

/** What a lookup by npub found, and whether this server can buy from it. */
export type AgentLookup =
  | { found: true; agent: Agent }
  | { found: false; reason: 'absent' | 'nothing-payable' };

/**
 * One agent by npub, told apart from an agent this server merely cannot pay.
 *
 * The distinction is the whole point: "not found" invites the model to doubt
 * the npub and try again, which is useless advice about a provider that is
 * online and simply prices its work on a chain this server has no wallet for.
 */
export function findAgentByNpub(agents: readonly Agent[], npub: string): AgentLookup {
  const agent = agents.find((candidate) => candidate.npub === npub);
  if (agent === undefined) {
    return { found: false, reason: 'absent' };
  }
  const cards = agent.cards.filter((card) => isPayableCard(card));
  return cards.length === 0
    ? { found: false, reason: 'nothing-payable' }
    : { found: true, agent: cards.length === agent.cards.length ? agent : { ...agent, cards } };
}
