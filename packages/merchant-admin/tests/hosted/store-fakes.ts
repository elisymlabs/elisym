import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { vi } from 'vitest';
import { ProvenPayouts } from '../../src/hosted/lib/proven';
import type { StoreApi, StoreSession } from '../../src/hosted/lib/store-session';
import type { Payout, StoreConfig } from '../../src/hosted/lib/types';
import { META, OPERATOR, OWNER, OWNER_KEY, STORE_PUBKEY, storeApi } from './fakes';

export const NOW = 1_800_000_000;
export const SOLANA_USDC =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const BASE_SEPOLIA_USDC = 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e';
export const SOLANA_ADDRESS = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const OTHER_SOLANA_ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
export const RELAYS = ['wss://relay.one.example', 'wss://relay.two.example'];

/** A text a server might send: an operator RPC URL with its key. */
export const LEAK = 'fetch failed: URL: https://rpc.example/?api-key=SECRET';

export const TEST_META = {
  ...META,
  networks: { mainnet: { coins: [] }, devnet: { coins: [SOLANA_USDC, BASE_SEPOLIA_USDC] } },
  inboxRelays: RELAYS,
};

export function storeConfig(overrides: Partial<StoreConfig> = {}): StoreConfig {
  return {
    name: 'Shop',
    network: 'devnet',
    draftPayouts: [],
    evmCredit: 'fast',
    inboxRelays: [RELAYS[0] ?? ''],
    activeInboxRelays: [],
    revision: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

export function payoutListTemplate(payouts: readonly Payout[], createdAt = NOW): EventTemplate {
  return {
    kind: 10133,
    created_at: createdAt,
    content: '',
    tags: payouts.map((payout) =>
      payout.signature === undefined
        ? ['accept', payout.caip19, payout.address]
        : ['accept', payout.caip19, payout.address, payout.signature],
    ),
  };
}

export function authorizationTemplate(createdAt = NOW): EventTemplate {
  return {
    kind: 30490,
    created_at: createdAt,
    content: '',
    tags: [
      ['d', STORE_PUBKEY],
      ['p', STORE_PUBKEY],
      ['mode', 'hosted', OPERATOR],
    ],
  };
}

export function signed(template: EventTemplate): NostrEvent {
  return finalizeEvent(template, OWNER_KEY);
}

export interface FakeSession {
  session: StoreSession;
  api: StoreApi;
  signEvent: ReturnType<typeof vi.fn<(template: EventTemplate) => Promise<NostrEvent>>>;
  sleeps: number[];
}

/** A session over `api` (unset calls fail), signing with the test owner key; waits are instant but counted. */
export function fakeSession(overrides: Partial<StoreApi> = {}): FakeSession {
  const api = storeApi({ meta: async () => TEST_META, ...overrides });
  const signEvent = vi.fn(async (template: EventTemplate) => signed(template));
  const sleeps: number[] = [];
  return {
    api,
    signEvent,
    sleeps,
    session: {
      api,
      owner: OWNER,
      operator: OPERATOR,
      meta: TEST_META,
      signEvent,
      proven: new ProvenPayouts(),
      localNow: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}
