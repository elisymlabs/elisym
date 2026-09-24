import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';

/**
 * Whether an event's id is its hash and its signature is genuine - checked every
 * time. `verifyEvent` caches its verdict on the object under a symbol, and an
 * object spread copies symbols too: `{ ...genuine, content: 'tampered' }` would
 * pass on the cached `true`. A fresh object with only the NIP-01 fields cannot
 * carry that cache.
 */
export function isGenuineEvent(event: NostrEvent): boolean {
  if (!isEventShaped(event)) {
    return false;
  }
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

/**
 * Whether a value from a relay or a resolver has the NIP-01 field types. Typed
 * as `NostrEvent` is not the same as being one: a malformed entry must be
 * skipped, not crash whoever reads its tags.
 */
export function isEventShaped(event: unknown): event is NostrEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...event };
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = record;
  return (
    typeof id === 'string' &&
    typeof pubkey === 'string' &&
    typeof createdAt === 'number' &&
    Number.isInteger(createdAt) &&
    typeof kind === 'number' &&
    Number.isInteger(kind) &&
    typeof content === 'string' &&
    typeof sig === 'string' &&
    Array.isArray(tags) &&
    tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))
  );
}
