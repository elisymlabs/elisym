import { KIND_CONFIG, readConfigDelegates } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';
import type { RelayReader } from './relay';

function isEventShaped(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const event: Partial<Record<keyof NostrEvent, unknown>> = value;
  return (
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.created_at === 'number' &&
    typeof event.kind === 'number' &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string' &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag: unknown) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'),
    )
  );
}

function verifies(event: NostrEvent): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

const KIND_DELETION = 5;

/**
 * The stored events the admin may use: signed by the owner, each signature
 * checked, as relay data is. The server holds them, but O signed them, so
 * nothing else is trusted. With a config delegate the owner authorizes in
 * them (30498), that delegate's configs and deletions are kept too (1.3).
 */
export function ownSignedEvents(
  events: readonly unknown[],
  owner: string,
  now: number = Math.floor(Date.now() / 1000),
): NostrEvent[] {
  const signed = signedEvents(events);
  const own = signed.filter((event) => event.pubkey === owner);
  const delegates = new Set(readConfigDelegates(own, owner, now));
  if (delegates.size === 0) {
    return own;
  }
  return signed.filter(
    (event) =>
      event.pubkey === owner ||
      (delegates.has(event.pubkey) && (event.kind === KIND_CONFIG || event.kind === KIND_DELETION)),
  );
}

function signedEvents(events: readonly unknown[]): NostrEvent[] {
  return events.flatMap((value) => {
    if (!isEventShaped(value)) {
      return [];
    }
    // Rebuilt from the signed fields only, so nothing else on the object is carried or trusted.
    const event: NostrEvent = {
      id: value.id,
      pubkey: value.pubkey,
      created_at: value.created_at,
      kind: value.kind,
      tags: value.tags.map((tag) => [...tag]),
      content: value.content,
      sig: value.sig,
    };
    return verifies(event) ? [event] : [];
  });
}

/**
 * The relay's events with the owner's stored ones added (7.3): a store that is
 * not active has nothing on the relay yet, nor has an active one whose events
 * are not all published yet (right after an activation), so its settings and
 * authorizations are read from what the server holds for it. Every reader
 * keeps choosing the newest per address, so whichever is newer wins.
 */
export function withStoredEvents(relay: RelayReader, stored: readonly NostrEvent[]): RelayReader {
  if (stored.length === 0) {
    return relay;
  }
  return {
    async query(filter) {
      const events = await relay.query(filter);
      const known = new Set(events.map((event) => event.id));
      return [
        ...events,
        ...stored.filter((event) => !known.has(event.id) && matchFilter(filter, event)),
      ];
    },
  };
}
