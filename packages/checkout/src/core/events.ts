import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';

/** Whether a value from a relay has the NIP-01 field types. */
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

/**
 * Whether an event's id is its hash and its signature is genuine, checked every
 * time on a fresh object: `verifyEvent` caches its verdict on the object it is
 * given, and a spread copy of a genuine event would carry that cache.
 */
export function isGenuineEvent(event: unknown): event is NostrEvent {
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
 * The newest genuine event of `kind` by `author` among everything the relays
 * returned, or `undefined`. An event dated further ahead than the skew
 * allowance is ignored, so a far-future copy cannot pin an old value; a tie on
 * `created_at` goes to the lowest id (NIP-01).
 */
export function newestGenuine(
  events: readonly unknown[],
  kind: number,
  author: string,
  now: number,
): NostrEvent | undefined {
  let newest: NostrEvent | undefined;
  for (const event of events) {
    if (
      !isEventShaped(event) ||
      event.kind !== kind ||
      event.pubkey !== author ||
      event.created_at > now + MAX_FUTURE_SKEW_SECS ||
      !isGenuineEvent(event)
    ) {
      continue;
    }
    if (
      newest === undefined ||
      event.created_at > newest.created_at ||
      (event.created_at === newest.created_at && event.id < newest.id)
    ) {
      newest = event;
    }
  }
  return newest;
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
