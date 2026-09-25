import {
  buildPaytoEvent,
  buildProductEvent,
  buildStoreAuthEvent,
  buildStoreProfileEvent,
  encodeProductNaddr,
} from '@elisym/commerce';
import { getBase58Decoder } from '@solana/kit';
import { type EventTemplate, type Filter, type NostrEvent, matchFilter } from 'nostr-tools';
// Signed with `pure`: its verdict cache is the one `isGenuineEvent` must not trust.
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { PublishResult, RelayClient } from '../src/core/relay-client';

export const USDC_DEVNET_CAIP19 =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const T0 = 1_750_000_000;
export const DAY = 24 * 60 * 60;
export const NOW = T0 + 10 * DAY;
export const D = 'course-101';

export interface NostrKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function nostrKey(): NostrKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function sign(template: EventTemplate, key: NostrKey): NostrEvent {
  return finalizeEvent(template, key.secretKey);
}

export function solanaAddress(): string {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface Shop {
  owner: NostrKey;
  store: NostrKey;
  payout: string;
  events: NostrEvent[];
  naddr: string;
}

export function makeShop(
  options: { nip05?: string; paytoCreatedAt?: number; hints?: string[]; price?: string } = {},
): Shop {
  const owner = nostrKey();
  const store = nostrKey();
  const payout = solanaAddress();
  const events = [
    sign(
      buildProductEvent({
        d: D,
        title: 'Agents 101',
        description: 'Twelve lessons.',
        price: { amount: options.price ?? '49', currency: 'USD' },
        accept: [USDC_DEVNET_CAIP19],
        createdAt: T0,
      }),
      store,
    ),
    sign(
      buildStoreProfileEvent({
        name: 'Shop',
        ownerPubkey: owner.pubkey,
        createdAt: T0,
        ...(options.nip05 === undefined ? {} : { nip05: options.nip05 }),
      }),
      store,
    ),
    sign(
      buildPaytoEvent({
        ownerPubkey: owner.pubkey,
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: payout }],
        createdAt: options.paytoCreatedAt ?? T0,
      }),
      owner,
    ),
    sign(
      buildStoreAuthEvent({ storePubkey: store.pubkey, mode: 'self-host', createdAt: T0 }),
      owner,
    ),
  ];
  return {
    owner,
    store,
    payout,
    events,
    naddr: encodeProductNaddr({ storePubkey: store.pubkey, d: D }, options.hints ?? []),
  };
}

/** Relays in memory: every relay holds the same events unless a test says otherwise. */
export class MemoryRelays implements RelayClient {
  queried: string[][] = [];
  published: { relays: string[]; event: NostrEvent }[] = [];

  constructor(
    private readonly events: NostrEvent[],
    private readonly refuse: readonly string[] = [],
  ) {}

  async query(relays: readonly string[], filters: readonly Filter[]): Promise<NostrEvent[]> {
    this.queried.push([...relays]);
    return this.events.filter((event) => filters.some((filter) => matchFilter(filter, event)));
  }

  async publish(relays: readonly string[], event: NostrEvent): Promise<PublishResult> {
    this.published.push({ relays: [...relays], event });
    return {
      accepted: relays.filter((relay) => !this.refuse.includes(relay)),
      failed: relays
        .filter((relay) => this.refuse.includes(relay))
        .map((relay) => ({ relay, reason: 'blocked: test' })),
    };
  }

  close(): void {}
}
