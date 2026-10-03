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
import type { PublishResult, QueryOptions, RelayClient } from '../../src/buyer/relay-client';

export const USDC_DEVNET_CAIP19 =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const USDC_MAINNET_CAIP19 =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
  options: {
    nip05?: string;
    paytoCreatedAt?: number;
    hints?: string[];
    price?: string;
    caip19?: string;
    /** The payout address (a Tempo payout needs an EVM one). */
    payout?: string;
  } = {},
): Shop {
  const owner = nostrKey();
  const store = nostrKey();
  const payout = options.payout ?? solanaAddress();
  const events = [
    sign(
      buildProductEvent({
        d: D,
        title: 'Agents 101',
        description: 'Twelve lessons.',
        price: { amount: options.price ?? '49', currency: 'USD' },
        accept: [options.caip19 ?? USDC_DEVNET_CAIP19],
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
        accept: [{ caip19: options.caip19 ?? USDC_DEVNET_CAIP19, address: payout }],
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

/** The store's inbox list (kind 10050), signed by the store key. */
export function inboxList(store: NostrKey, relays: string[], createdAt = NOW - 10): NostrEvent {
  return sign(
    {
      kind: 10050,
      created_at: createdAt,
      tags: relays.map((relay) => ['relay', relay]),
      content: '',
    },
    store,
  );
}

/** Relays in memory: every relay holds the same events unless a test says otherwise. */
export class MemoryRelays implements RelayClient {
  queried: string[][] = [];
  /** Whether each query asked to pass by unreachable relays. */
  skipped: boolean[] = [];
  published: { relays: string[]; event: NostrEvent }[] = [];

  constructor(
    private readonly events: NostrEvent[],
    /** Relays that refuse a publish; a test may change it. */
    public refuse: string[] = [],
  ) {}

  async query(
    relays: readonly string[],
    filters: readonly Filter[],
    options: QueryOptions = {},
  ): Promise<NostrEvent[]> {
    this.queried.push([...relays]);
    this.skipped.push(options.skipUnreachable === true);
    return this.events.filter((event) => filters.some((filter) => matchFilter(filter, event)));
  }

  listeners: { relays: string[]; filter: Filter; onEvent: (event: NostrEvent) => void }[] = [];

  /** Stored events that match, then whatever is published to a listened relay later. */
  subscribe(relays: readonly string[], filter: Filter, onEvent: (event: NostrEvent) => void) {
    const listener = { relays: [...relays], filter, onEvent };
    this.listeners.push(listener);
    for (const event of this.events.filter((stored) => matchFilter(filter, stored))) {
      onEvent(event);
    }
    return {
      close: () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      },
    };
  }

  async publish(relays: readonly string[], event: NostrEvent): Promise<PublishResult> {
    this.published.push({ relays: [...relays], event });
    const accepted = relays.filter((relay) => !this.refuse.includes(relay));
    if (accepted.length > 0) {
      this.events.push(event);
      for (const listener of this.listeners) {
        if (
          listener.relays.some((relay) => accepted.includes(relay)) &&
          matchFilter(listener.filter, event)
        ) {
          listener.onEvent(event);
        }
      }
    }
    return {
      accepted: relays.filter((relay) => !this.refuse.includes(relay)),
      failed: relays
        .filter((relay) => this.refuse.includes(relay))
        .map((relay) => ({ relay, reason: 'blocked: test' })),
    };
  }

  close(): void {}
}
