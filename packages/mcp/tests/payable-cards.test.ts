/**
 * What this server is willing to SHOW, which is exactly what it can pay.
 *
 * The SDK reads EVM cards; this MCP pays on Solana only. A card it cannot pay
 * is worse than no card in a listing a model acts on, so discovery drops them
 * on the way out - and these rows are what hold that.
 */
import type { Agent, CapabilityCard } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { isPayableCard, withPayableCards } from '../src/payable-cards';

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
