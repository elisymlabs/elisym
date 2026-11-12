import type { SyncRelayClient } from '@elisym/askr';
import { CONNECTION_TIMEOUT_MS } from '../constants';
import type { ServerPool } from './pool';
import { publishToRelay } from './publish';
import { readAllPages } from './read-all';

/**
 * `syncCatalog`'s relay access over the server's pool (7.1, 7.3, 7.4), on the
 * server's one relay whatever list the caller names (2.4). A read must be whole: one that failed or hit the page cap throws, since a partial
 * read would re-create existing listings and miss stale ones.
 */
export function poolSyncClient(
  pool: Pick<ServerPool, 'ensureRelay'>,
  relayUrl: string,
  options: { pageTimeoutMs?: number } = {},
): SyncRelayClient {
  return {
    async query(_relays, filter) {
      const read = await readAllPages(pool, relayUrl, [filter], {
        connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
        ...(options.pageTimeoutMs === undefined ? {} : { pageTimeoutMs: options.pageTimeoutMs }),
      });
      if (read === undefined || !read.complete) {
        throw new Error(`Could not read every matching event from ${relayUrl}`);
      }
      return read.events;
    },
    async publish(_relays, event) {
      // nostr-tools' pool resolves a publish it could not deliver; only an OK from the relay counts.
      const outcome = await publishToRelay(pool, relayUrl, event);
      if (outcome.status !== 'accepted') {
        throw new Error(`The relay did not accept ${event.id}: ${outcome.reason}`);
      }
    },
  };
}
