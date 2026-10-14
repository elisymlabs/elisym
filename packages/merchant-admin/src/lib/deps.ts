import { createRelayClient } from '@elisym/commerce/buyer';
import { SimplePool } from 'nostr-tools/pool';
import type { SessionDeps } from './core';

/** The relay connections of one session: the wraps pool and the client never share a connection. */
export function createSessionDeps(): SessionDeps {
  return {
    client: createRelayClient(),
    pool: new SimplePool(),
    now: () => Math.floor(Date.now() / 1000),
  };
}
