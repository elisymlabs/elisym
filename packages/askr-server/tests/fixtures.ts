import {
  ASSISTANT_WRAP_BACKDATE_SECS,
  type ChatMessage,
  buildCatalogAuth,
  buildCatalogItemEvent,
  buildConfigEvent,
  buildPolicyEvent,
  buildTicket,
  wrapChatMessage,
} from '@elisym/askr';
import type { LlmProvider, TurnRequest, TurnResponse } from '@elisym/askr-agent';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Db } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { PgState } from '../src/state/pg-state';
import { StoreDirectory } from '../src/state/stores';
import type { SessionState, StoreStatus, Tier } from '../src/state/types';
import { freshDb } from './pglite-db';

export const NOW = Math.floor(Date.now() / 1000);

export const ORIGIN = 'https://shop.example.com';

export interface SyntheticStore {
  ownerSecret: Uint8Array;
  owner: string;
  assistantSecret: Uint8Array;
  assistant: string;
  catalogSecret: Uint8Array;
  catalogKey: string;
  events: NostrEvent[];
}

export const TIER: Tier = {
  name: 'test',
  messagesPerSessionPerDay: 50,
  dailyBudgetUsd: '5',
  monthlyBudgetUsd: '100',
  ticketsPerStorePerMinute: 100,
  maxProducts: 1000,
  syncIntervalMinutes: 60,
  branding: true,
};

export const MASTER_KEY = '11'.repeat(32);
/** The lease holder tests take leases as, and pass to their workers. */
export const HOLDER = 'test-worker';

/** A store with its config, an authorized catalog key, two listings and one policy, all signed. */
export function syntheticStore(now: number = NOW): SyntheticStore {
  const ownerSecret = generateSecretKey();
  const assistantSecret = generateSecretKey();
  const catalogSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret);
  const assistant = getPublicKey(assistantSecret);
  const catalogKey = getPublicKey(catalogSecret);
  const config = finalizeEvent(
    buildConfigEvent(
      {
        assistant,
        origins: [ORIGIN],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey,
        createdAt: now - 100,
      },
      ownerSecret,
    ),
    ownerSecret,
  );
  const auth = finalizeEvent(
    buildCatalogAuth({ key: catalogKey, mode: 'hosted', createdAt: now - 100 }),
    ownerSecret,
  );
  const listings = [
    { d: 'jacket-wool', title: 'Wool jacket', amount: '120' },
    { d: 'jacket-rain', title: 'Rain jacket', amount: '79.90' },
  ].map((listing) =>
    finalizeEvent(
      buildCatalogItemEvent({
        d: listing.d,
        title: listing.title,
        description: `${listing.title} for every season.`,
        price: { amount: listing.amount, currency: 'USD' },
        url: `${ORIGIN}/products/${listing.d}`,
        createdAt: now - 50,
      }),
      catalogSecret,
    ),
  );
  const policy = finalizeEvent(
    buildPolicyEvent({
      slug: 'returns',
      title: 'Returns',
      body: 'Returns within 30 days.',
      createdAt: now - 50,
    }),
    catalogSecret,
  );
  return {
    ownerSecret,
    owner,
    assistantSecret,
    assistant,
    catalogSecret,
    catalogKey,
    events: [config, auth, ...listings, policy],
  };
}

/** A store row to seed: the synthetic store's keys, a state and a tier. */
export interface StoreSpec {
  synthetic: SyntheticStore;
  status: StoreStatus;
  tier: Tier;
}

export function storeRecord(store: SyntheticStore, status: StoreStatus = 'active'): StoreSpec {
  return { synthetic: store, status, tier: TIER };
}

export interface TestState {
  db: Db;
  vault: KeyVault;
  state: PgState;
  directory: StoreDirectory;
}

/** A fresh database seeded with the stores (each with its own tier row). */
export async function stateWith(
  specs: readonly StoreSpec[],
  now: number = NOW,
): Promise<TestState> {
  const db = await freshDb();
  const vault = new KeyVault(MASTER_KEY);
  const directory = new StoreDirectory(db, vault);
  for (const [index, spec] of specs.entries()) {
    const tier = { ...spec.tier, name: `${spec.tier.name}-${index}` };
    await directory.setTier(tier);
    const { synthetic } = spec;
    await db.query(
      `insert into stores (owner, status, tier, assistant, assistant_key, catalog_key, catalog_key_secret, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        synthetic.owner,
        spec.status,
        tier.name,
        synthetic.assistant,
        vault.seal(synthetic.assistantSecret, synthetic.owner, 'assistant'),
        synthetic.catalogKey,
        vault.seal(synthetic.catalogSecret, synthetic.owner, 'catalog'),
        now,
      ],
    );
  }
  return { db, vault, state: new PgState(db, vault), directory };
}

/** Seed a stored session's history (what answered asks leave), straight in the database. */
export async function seedHistory(db: Db, session: SessionState): Promise<void> {
  await db.query('update sessions set data = ($2::text)::jsonb where id = $1', [
    session.id,
    JSON.stringify({
      history: session.history,
      visitorMessages: session.visitorMessages,
      policyPassages: session.policyPassages,
      allowedIds: session.allowedIds,
    }),
  ]);
}

/** Take the leases as `HOLDER` and return the epoch of the store with this assistant key. */
export async function leaseEpoch(
  state: PgState,
  assistant: string,
  now: number = NOW,
): Promise<number> {
  const leases = await state.acquireLeases(HOLDER, now, 60);
  const lease = leases.find((held) => held.store.assistant === assistant);
  if (!lease) {
    throw new Error('store not leased');
  }
  return lease.epoch;
}

/** A visitor's ask, wrapped to A, with a ticket signed by `gatewaySecret`. */
export function askWrap(input: {
  store: SyntheticStore;
  visitorSecret: Uint8Array;
  gatewaySecret: Uint8Array;
  askId: string;
  text: string;
  now?: number;
  ticketNow?: number;
}): NostrEvent {
  const now = input.now ?? NOW;
  const ticket = finalizeEvent(
    buildTicket({
      visitor: getPublicKey(input.visitorSecret),
      store: input.store.owner,
      now: input.ticketNow ?? now,
    }),
    input.gatewaySecret,
  );
  const message: ChatMessage = { type: 'ask', ask_id: input.askId, text: input.text, ticket };
  return wrapChatMessage({
    message,
    senderSecretKey: input.visitorSecret,
    recipientPubkey: input.store.assistant,
    maxBackdateSecs: ASSISTANT_WRAP_BACKDATE_SECS,
    expiresAt: now + 3_600,
    now,
  }).wrap;
}

/** A provider that answers every request with the next scripted text. */
export function scriptedProvider(
  texts: readonly string[],
): LlmProvider & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  let index = 0;
  return {
    model: 'scripted',
    requests,
    async turn(request: TurnRequest): Promise<TurnResponse> {
      requests.push(request);
      const text = texts[Math.min(index, texts.length - 1)] ?? '';
      index += 1;
      return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
      };
    },
  };
}
