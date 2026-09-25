import type { Filter, NostrEvent } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { RELAY_PUBLISH_DEADLINE_MS, RELAY_QUERY_DEADLINE_MS } from '../src/core/constants';
import {
  type AuthSigner,
  type PoolLike,
  type RelayLike,
  createPool,
  createRelayClient,
} from '../src/core/relay-client';
import { nostrKey, sign } from './fixtures';

const key = nostrKey();
const auth: AuthSigner = async (template) => finalizeEvent(template, key.secretKey);
const note = (content: string): NostrEvent =>
  sign({ kind: 1, created_at: 1_750_000_000, tags: [], content }, key);

function poolWith(overrides: Partial<PoolLike>): PoolLike {
  return {
    subscribeEose: (_relays, _filter, params) => {
      params.onclose?.([]);
      return { close: () => undefined };
    },
    ensureRelay: async () => {
      throw new Error('no relays in this test');
    },
    destroy: () => undefined,
    ...overrides,
  };
}

describe('query', () => {
  it('runs one subscription per filter (the pool takes one filter) and returns each event once', async () => {
    const first = note('a');
    const second = note('b');
    const seen: { filter: unknown; onauth: unknown }[] = [];
    const pool = poolWith({
      subscribeEose: (_relays, filter, params) => {
        seen.push({ filter, onauth: params.onauth });
        if ((filter as Filter).kinds?.[0] !== 7) {
          params.onevent?.(first);
          params.onevent?.(second);
          params.onevent?.({ junk: true } as unknown as NostrEvent);
        }
        params.onclose?.(['eose']);
        return { close: () => undefined };
      },
    });
    const client = createRelayClient({ pool, auth });
    const events = await client.query(
      ['wss://a.example.com'],
      [{ kinds: [1] }, { kinds: [7] }, { kinds: [2] }],
    );
    expect(seen).toHaveLength(3);
    expect(seen.every((entry) => !Array.isArray(entry.filter))).toBe(true);
    // A relay that closes the REQ with auth-required is retried after AUTH.
    expect(seen.every((entry) => entry.onauth === auth)).toBe(true);
    expect(events.map((event) => event.id).sort()).toEqual([first.id, second.id].sort());
    expect(await client.query([], [{ kinds: [1] }])).toEqual([]);
  });
});

