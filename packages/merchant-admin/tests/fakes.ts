import {
  KIND_GIFT_WRAP,
  KIND_INBOX_RELAYS,
  type UnwrappedOrderMessage,
  buildPaytoEvent,
  buildProductEvent,
  buildStoreProfileEvent,
} from '@elisym/commerce';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import type { WrapPool } from '../../merchant-node/src/admin/reader';
import { type Key, T0, USDC_DEVNET_CAIP19 } from '../../merchant-node/tests/admin/fixtures';
import type { SessionDeps } from '../src/lib/core';

export const INBOX = 'wss://relay.example.com';
// A valid on-curve address: the vote program's, owned by no one.
const PAYOUT_ADDRESS = 'Vote111111111111111111111111111111111111111';

export function listing(
  store: Key,
  d: string,
  title = `Product ${d}`,
  visibility = 'on-sale',
): NostrEvent {
  return finalizeEvent(
    buildProductEvent({
      d,
      title,
      description: '',
      price: { amount: '1', currency: 'USD' },
      accept: [USDC_DEVNET_CAIP19],
      visibility,
      createdAt: T0 - 60,
    }),
    store.secretKey,
  );
}

export function storeEvents(store: Key, owner: Key, name = 'Shop', inbox = true): NostrEvent[] {
  const events = [
    finalizeEvent(
      buildStoreProfileEvent({ name, ownerPubkey: owner.pubkey, createdAt: T0 }),
      store.secretKey,
    ),
    finalizeEvent(
      { kind: KIND_INBOX_RELAYS, created_at: T0, tags: [['relay', INBOX]], content: '' },
      store.secretKey,
    ),
    finalizeEvent(
      buildPaytoEvent({
        accept: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT_ADDRESS }],
        createdAt: T0,
      }),
      owner.secretKey,
    ),
  ];
  return inbox ? events : events.filter((event) => event.kind !== KIND_INBOX_RELAYS);
}

function matches(event: NostrEvent, filter: Filter): boolean {
  return (
    (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
    (filter.authors === undefined || filter.authors.includes(event.pubkey)) &&
    (filter.until === undefined || event.created_at <= filter.until) &&
    (filter['#d'] === undefined ||
      event.tags.some((tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] ?? '') === true))
  );
}

/** A relay client answering by kind, author, `#d`, `until` and `limit`; `events` is read at each query. */
export function relayClient(events: () => NostrEvent[], fail?: () => boolean): RelayClient {
  return {
    query: (_relays, filters) => {
      if (fail?.() === true) {
        return Promise.reject(new Error('relay down'));
      }
      return Promise.resolve(
        filters.flatMap((filter) =>
          events()
            .filter((event) => matches(event, filter))
            .slice(0, filter.limit ?? 500),
        ),
      );
    },
    publish: () => Promise.resolve({ accepted: [], failed: [] }),
    subscribe: () => ({ close: () => undefined }),
    close: () => undefined,
  };
}

/** Session deps whose wraps open to `messages`, with no crypto. */
export function fakeDeps(
  client: RelayClient,
  messages: UnwrappedOrderMessage[],
  pageEnd: { reason?: string; hold?: () => Promise<void> } = {},
): SessionDeps {
  const byId = new Map<string, UnwrappedOrderMessage>();
  const wraps = messages.map((unwrapped, index) => {
    const id = (index + 1).toString(16).padStart(64, '0');
    byId.set(id, unwrapped);
    return {
      id,
      kind: KIND_GIFT_WRAP,
      pubkey: '00'.repeat(32),
      created_at: unwrapped.createdAt,
      tags: [],
      content: '',
      sig: '00'.repeat(64),
    };
  });
  const pool: WrapPool = {
    subscribeEose(_relays, filter, params) {
      void (pageEnd.hold?.() ?? Promise.resolve()).then(() => {
        for (const wrap of wraps) {
          if (wrap.created_at >= (filter.since ?? 0) && wrap.created_at <= (filter.until ?? 0)) {
            params.onevent?.(wrap);
          }
        }
        params.onclose?.([pageEnd.reason ?? 'closed automatically on eose']);
      });
      return { close: () => undefined };
    },
  };
  return { client, pool, now: () => T0 + 600, unwrap: (wrap) => byId.get(wrap.id) };
}
