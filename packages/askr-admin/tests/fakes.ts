import type { CatalogItemInput, StoreConfig } from '@elisym/askr';
import { buildCatalogItemEvent, buildConfigEvent } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { vi } from 'vitest';
import type { AdminClient, SessionDeps } from '../src/lib/deps';
import { SignedJournal } from '../src/lib/journal';
import type { RelayReader } from '../src/lib/relay';
import { type Signer, secretKeySigner } from '../src/lib/signer';
import type { CatalogSyncStatus, StoreView } from '../src/lib/types';

export const OWNER_KEY = generateSecretKey();
export const OWNER = getPublicKey(OWNER_KEY);
export const SERVER_KEY_SECRET = generateSecretKey();
export const SERVER_KEY = getPublicKey(SERVER_KEY_SECRET);
export const ASSISTANT = getPublicKey(generateSecretKey());
export const NOW = 1_800_000_000;
export const PINNED_WIDGET = {
  src: `https://api.askr.example/widget/${'0123456789abcdef'.repeat(2)}.js`,
  integrity: `sha384-${'A'.repeat(64)}`,
};

const EMPTY_DIFF = { created: [], updated: [], hidden: [], unchanged: [] };

/** A catalog sync as `GET /store` shows it, with an id and times unless given. */
export function catalogSyncOf(
  state: 'running' | 'done',
  overrides: Partial<Pick<CatalogSyncStatus, 'syncId' | 'startedAt' | 'finishedAt'>> & {
    diff?: CatalogSyncStatus['diff'];
  } = {},
): CatalogSyncStatus {
  return {
    state,
    diff: EMPTY_DIFF,
    syncId: 'sync-other',
    startedAt: NOW - 20,
    finishedAt: state === 'running' ? null : NOW - 10,
    ...overrides,
  };
}

/** A failed catalog sync as `GET /store` shows it. */
export function failedSyncOf(error: string, syncId = 'sync-other'): CatalogSyncStatus {
  return {
    state: 'failed',
    diff: EMPTY_DIFF,
    error,
    syncId,
    startedAt: NOW - 20,
    finishedAt: NOW - 10,
  };
}

export function storeView(overrides: Partial<StoreView> = {}): StoreView {
  return {
    owner: OWNER,
    status: 'active',
    tier: {
      name: 'base',
      messagesPerSessionPerDay: 30,
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
      conversations: 12,
      clicks: [],
      days: [],
    },
    catalogSync: null,
    connector: null,
    events: { pending: 0, failing: [] },
    movedFrom: null,
    email: null,
    budgetPaused: null,
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

/**
 * A fake API whose real catalog writes answer 202 with a fresh `syncId`, and
 * whose `store()` then shows that sync done, as the server does once a paced
 * sync ends. Either can be overridden.
 */
export function fakeApi(overrides: Partial<AdminClient> = {}): AdminClient {
  let lastSync: CatalogSyncStatus | null = null;
  let writes = 0;
  return {
    createStore: vi.fn(async () => storeView({ status: 'pending', tier: null })),
    setContactEmail: vi.fn(async (email: string | null) => storeView({ email })),
    store: vi.fn(async () => storeView({ catalogSync: lastSync })),
    storeEvents: vi.fn(async (events: NostrEvent[]) => ({
      stored: events.map((event) => event.id),
    })),
    choosePlan: vi.fn(async () => ({
      ...storeView({ tier: { ...FREE_TIER } }),
      activation: 'activated' as const,
    })),
    storedEvents: vi.fn(async () => ({ events: [], truncated: false })),
    pinnedWidget: vi.fn(async () => PINNED_WIDGET),
    catalog: vi.fn(
      async (_change: { items: readonly CatalogItemInput[]; hide: readonly string[] }, dryRun) => {
        if (dryRun) {
          return { diff: EMPTY_DIFF };
        }
        writes += 1;
        const syncId = `sync-${writes}`;
        lastSync = catalogSyncOf('done', { syncId, startedAt: NOW, finishedAt: NOW });
        return { diff: EMPTY_DIFF, started: true, syncId };
      },
    ),
    putPolicy: vi.fn(async () => ({ id: 'p' })),
    deletePolicy: vi.fn(async () => ({ id: 'p' })),
    putConnector: vi.fn(async () => ({ connector: null })),
    deleteConnector: vi.fn(async () => ({ connector: null })),
    previewConnector: vi.fn(async () => ({ result: { status: 'error' as const, message: 'x' } })),
    enableConnector: vi.fn(async () => ({ connector: null })),
    disableConnector: vi.fn(async () => ({ connector: null })),
    rotateAssistant: vi.fn(async () => ({ nextAssistant: ASSISTANT })),
    movedSettings: vi.fn(async () => ({
      from: ASSISTANT,
      signedBy: null,
      config: null,
      private: null,
    })),
    recover: vi.fn(async () => storeView()),
    ...overrides,
  };
}

/** The Free tier as an operator would set it up. */
export const FREE_TIER = {
  name: 'free',
  messagesPerSessionPerDay: 20,
  monthlyBudgetUsd: '10',
  ticketsPerStorePerMinute: 30,
  maxProducts: 100,
  syncIntervalMinutes: 1440,
  branding: true,
};

/** What Overview takes beside the view and the settings, for a test that only looks at it. */
export function overviewProps(api: AdminClient = fakeApi()) {
  return { deps: { api }, configError: '', onPlanChosen: vi.fn(async () => undefined) };
}

export function sessionDeps(
  api: AdminClient,
  reader: RelayReader,
  signer: Signer = secretKeySigner(OWNER_KEY),
): SessionDeps {
  return { signer, api, reader, now: () => NOW, journal: new SignedJournal() };
}

/** Settings signed by `secret`, for a store with products in the admin. */
export function signedConfig(secret: Uint8Array, name: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      ...buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://tea.example'],
          name,
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: SERVER_KEY,
          private: { voice: 'calm', instructions: 'Recommend oolong.', notes: 'Berlin' },
        },
        secret,
      ),
      created_at: createdAt,
    },
    secret,
  );
}
