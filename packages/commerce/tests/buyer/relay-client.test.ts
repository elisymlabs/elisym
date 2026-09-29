import type { Filter, NostrEvent } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_PUBLISH_DEADLINE_MS,
  RELAY_QUERY_DEADLINE_MS,
  SUBSCRIBE_STABLE_MS,
} from '../../src/buyer/constants';
import {
  type AuthSigner,
  type PoolLike,
  type RelayLike,
  createPool,
  createRelayClient,
} from '../../src/buyer/relay-client';
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

describe('a same-id copy with a bad signature', () => {
  const genuine = note('real');
  const forged = { ...genuine, sig: '0'.repeat(128) } as NostrEvent;

  it('never hides the genuine copy from a query', async () => {
    const pool = poolWith({
      subscribeEose: (relays, _filter, params) => {
        // The first relay answers with the forged copy, the second with the real one.
        params.onevent?.(relays[0] === 'wss://a.example.com' ? forged : genuine);
        params.onclose?.(['eose']);
        return { close: () => undefined };
      },
    });
    const client = createRelayClient({ pool });
    const events = await client.query(
      ['wss://a.example.com', 'wss://b.example.com'],
      [{ kinds: [1] }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.sig).toBe(genuine.sig);
  });

  it('never hides the genuine copy from a subscription', async () => {
    const handlers: Parameters<RelayLike['subscribe']>[1][] = [];
    const relay: RelayLike = {
      publish: async () => '',
      auth: async () => '',
      subscribe: (_filters, params) => {
        handlers.push(params);
        return { close: () => undefined };
      },
    };
    const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
    const heard: NostrEvent[] = [];
    const listening = client.subscribe(
      ['wss://a.example.com', 'wss://b.example.com'],
      { kinds: [1] },
      (event) => heard.push(event),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    handlers[0]?.onevent?.(forged);
    handlers[1]?.onevent?.(genuine);
    listening.close();
    expect(heard.map((event) => event.sig)).toEqual([genuine.sig]);
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
      subscribe: () => ({ close: () => undefined }),
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

describe('subscribe', () => {
  interface Opened {
    filters: unknown[];
    params: Parameters<RelayLike['subscribe']>[1];
    closed: string | undefined;
  }

  function scriptedRelay(opened: Opened[], auths: string[] = []): RelayLike {
    return {
      publish: async () => '',
      auth: async () => {
        auths.push('auth');
        return '';
      },
      subscribe: (filters, params) => {
        const entry: Opened = { filters, params, closed: undefined };
        opened.push(entry);
        return {
          close: (reason) => {
            entry.closed = reason ?? 'closed';
          },
        };
      },
    };
  }

  it('hands each event on once across relays, as a list of one filter', async () => {
    const opened: Opened[] = [];
    const relay = scriptedRelay(opened);
    const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
    const heard: string[] = [];
    const listening = client.subscribe(
      ['wss://a.example.com', 'wss://b.example.com'],
      { kinds: [1059] },
      (event) => heard.push(event.id),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toHaveLength(2);
    expect(opened[0]?.filters).toEqual([{ kinds: [1059] }]);
    const event = note('status');
    opened[0]?.params.onevent?.(event);
    opened[1]?.params.onevent?.(event);
    expect(heard).toEqual([event.id]);
    listening.close();
    expect(opened.every((entry) => entry.closed === 'closed by caller')).toBe(true);
  });

  it('answers auth-required once with the key, then opens again', async () => {
    const opened: Opened[] = [];
    const auths: string[] = [];
    const relay = scriptedRelay(opened, auths);
    const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }), auth });
    client.subscribe(['wss://a.example.com'], { kinds: [1059] }, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened[0]?.params.onclose?.('auth-required: sign in');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auths).toEqual(['auth']);
    expect(opened).toHaveLength(2);
  });

  it('opens a closed subscription again after a pause, and never after the caller closed it', async () => {
    vi.useFakeTimers();
    try {
      const opened: Opened[] = [];
      const relay = scriptedRelay(opened);
      const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
      const listening = client.subscribe(
        ['wss://a.example.com'],
        { kinds: [1059] },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(0);
      opened[0]?.params.onclose?.('relay connection closed');
      await vi.advanceTimersByTimeAsync(999);
      expect(opened).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(opened).toHaveLength(2);
      listening.close();
      opened[1]?.params.onclose?.('closed by caller');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(opened).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('subscribe across reconnects', () => {
  interface Opened {
    params: Parameters<RelayLike['subscribe']>[1];
  }

  function freshRelay(opened: Opened[], auths: string[]): RelayLike {
    return {
      publish: async () => '',
      auth: async () => {
        auths.push('auth');
        return '';
      },
      subscribe: (_filters, params) => {
        opened.push({ params });
        return { close: () => undefined };
      },
    };
  }

  it('answers AUTH again on the new connection a drop leaves, and once per connection', async () => {
    const opened: Opened[] = [];
    const auths: string[] = [];
    let connection = freshRelay(opened, auths);
    const pool = poolWith({ ensureRelay: async () => connection });
    const client = createRelayClient({ pool, auth });
    client.subscribe(['wss://a.example.com'], { kinds: [1059] }, () => undefined);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    opened[0]?.params.onclose?.('auth-required: sign in');
    await tick();
    // The same connection asks again: no second AUTH.
    opened[1]?.params.onclose?.('auth-required: sign in');
    expect(auths).toEqual(['auth']);
    // A drop: the pool hands a new, unauthenticated connection, which may ask.
    connection = freshRelay(opened, auths);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const last = opened.at(-1);
    last?.params.onclose?.('auth-required: sign in');
    await tick();
    expect(auths).toEqual(['auth', 'auth']);
  });

  it('keeps the pause growing when a late EOSE timeout fires after a close', async () => {
    vi.useFakeTimers();
    try {
      const opened: Opened[] = [];
      const relay = freshRelay(opened, []);
      const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
      const listening = client.subscribe(
        ['wss://a.example.com'],
        { kinds: [1059] },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(0);
      const pauses: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const before = opened.length;
        const subscription = opened.at(-1);
        subscription?.params.onclose?.('restricted: no');
        // nostr-tools fires its EOSE timeout on the closed subscription too.
        subscription?.params.oneose?.();
        let waited = 0;
        while (opened.length === before && waited < 120_000) {
          await vi.advanceTimersByTimeAsync(500);
          waited += 500;
        }
        pauses.push(waited);
      }
      expect(pauses).toEqual([1_000, 5_000, 15_000]);
      listening.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the pauses over only after a subscription stayed up a while', async () => {
    vi.useFakeTimers();
    try {
      const opened: Opened[] = [];
      const relay = freshRelay(opened, []);
      const client = createRelayClient({ pool: poolWith({ ensureRelay: async () => relay }) });
      const listening = client.subscribe(
        ['wss://a.example.com'],
        { kinds: [1059] },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(0);
      const pauseAfter = async (upFor: number) => {
        const before = opened.length;
        const subscription = opened.at(-1);
        subscription?.params.oneose?.();
        await vi.advanceTimersByTimeAsync(upFor);
        subscription?.params.onclose?.('relay connection closed');
        let waited = 0;
        while (opened.length === before && waited < 120_000) {
          await vi.advanceTimersByTimeAsync(500);
          waited += 500;
        }
        return waited;
      };
      // Dropped right after EOSE: the pause keeps growing.
      expect(await pauseAfter(0)).toBe(1_000);
      expect(await pauseAfter(0)).toBe(5_000);
      // Up long enough: the next drop is retried soon again.
      expect(await pauseAfter(SUBSCRIBE_STABLE_MS)).toBe(1_000);
      listening.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens nothing more once closed while a retry was pending', async () => {
    vi.useFakeTimers();
    try {
      const opened: Opened[] = [];
      let connects = 0;
      const relay = freshRelay(opened, []);
      const client = createRelayClient({
        pool: poolWith({
          ensureRelay: async () => {
            connects += 1;
            return relay;
          },
        }),
      });
      const listening = client.subscribe(
        ['wss://a.example.com'],
        { kinds: [1059] },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(0);
      opened[0]?.params.onclose?.('relay connection closed');
      listening.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closing', () => {
  interface Opened {
    params: Parameters<RelayLike['subscribe']>[1];
  }

  it('stops its subscriptions when the client closes, even as the pool drops them', async () => {
    vi.useFakeTimers();
    try {
      const opened: Opened[] = [];
      let connects = 0;
      const relay: RelayLike = {
        publish: async () => '',
        auth: async () => '',
        subscribe: (_filters, params) => {
          opened.push({ params });
          return { close: () => undefined };
        },
      };
      const client = createRelayClient({
        pool: poolWith({
          ensureRelay: async () => {
            connects += 1;
            return relay;
          },
          // Like nostr-tools: destroying the pool closes each subscription.
          destroy: () => {
            for (const entry of opened) {
              entry.params.onclose?.('relay connection closed by us');
            }
          },
        }),
      });
      client.subscribe(['wss://a.example.com'], { kinds: [1059] }, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      client.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens nothing when closed while still connecting', async () => {
    let finishConnect: (relay: RelayLike) => void = () => undefined;
    let subscribed = 0;
    const relay: RelayLike = {
      publish: async () => '',
      auth: async () => '',
      subscribe: () => {
        subscribed += 1;
        return { close: () => undefined };
      },
    };
    const client = createRelayClient({
      pool: poolWith({
        ensureRelay: () =>
          new Promise<RelayLike>((resolve) => {
            finishConnect = resolve;
          }),
      }),
    });
    const listening = client.subscribe(['wss://a.example.com'], { kinds: [1059] }, () => undefined);
    listening.close();
    finishConnect(relay);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscribed).toBe(0);
  });

  it('gives up on an AUTH that never settles and opens again later', async () => {
    vi.useFakeTimers();
    try {
      const opened: Opened[] = [];
      const relay: RelayLike = {
        publish: async () => '',
        auth: () => new Promise<string>(() => undefined),
        subscribe: (_filters, params) => {
          opened.push({ params });
          return { close: () => undefined };
        },
      };
      const client = createRelayClient({
        pool: poolWith({ ensureRelay: async () => relay }),
        auth,
      });
      client.subscribe(['wss://a.example.com'], { kinds: [1059] }, () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      opened[0]?.params.onclose?.('auth-required: sign in');
      await vi.advanceTimersByTimeAsync(RELAY_PUBLISH_DEADLINE_MS + 1_000);
      expect(opened.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
