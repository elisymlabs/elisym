import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';

/**
 * Whether an event's id is its hash and its signature is genuine - checked every
 * time. `verifyEvent` caches its verdict on the object under a symbol, and an
 * object spread copies symbols too: `{ ...genuine, content: 'tampered' }` would
 * pass on the cached `true`. A fresh object with only the NIP-01 fields cannot
 * carry that cache.
 */
export function isGenuineEvent(event: NostrEvent): boolean {
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  });
}
