import { CONFIG_D_TAG, KIND_CONFIG, type StoreConfig } from '@elisym/askr';
import { KIND_DELETION } from '@elisym/commerce';
import type { Filter } from 'nostr-tools';
import { CONNECTION_TIMEOUT_MS } from '../constants';
import type { ServerPool } from '../relay/pool';
import { readAllPages } from '../relay/read-all';
import { storeConfig } from './catalog';

/** The owner's configs (30496, `d` = askr) and the deletions that name their address. */
export function configFilters(owner: string): Filter[] {
  return [
    { kinds: [KIND_CONFIG], authors: [owner], '#d': [CONFIG_D_TAG] },
    { kinds: [KIND_DELETION], authors: [owner], '#a': [`${KIND_CONFIG}:${owner}:${CONFIG_D_TAG}`] },
  ];
}

/**
 * A store's config read from the relay, for an instance whose catalog cache
 * does not have it (it does not lease the store, 7.3): the newest genuine
 * config unless a deletion as new names it (NIP-09), as the catalog loader
 * reads it. Undefined when the read failed or there is none.
 */
export async function readStoreConfig(
  pool: Pick<ServerPool, 'ensureRelay'>,
  relayUrl: string,
  owner: string,
  now: number,
  pageTimeoutMs?: number,
): Promise<StoreConfig | undefined> {
  const read = await readAllPages(pool, relayUrl, configFilters(owner), {
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    ...(pageTimeoutMs === undefined ? {} : { pageTimeoutMs }),
  });
  return read === undefined ? undefined : storeConfig(read.events, owner, now);
}
