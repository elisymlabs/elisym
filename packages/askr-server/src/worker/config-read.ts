import {
  type StoreConfig,
  delegateConfigFilters,
  readConfigDelegates,
  storeConfigFilters,
} from '@elisym/askr';
import type { Filter } from 'nostr-tools';
import { CONNECTION_TIMEOUT_MS } from '../constants';
import type { ServerPool } from '../relay/pool';
import { readAllPages } from '../relay/read-all';
import { storeConfig } from './catalog';

/**
 * The owner's configs (30496, `d` = askr), its config delegations (30498) and
 * all of its deletions: a deletion of a 30498 revokes a delegate, and one of a
 * delegate's config address voids that config (1.3).
 */
export function configFilters(owner: string): Filter[] {
  return storeConfigFilters(owner);
}

/**
 * A store's config read from the relay, for an instance whose catalog cache
 * does not have it (it does not lease the store, 7.3): the newest genuine
 * candidate of the owner and its active delegates unless a deletion as new
 * names it (NIP-09), as the catalog loader reads it. Undefined when a read
 * failed or there is none.
 */
export async function readStoreConfig(
  pool: Pick<ServerPool, 'ensureRelay'>,
  relayUrl: string,
  owner: string,
  now: number,
  pageTimeoutMs?: number,
): Promise<StoreConfig | undefined> {
  const options = {
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    ...(pageTimeoutMs === undefined ? {} : { pageTimeoutMs }),
  };
  const read = await readAllPages(pool, relayUrl, configFilters(owner), options);
  if (read === undefined) {
    return undefined;
  }
  const delegates = readConfigDelegates(read.events, owner, now);
  if (delegates.length === 0) {
    return storeConfig(read.events, owner, now);
  }
  const delegateRead = await readAllPages(
    pool,
    relayUrl,
    delegateConfigFilters(delegates),
    options,
  );
  return delegateRead === undefined
    ? undefined
    : storeConfig([...read.events, ...delegateRead.events], owner, now);
}
