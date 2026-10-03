import { createRelayClient } from '@elisym/commerce/buyer';
import { SimplePool } from 'nostr-tools/pool';
import { startAdmin } from './page';

startAdmin(document, {
  client: createRelayClient(),
  pool: new SimplePool(),
  now: () => Math.floor(Date.now() / 1000),
  forget: () => window.location.reload(),
});
