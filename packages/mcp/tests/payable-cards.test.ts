/**
 * What this server is willing to SHOW, which is exactly what it can pay.
 *
 * The SDK reads EVM cards; this MCP pays on Solana only. A card it cannot pay
 * is worse than no card in a listing a model acts on, so discovery drops them
 * on the way out - and these rows are what hold that.
 */
import type { Agent, CapabilityCard } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { findAgentByNpub, isPayableCard, withPayableCards } from '../src/payable-cards.js';

const SOLANA_WALLET = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const EVM_WALLET = '0x0ed8e782415d51eb7192cf0fce9914a5ed23bce1';

function card(name: string, payment?: CapabilityCard['payment']): CapabilityCard {
  return { name, ...(payment === undefined ? {} : { payment }) } as CapabilityCard;
}

const SOLANA_CARD = card('solana-one', {
  chain: 'solana',
  network: 'mainnet',
  address: SOLANA_WALLET,
  job_price: 100_000,
} as NonNullable<CapabilityCard['payment']>);

const TEMPO_CARD = card('tempo-one', {
  chain: 'tempo',
  network: 'mainnet',
  address: EVM_WALLET,
  job_price: 100_000,
} as NonNullable<CapabilityCard['payment']>);

const FREE_CARD = card('free-one');

function agent(pubkey: string, cards: CapabilityCard[]): Agent {
  return { pubkey, npub: `npub1${pubkey}`, cards, eventId: 'e', supportedKinds: [], lastSeen: 1 };
}

describe('isPayableCard', () => {
  it('takes a Solana card', () => {
    expect(isPayableCard(SOLANA_CARD)).toBe(true);
  });

  it('refuses a card priced on another chain', () => {
    expect(isPayableCard(TEMPO_CARD)).toBe(false);
  });

  it('refuses a chain nobody here has heard of', () => {
    // An allow-list, not a list of chains to refuse: a rail the SDK learns
    // tomorrow is held until this server can pay it. Without this row the
    // whole rule could be inverted into `!== 'tempo'` and nothing would fail.
    expect(
      isPayableCard(
        card('mystery', {
          chain: 'bitcoin',
          network: 'mainnet',
          address: 'bc1q',
          job_price: 1,
        } as NonNullable<CapabilityCard['payment']>),
      ),
    ).toBe(false);
  });

  it('refuses a payment block whose chain is an empty string', () => {
    // Reachable: the parser only asks for a string, and a base58 address
    // passes the foreign-address rule beside it.
    expect(
      isPayableCard(
        card('blank', {
          chain: '',
          network: 'mainnet',
          address: SOLANA_WALLET,
          job_price: 1,
        } as NonNullable<CapabilityCard['payment']>),
      ),
    ).toBe(false);
  });

  it('takes a free card, whose absent payment block names no chain', () => {
    // Free is payable everywhere, and an absent block reads as Solana here the
    // same way it does in every other gate on this server.
    expect(isPayableCard(FREE_CARD)).toBe(true);
  });
});

describe('withPayableCards', () => {
  it('drops the cards this server cannot pay and keeps the rest', () => {
    const [kept] = withPayableCards([agent('a'.repeat(64), [SOLANA_CARD, TEMPO_CARD, FREE_CARD])]);
    expect(kept?.cards.map((c) => c.name)).toEqual(['solana-one', 'free-one']);
  });

  it('drops an agent whose cards were ALL dropped', () => {
    // Otherwise it lists as online with an empty capability list, which reads
    // as "offering nothing" rather than "offering something you cannot buy".
    expect(withPayableCards([agent('b'.repeat(64), [TEMPO_CARD])])).toEqual([]);
  });

  it('hands back the SAME agent object when nothing was dropped', () => {
    // A copy per agent on every discovery snapshot would be a needless churn
    // in the one path every listing tool goes through.
    const untouched = agent('c'.repeat(64), [SOLANA_CARD]);
    expect(withPayableCards([untouched])[0]).toBe(untouched);
  });

  it('does not mutate the agent it filters', () => {
    const mixed = agent('d'.repeat(64), [SOLANA_CARD, TEMPO_CARD]);
    withPayableCards([mixed]);
    expect(mixed.cards).toHaveLength(2);
  });
});

describe('findAgentByNpub', () => {
  it('finds an agent whose cards this server can pay', () => {
    const wanted = agent('e'.repeat(64), [SOLANA_CARD, TEMPO_CARD]);
    const found = findAgentByNpub([wanted], wanted.npub);
    expect(found).toMatchObject({ found: true });
    expect(found.found && found.agent.cards.map((c) => c.name)).toEqual(['solana-one']);
  });

  it('says an agent is ABSENT when the npub is on no card at all', () => {
    expect(findAgentByNpub([agent('f'.repeat(64), [SOLANA_CARD])], 'npub1nobody')).toEqual({
      found: false,
      reason: 'absent',
    });
  });

  it('says an agent has NOTHING PAYABLE rather than calling it absent', () => {
    // The distinction is the whole point: "not found" invites the model to
    // doubt an npub that just answered a ping, and the same filter keeps such
    // an agent out of search, so it cannot correct itself.
    const offRail = agent('a1'.repeat(32), [TEMPO_CARD]);
    expect(findAgentByNpub([offRail], offRail.npub)).toEqual({
      found: false,
      reason: 'nothing-payable',
    });
  });
});
