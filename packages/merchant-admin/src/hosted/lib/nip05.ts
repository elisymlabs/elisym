/**
 * The store address (nip05) as the server takes it (`paycore-server`
 * `CreateStoreInputSchema`, and merchant-node's config schema on every config
 * save): `name@domain` on a public domain (or a bare domain), and never the
 * name `owner`, which `nostr.json` gives the owner key. The server's length
 * bound (1024) is never reached: `splitNip05` bounds the name and the domain
 * far below it. A test pins these to the server's source.
 */
import { splitNip05 } from '@elisym/commerce';

/** The name the store's `nostr.json` gives the owner key. */
export const OWNER_NAME = 'owner';

export const NIP05_NOT_USABLE =
  'Enter the store address as name@your-domain.com on a public domain, or leave it empty. The name "owner" is taken by your owner key.';

/** Whether the typed (already trimmed) store address is one the server takes; empty means none. */
export function nip05Usable(trimmed: string): boolean {
  if (trimmed === '') {
    return true;
  }
  const split = splitNip05(trimmed);
  return split !== undefined && split.local !== OWNER_NAME;
}
