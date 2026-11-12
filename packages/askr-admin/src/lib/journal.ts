import type { NostrEvent } from 'nostr-tools';

function addressOf(kind: number, d: string): string {
  return `${kind}:${d}`;
}

/**
 * The addressable events this session signed and the server stored, newest
 * per address. The server publishes them later (a pending store: only once
 * activated), so the relay does not show them yet; a later signature must
 * still be dated after them and a later edit start from them.
 */
export class SignedJournal {
  private readonly newest = new Map<string, NostrEvent>();

  note(events: readonly NostrEvent[]): void {
    for (const event of events) {
      const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
      if (d === undefined) {
        continue;
      }
      const key = addressOf(event.kind, d);
      const current = this.newest.get(key);
      if (current === undefined || event.created_at > current.created_at) {
        this.newest.set(key, event);
      }
    }
  }

  latest(kind: number, d: string): NostrEvent | undefined {
    return this.newest.get(addressOf(kind, d));
  }
}
