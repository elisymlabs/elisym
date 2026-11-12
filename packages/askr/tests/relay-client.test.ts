import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';
import { buildCatalogAuth } from '../src/events/catalog-auth';
import { type SyncRelayConnection, relaySyncClient } from '../src/relay-client';
import { MAX_EVENTS_PER_SECOND, syncCatalog } from '../src/sync';
import { NOW, sign, testKey } from './fixtures';

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
  eoseTimeouts: number[] = [];
  /** Drop the connection right after the next EOSE. */
  dropAfterEose = false;
  published: NostrEvent[] = [];
  constructor(
    readonly events: NostrEvent[],
    private readonly ending: (request: number) => Ending = () => 'eose',
    private readonly extra: NostrEvent[] = [],
    private readonly pageCap = Number.POSITIVE_INFINITY,
    private readonly refuse = false,
  ) {}

  subscribe(
    filters: Filter[],
    params: {
      onevent: (event: NostrEvent) => void;
      oninvalidevent: (event: unknown) => void;
      oneose: () => void;
      onclose: (reason: string) => void;
      eoseTimeout: number;
    },
  ) {
    this.eoseTimeouts.push(params.eoseTimeout);
    if (!this.connected) {
      throw new Error('subscribe on a closed connection');
    }
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
      for (const candidate of matching) {
        params.onevent(candidate);
      }
      // As nostr-tools does: an event outside the filter never reaches `onevent`.
      for (const candidate of this.extra) {
        if (matchFilter(filter, candidate)) {
          params.onevent(candidate);
        } else {
          params.oninvalidevent(candidate);
        }
      }
      const ending = this.ending(request);
      if (ending === 'eose') {
        if (this.dropAfterEose) {
          this.connected = false;
        }
        params.oneose();
      } else if (ending === 'close' && !closed) {
        params.onclose('relay closed');
      } else if (ending === 'silent') {
        // nostr-tools' own timer: it calls `oneose` too, real EOSE or not.
        setTimeout(() => params.oneose(), params.eoseTimeout);
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
    this.events.push(published);
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

  it('never sends on a closed connection: a read and a publish fail as errors', async () => {
    const closed = new FakeConnection([event(1, 1_000)]);
    closed.connected = false;
    await expect(relaySyncClient(closed).query([], FILTER)).rejects.toThrow(/whole read/);
    await expect(relaySyncClient(closed).publish([], event(2, 1_000))).rejects.toThrow(/closed/);
    expect(closed.requests).toEqual([]);
    expect(closed.published).toEqual([]);
  });

  it("counts only a real EOSE: the library's own timer always fires after ours", async () => {
    const silent = new FakeConnection([event(1, 1_000)], () => 'silent');
    await expect(relaySyncClient(silent, { pageTimeoutMs: 30 }).query([], FILTER)).rejects.toThrow(
      /whole read/,
    );
  });

  it('a full page is full by what the relay sent, also events the filter drops', async () => {
    const strays = Array.from({ length: 10 }, (_unused, index) =>
      event(50_000 + index, 9_000, OTHER),
    );
    const events = Array.from({ length: 700 }, (_unused, index) => event(index, 1_000 + index));
    // Each page carries 10 stray events: 490 + 10 received is a full page, not the last one.
    const relay = new FakeConnection(events, () => 'eose', strays, 490);
    expect(await relaySyncClient(relay).query([], FILTER)).toHaveLength(700);
  });

  it('a catalog synced in one go reads whole again: no second holds a page', async () => {
    const owner = testKey();
    const catalog = testKey();
    const grant = sign(
      buildCatalogAuth({ key: catalog.pubkey, mode: 'self-host', createdAt: NOW - 100 }),
      owner,
    );
    const relay = new FakeConnection([grant]);
    const client = relaySyncClient(relay);
    const items = Array.from({ length: 600 }, (_unused, index) => ({
      d: `p${index}`,
      title: `Item ${index}`,
      price: { amount: '10', currency: 'USD' },
    }));
    const base = { signer: catalog.secretKey, store: owner.pubkey, client, sleep: async () => {} };
    // A frozen clock, as a fast publish within one second would be.
    await syncCatalog({ ...base, items, now: NOW });
    const perSecond = new Map<number, number>();
    for (const published of relay.published) {
      perSecond.set(published.created_at, (perSecond.get(published.created_at) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(MAX_EVENTS_PER_SECOND);
    const again = await syncCatalog({ ...base, items, now: NOW, dryRun: true });
    expect(again.unchanged).toHaveLength(600);
    // Hiding them all (a listing and a deletion each) keeps the cap too.
    await syncCatalog({ ...base, items: [], now: NOW + 1 });
    const read = await syncCatalog({ ...base, items: [], now: NOW + 1, dryRun: true });
    expect(read).toEqual({ created: [], updated: [], hidden: [], unchanged: [] });
  }, 60_000);

  it('a connection that drops right after an EOSE does not make the page whole', async () => {
    const relay = new FakeConnection([event(1, 1_000)]);
    relay.dropAfterEose = true;
    await expect(relaySyncClient(relay).query([], FILTER)).rejects.toThrow(/whole read/);
  });

  it("sets the library's own EOSE timer well past the page timeout", async () => {
    const relay = new FakeConnection([event(1, 1_000)]);
    await relaySyncClient(relay, { pageTimeoutMs: 40_000 }).query([], FILTER);
    expect(relay.eoseTimeouts.every((timeout) => timeout >= 40_000 + 10_000)).toBe(true);
  });
});