describe('query deadline', () => {
  it('answers without a relay whose subscription cannot even start, and leaves no timer', async () => {
    vi.useFakeTimers();
    try {
      const pool = poolWith({
        subscribeEose: () => {
          throw new Error('Invalid URL');
        },
      });
      const events = await createRelayClient({ pool }).query(['bad'], [{ kinds: [1] }]);
      expect(events).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers with what arrived when a relay never closes', async () => {
    vi.useFakeTimers();
    try {
      const early = note('early');
      let closedWith: string | undefined;
      const pool = poolWith({
        subscribeEose: (_relays, _filter, params) => {
          params.onevent?.(early);
          return {
            close: (reason) => {
              closedWith = reason;
            },
          };
        },
      });
      const pending = createRelayClient({ pool, auth }).query(
        ['wss://a.example.com'],
        [{ kinds: [1] }],
      );
      await vi.advanceTimersByTimeAsync(RELAY_QUERY_DEADLINE_MS + 1);
      expect((await pending).map((event) => event.id)).toEqual([early.id]);
      expect(closedWith).toBe('deadline');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Relays in memory behind a WebSocket: each answers a REQ with its events, after a delay. */
const RELAY_BEHAVIOUR = new Map<string, { events: unknown[]; delayMs: number }>();

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(private readonly url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(message: string): void {
    const [type, subscriptionId] = JSON.parse(message) as [string, string];
    if (type !== 'REQ') {
      return;
    }
    const behaviour = RELAY_BEHAVIOUR.get(this.url.replace(/\/$/, ''));
    setTimeout(() => {
      for (const event of behaviour?.events ?? []) {
        this.onmessage?.({ data: JSON.stringify(['EVENT', subscriptionId, event]) });
      }
      this.onmessage?.({ data: JSON.stringify(['EOSE', subscriptionId]) });
    }, behaviour?.delayMs ?? 0);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

describe('query against real relay connections', () => {
  it("never lets one relay hide another relay's event behind a forged copy of its id", async () => {
    useWebSocketImplementation(FakeWebSocket);
    const genuine = note('the newest payout list');
    const forged = { ...genuine, sig: '0'.repeat(128) };
    RELAY_BEHAVIOUR.set('wss://evil.example.com', { events: [forged], delayMs: 0 });
    RELAY_BEHAVIOUR.set('wss://relay.good.example.com', { events: [genuine], delayMs: 30 });
    const client = createRelayClient();
    const events = await client.query(
      ['wss://evil.example.com', 'wss://relay.good.example.com'],
      [{ kinds: [1] }],
    );
    client.close();
    expect(events.map((event) => event.id)).toEqual([genuine.id]);
    expect(events[0]?.sig).toBe(genuine.sig);
  });
});

describe('publish', () => {
  function relayAnswering(answer: () => Promise<string>, auths: string[] = []): RelayLike {
    return {
      publish: answer,
      auth: async () => {
        auths.push('auth');
        return 'ok';
      },
    };
  }

  it('counts a relay only on its OK, never an unreachable one', async () => {
    const pool = poolWith({
      ensureRelay: async (url) => {
        if (url === 'wss://down.example.com') {
          throw new Error('connection timed out');
        }
        if (url === 'wss://refuses.example.com') {
          return relayAnswering(() => Promise.reject(new Error('blocked: spam')));
        }
        return relayAnswering(() => Promise.resolve(''));
      },
    });
    const client = createRelayClient({ pool });
    const result = await client.publish(
      [
        'wss://ok.example.com',
        'wss://down.example.com',
        'wss://refuses.example.com',
        'wss://ok.example.com',
      ],
      note('order'),
    );
    expect(result.accepted).toEqual(['wss://ok.example.com']);
    expect(result.failed).toEqual([
      { relay: 'wss://down.example.com', reason: 'connection timed out' },
      { relay: 'wss://refuses.example.com', reason: 'blocked: spam' },
    ]);
  });

  it('answers auth-required once with the buyer key, and not without one', async () => {
    const auths: string[] = [];
    let calls = 0;
    const relay = relayAnswering(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('auth-required: sign in'))
        : Promise.resolve('');
    }, auths);
    const withAuth = createRelayClient({
      pool: poolWith({ ensureRelay: async () => relay }),
      auth,
    });
    expect((await withAuth.publish(['wss://a.example.com'], note('x'))).accepted).toEqual([
      'wss://a.example.com',
    ]);
    expect(auths).toEqual(['auth']);

    calls = 0;
    const withoutAuth = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
    expect(await withoutAuth.publish(['wss://a.example.com'], note('x'))).toEqual({
      accepted: [],
      failed: [{ relay: 'wss://a.example.com', reason: 'auth-required: sign in' }],
    });
  });

  it('signs AUTH only when a relay asks for it, never for a plain refusal', async () => {
    for (const refusal of ['blocked: spam', 'restricted: not authorized']) {
      const auths: string[] = [];
      const relay = relayAnswering(() => Promise.reject(new Error(refusal)), auths);
      const client = createRelayClient({
        pool: poolWith({ ensureRelay: async () => relay }),
        auth,
      });
      expect((await client.publish(['wss://a.example.com'], note('x'))).failed).toHaveLength(1);
      expect(auths).toEqual([]);
    }
  });

  it('gives up on a relay that never answers', async () => {
    vi.useFakeTimers();
    try {
      const relay = relayAnswering(() => new Promise<string>(() => undefined));
      const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
      const pending = client.publish(['wss://a.example.com'], note('x'));
      await vi.advanceTimersByTimeAsync(RELAY_PUBLISH_DEADLINE_MS + 1);
      expect(await pending).toEqual({
        accepted: [],
        failed: [{ relay: 'wss://a.example.com', reason: 'timed out' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails an entry that is not a relay URL without failing the others', async () => {
    const relay = relayAnswering(() => Promise.resolve(''));
    const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
    const result = await client.publish(['not a url', 'wss://a.example.com'], note('x'));
    expect(result.accepted).toEqual(['wss://a.example.com']);
    expect(result.failed).toEqual([{ relay: 'not a url', reason: 'not a relay URL' }]);
  });

  it('fails a relay that refuses again after AUTH', async () => {
    const relay = relayAnswering(() => Promise.reject(new Error('auth-required: sign in')));
    const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }), auth });
    expect(await client.publish(['wss://a.example.com'], note('x'))).toEqual({
      accepted: [],
      failed: [{ relay: 'wss://a.example.com', reason: 'auth-required: sign in' }],
    });
  });

  it('counts two spellings of one relay once', async () => {
    const connected: string[] = [];
    const pool = poolWith({
      ensureRelay: async (url) => {
        connected.push(url);
        return relayAnswering(() => Promise.resolve(''));
      },
    });
    const client = createRelayClient({ pool });
    const result = await client.publish(
      ['wss://r.example.com/inbox', 'wss://r.example.com//inbox', 'wss://R.example.com/inbox/'],
      note('order'),
    );
    expect(result.accepted).toEqual(['wss://r.example.com/inbox']);
    expect(connected).toHaveLength(1);
  });

  it('never signs AUTH just because a relay asks on connect', () => {
    const pool = createPool();
    expect(pool.automaticallyAuth).toBeUndefined();
    pool.destroy();
  });
});
