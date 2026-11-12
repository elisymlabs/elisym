import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { SyncRelayClient } from '../src/sync';

export interface TestKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function testKey(): TestKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function sign(template: EventTemplate, key: TestKey): NostrEvent {
  return finalizeEvent(template, key.secretKey);
}

export const NOW = 1_800_000_000;

function matches(event: NostrEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  return true;
}

/** An in-memory relay for sync tests. */
export class MemoryRelay implements SyncRelayClient {
  readonly events: NostrEvent[] = [];
  readonly published: NostrEvent[] = [];

  async query(_relays: readonly string[], filter: Filter): Promise<NostrEvent[]> {
    return this.events.filter((event) => matches(event, filter));
  }

  async publish(_relays: readonly string[], event: NostrEvent): Promise<void> {
    this.published.push(event);
    this.events.push(event);
  }
}

/**
 * A relay that behaves like a NIP-09 / NIP-01 one: a newer version of an
 * addressable event replaces the older, and a kind 5 removes every version of
 * an `a` address up to its own date.
 */
export class PurgingRelay extends MemoryRelay {
  override async publish(relays: readonly string[], event: NostrEvent): Promise<void> {
    await super.publish(relays, event);
    const kept = this.events.filter((stored) => {
      if (stored === event) {
        return true;
      }
      if (event.kind === 5) {
        const covered = event.tags.some(
          (tag) =>
            tag[0] === 'a' &&
            tag[1] ===
              `${stored.kind}:${stored.pubkey}:${stored.tags.find((storedTag) => storedTag[0] === 'd')?.[1]}` &&
            stored.created_at <= event.created_at,
        );
        return !covered;
      }
      const sameAddress =
        stored.kind === event.kind &&
        stored.pubkey === event.pubkey &&
        event.kind >= 30000 &&
        stored.tags.find((tag) => tag[0] === 'd')?.[1] ===
          event.tags.find((tag) => tag[0] === 'd')?.[1];
      return !(sameAddress && stored.created_at <= event.created_at);
    });
    this.events.length = 0;
    this.events.push(...kept);
  }
}
