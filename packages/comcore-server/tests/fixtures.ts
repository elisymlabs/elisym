import {
  ASSISTANT_WRAP_BACKDATE_SECS,
  type ChatMessage,
  buildCatalogAuth,
  buildCatalogItemEvent,
  buildConfigEvent,
  buildPolicyEvent,
  buildTicket,
  wrapChatMessage,
} from '@elisym/comcore';
import type { LlmProvider, TurnRequest, TurnResponse } from '@elisym/comcore-agent';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { StoreRecord, Tier } from '../src/state/types';

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
  messagesPerSessionPerDay: 50,
  dailyBudgetUsd: '5',
  ticketsPerStorePerMinute: 100,
  branding: true,
};

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

export function storeRecord(
  store: SyntheticStore,
  status: StoreRecord['status'] = 'active',
): StoreRecord {
  return { owner: store.owner, status, assistantSecretKey: store.assistantSecret, tier: TIER };
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
