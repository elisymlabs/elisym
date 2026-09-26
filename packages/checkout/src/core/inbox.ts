import { KIND_INBOX_RELAYS } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { STORE_RELAY_CAP } from './constants';
import { newestGenuine, nowSecs } from './events';
import type { RelayClient } from './relay-client';
import { type StoreRelaySources, readRelays, uniqueRelays } from './relays';

export interface StoreInbox {
  /** The store's inbox relays the widget may use, capped, in the store's order. */
  relays: string[];
  /** The kind 10050 they came from. */
  event: NostrEvent;
}

/**
 * The store's inbox relays from the newest genuine kind 10050 signed by the store
 * key among everything the relays returned - the same rule as for the payout list,
 * since a stale copy from one relay would send the order where the merchant no
 * longer reads. `undefined` when there is none, or it names no usable relay: the
 * widget then refuses before ordering.
 */
export function newestStoreInbox(
  events: readonly unknown[],
  storePubkey: string,
  now: number = nowSecs(),
): StoreInbox | undefined {
  const event = newestGenuine(events, KIND_INBOX_RELAYS, storePubkey, now);
  if (event === undefined) {
    return undefined;
  }
  const relays = uniqueRelays(
    event.tags.filter((tag) => tag[0] === 'relay').map((tag) => tag[1]),
  ).slice(0, STORE_RELAY_CAP);
  return relays.length === 0 ? undefined : { relays, event };
}

/**
 * Read the store's inbox list from the default relays - always, outside the cap -
 * plus the capped store-named relays, and pick it by `newestStoreInbox`.
 */
export async function readStoreInbox(
  client: RelayClient,
  sources: StoreRelaySources,
  storePubkey: string,
  now?: number,
): Promise<StoreInbox | undefined> {
  const events = await client.query(readRelays(sources), [
    { kinds: [KIND_INBOX_RELAYS], authors: [storePubkey] },
  ]);
  return newestStoreInbox(events, storePubkey, now);
}
