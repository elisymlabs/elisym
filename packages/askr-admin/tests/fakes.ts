import type { CatalogItemInput, StoreConfig } from '@elisym/askr';
import { buildCatalogItemEvent } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { vi } from 'vitest';
import type { AdminClient, SessionDeps } from '../src/lib/deps';
import { SignedJournal } from '../src/lib/journal';
import type { RelayReader } from '../src/lib/relay';
import { type Signer, secretKeySigner } from '../src/lib/signer';
import type { StoreView } from '../src/lib/types';

export const OWNER_KEY = generateSecretKey();
export const OWNER = getPublicKey(OWNER_KEY);
export const SERVER_KEY_SECRET = generateSecretKey();
export const SERVER_KEY = getPublicKey(SERVER_KEY_SECRET);
export const ASSISTANT = getPublicKey(generateSecretKey());
export const NOW = 1_800_000_000;

const EMPTY_DIFF = { created: [], updated: [], hidden: [], unchanged: [] };

export function storeView(overrides: Partial<StoreView> = {}): StoreView {
  return {
    owner: OWNER,
    status: 'active',
    tier: {
      name: 'base',
      messagesPerSessionPerDay: 30,
      dailyBudgetUsd: '2',
      monthlyBudgetUsd: '40',
      ticketsPerStorePerMinute: 60,
      maxProducts: 500,
      syncIntervalMinutes: 60,
      branding: true,
    },
    assistant: ASSISTANT,
    nextAssistant: null,
    catalogKey: SERVER_KEY,
    usage: {
      today: { spent: '0.5', reserved: '0' },
      month: { spent: '10' },
      sessions: 3,
      clicks: [],
    },
    catalogSync: null,
    connector: null,
    events: { pending: 0, failing: [] },
    ...overrides,
  };
}

export function adminConfig(overrides: Partial<StoreConfig> = {}): StoreConfig {
  return {
    owner: OWNER,
    assistant: ASSISTANT,
    origins: ['https://tea.example'],
    linkOrigins: [],
    name: 'Tea Shop',
    language: 'en',
    currency: 'USD',
    source: { kind: 'admin' },
    catalogKey: SERVER_KEY,
    policyKey: SERVER_KEY,
    privateContent: '',
    createdAt: NOW - 100,
    ...overrides,
  };
}

/** A listing as the server K publishes it. */
export function listing(input: CatalogItemInput, createdAt = NOW - 50): NostrEvent {
  return finalizeEvent(
    { ...buildCatalogItemEvent(input), created_at: createdAt },
    SERVER_KEY_SECRET,
  );
}

/** A relay holding `events`, answering any filter. */
export function fakeReader(events: readonly NostrEvent[]): RelayReader {
  return {
    query: async (filter: Filter) => events.filter((event) => matchFilter(filter, event)),
  };
}

export function failingReader(): RelayReader {
  return {
    query: async () => {
      throw new Error('The relay did not answer the whole read');
    },
  };
}

export function fakeApi(overrides: Partial<AdminClient> = {}): AdminClient {
  return {
    createStore: vi.fn(async () => storeView({ status: 'pending', tier: null })),
    store: vi.fn(async () => storeView()),
    storeEvents: vi.fn(async (events: NostrEvent[]) => ({
      stored: events.map((event) => event.id),
    })),
    catalog: vi.fn(async () => ({ diff: EMPTY_DIFF })),
    putPolicy: vi.fn(async () => ({ id: 'p' })),
    deletePolicy: vi.fn(async () => ({ id: 'p' })),
    putConnector: vi.fn(async () => ({ connector: null })),
    deleteConnector: vi.fn(async () => ({ connector: null })),
    previewConnector: vi.fn(async () => ({ result: { status: 'error' as const, message: 'x' } })),
    enableConnector: vi.fn(async () => ({ connector: null })),
    rotateAssistant: vi.fn(async () => ({ nextAssistant: ASSISTANT })),
    ...overrides,
  };
}

export function sessionDeps(
  api: AdminClient,
  reader: RelayReader,
  signer: Signer = secretKeySigner(OWNER_KEY),
): SessionDeps {
  return { signer, api, reader, now: () => NOW, journal: new SignedJournal() };
}
