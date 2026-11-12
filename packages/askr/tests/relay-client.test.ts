import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';
import { type SyncRelayConnection, relaySyncClient } from '../src/relay-client';

const AUTHOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function event(index: number, createdAt: number, pubkey = AUTHOR): NostrEvent {
  return {
    id: index.toString(16).padStart(64, '0'),
    pubkey,
    created_at: createdAt,
    kind: 30402,
    tags: [],
    content: '',
    sig: '0'.repeat(128),
  };
}

type Ending = 'eose' | 'close' | 'silent';

/** A relay that answers each REQ from `events`, newest first, capped at the filter's limit. */
class FakeConnection implements SyncRelayConnection {
  connected = true;
  requests: Filter[] = [];
  published: NostrEvent[] = [];
  constructor(
    private readonly events: NostrEvent[],
    private readonly ending: (request: number) => Ending = () => 'eose',
    private readonly extra: NostrEvent[] = [],
    private readonly pageCap = Number.POSITIVE_INFINITY,
    private readonly refuse = false,
  ) {}

  subscribe(
    filters: Filter[],
    params: {
      onevent: (event: NostrEvent) => void;
      oneose: () => void;
      onclose: (reason: string) => void;
    },
  ) {
    const [filter] = filters;
    if (filter === undefined) {
      throw new Error('no filter');
    }
    const request = this.requests.push(filter) - 1;
    const matching = this.events
      .filter((candidate) => matchFilter(filter, candidate))
      .sort((left, right) => right.created_at - left.created_at)
      .slice(0, Math.min(filter.limit ?? Number.POSITIVE_INFINITY, this.pageCap));
    let closed = false;
    queueMicrotask(() => {
      for (const candidate of [...matching, ...this.extra]) {
        params.onevent(candidate);
      }
      const ending = this.ending(request);
      if (ending === 'eose') {
        params.oneose();
      } else if (ending === 'close' && !closed) {
        params.onclose('relay closed');
      }
    });
    return {
      close: () => {
        closed = true;
      },
    };
  }

  async publish(published: NostrEvent): Promise<string> {
    if (this.refuse) {
      throw new Error('blocked: not allowed');
    }
    this.published.push(published);
    return '';
  }
}

const FILTER = { kinds: [30402], authors: [AUTHOR] };

describe('relaySyncClient', () => {
  it('reads every page back in time, keeps each event once, and only what was asked', async () => {
    // 1 200 events, the boundary second shared by events on both sides of a page.
    const events = Array.from({ length: 1_200 }, (_unused, index) =>
      event(index, 1_000 + Math.floor(index / 3)),
    );
    const relay = new FakeConnection(events, () => 'eose', [event(99_999, 5_000, OTHER)]);
    const read = await relaySyncClient(relay).query([], FILTER);
    expect(read).toHaveLength(1_200);
    expect(new Set(read.map((entry) => entry.id)).size).toBe(1_200);
    expect(read.every((entry) => entry.pubkey === AUTHOR)).toBe(true);
    expect(relay.requests.length).toBeGreaterThan(2);
    expect(relay.requests[1]?.until).toBeDefined();
  });

  it('refuses a read that a close or a missing EOSE cut short', async () => {
    const events = Array.from({ length: 700 }, (_unused, index) => event(index, 1_000 + index));
    const closed = new FakeConnection(events, (request) => (request === 1 ? 'close' : 'eose'));
    await expect(relaySyncClient(closed).query([], FILTER)).rejects.toThrow(/whole read/);
    const silent = new FakeConnection(events, () => 'silent');
    await expect(relaySyncClient(silent, { pageTimeoutMs: 20 }).query([], FILTER)).rejects.toThrow(
      /whole read/,
    );
    const dropped = new FakeConnection(events);
    dropped.connected = false;
    await expect(relaySyncClient(dropped).query([], FILTER)).rejects.toThrow(/whole read/);
  });

  it('refuses a read it cannot finish: a full page of one second, or past the page cap', async () => {
    const sameSecond = Array.from({ length: 600 }, (_unused, index) => event(index, 1_000));
    await expect(relaySyncClient(new FakeConnection(sameSecond)).query([], FILTER)).rejects.toThrow(
      /Too many/,
    );
    const many = Array.from({ length: 20_500 }, (_unused, index) => event(index, 1_000 + index));
    await expect(relaySyncClient(new FakeConnection(many)).query([], FILTER)).rejects.toThrow(
      /Too many/,
    );
  });

  it('a page the relay capped below the limit ends the read: the relay said that is all', async () => {
    const events = Array.from({ length: 300 }, (_unused, index) => event(index, 1_000 + index));
    const relay = new FakeConnection(events, () => 'eose', [], 100);
    expect(await relaySyncClient(relay).query([], FILTER)).toHaveLength(100);
  });

  it('publishes only on the relay OK', async () => {
    const accepting = new FakeConnection([]);
    await relaySyncClient(accepting).publish([], event(1, 1_000));
    expect(accepting.published).toHaveLength(1);
    const refusing = new FakeConnection([], () => 'eose', [], Number.POSITIVE_INFINITY, true);
    await expect(relaySyncClient(refusing).publish([], event(1, 1_000))).rejects.toThrow(/blocked/);
  });
});
