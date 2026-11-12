import { connectSyncClient } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { RELAY_URL } from '../constants';

/** A whole read of one filter: it resolves with every match, or throws. */
export interface RelayReader {
  query(filter: Filter): Promise<NostrEvent[]>;
}

/**
 * Reads over a browser WebSocket to the Askr relay, one connection per read,
 * paged to the end by `@elisym/askr`'s client so a partial read never passes
 * for a whole one.
 */
export function relayReader(url: string = RELAY_URL): RelayReader {
  return {
    async query(filter) {
      const client = await connectSyncClient(url);
      try {
        return await client.query([url], filter);
      } finally {
        client.close();
      }
    },
  };
}
