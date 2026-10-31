/**
 * "One nsec per store" (plan section 3): an owner key that already signed a
 * payout list (kind 10133) or a store authorization (kind 30490) may run
 * another store - an exported, self-hosted one the cloud's records cannot
 * see. The console reads the owner's own events from `DEFAULT_RELAYS` and
 * warns; it never blocks (the cloud refuses only keys it knows).
 */
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import { CLOUD_RELAYS } from './relays';

/** How long the relays get to answer. */
export const KEY_IN_USE_WAIT_MS = 4000;

/** Reads events matching a filter from the relays (the pool's `querySync`, or a test's). */
export type RelayQuery = (filter: Filter) => Promise<NostrEvent[]>;

/** Whether the key signed a payout list or a store authorization any of the relays holds. */
export async function keyInUse(query: RelayQuery, pubkey: string): Promise<boolean> {
  const events = await query({ kinds: [KIND_PAYTO, KIND_STORE_AUTH], authors: [pubkey], limit: 2 });
  return events.some(
    (event) =>
      event.pubkey === pubkey && (event.kind === KIND_PAYTO || event.kind === KIND_STORE_AUTH),
  );
}

/** What the query needs of a relay pool (nostr-tools' `SimplePool`, which checks signatures). */
export interface RelayPool {
  querySync(relays: string[], filter: Filter, params: { maxWait: number }): Promise<NostrEvent[]>;
  close(relays: string[]): void;
}

/** The relay query the console runs: `DEFAULT_RELAYS` (with the elisym relay), bounded in time, its sockets closed after. */
export function consoleRelayQuery(newPool: () => RelayPool = () => new SimplePool()): RelayQuery {
  return async (filter) => {
    const pool = newPool();
    try {
      return await pool.querySync([...CLOUD_RELAYS], filter, { maxWait: KEY_IN_USE_WAIT_MS });
    } finally {
      pool.close([...CLOUD_RELAYS]);
    }
  };
}
