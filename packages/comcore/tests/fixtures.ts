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
