import { buildTicket, wrapChatMessage } from '@elisym/comcore';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway/gateway';
import { WindowLimiter, ipKey } from '../src/gateway/limits';
import { Backoff } from '../src/relay/backoff';
import { passesWrapPreCheck } from '../src/relay/pool';
import { MemoryState } from '../src/state/memory';
import { buildStoreCatalog, isListed } from '../src/worker/catalog';
import { intakeWrap } from '../src/worker/intake';
import { NOW, ORIGIN, askWrap, scriptedProvider, storeRecord, syntheticStore } from './fixtures';

const ASK_ID = 'a'.repeat(32);

describe('wrap pre-check (2.4)', () => {
  const assistant = 'f'.repeat(64);
  const leased = (pubkey: string) => pubkey === assistant;
  const wrap = (overrides: { tags?: string[][]; content?: string; created_at?: number } = {}) => ({
    kind: 1059,
    content: overrides.content ?? 'x',
    created_at: overrides.created_at ?? NOW - 60,
    tags: overrides.tags ?? [
      ['p', assistant],
      ['expiration', String(NOW + 3_600)],
    ],
  });

  it('passes a well-formed wrap to a leased assistant', () => {
    expect(passesWrapPreCheck(wrap(), leased, NOW)).toBe(true);
  });

  it.each([
    ['no expiration', { tags: [['p', assistant]] }],
    [
      'expired',
      {
        tags: [
          ['p', assistant],
          ['expiration', String(NOW - 1)],
        ],
      },
    ],
    [
      'too far ahead',
      {
        tags: [
          ['p', assistant],
          ['expiration', String(NOW + 25 * 3_600)],
        ],
      },
    ],
    [
      'two expirations',
      {
        tags: [
          ['p', assistant],
          ['expiration', String(NOW + 10)],
          ['expiration', String(NOW + 20)],
        ],
      },
    ],
    ['created too far ahead', { created_at: NOW + 3 * 60 }],
    ['oversized content', { content: 'x'.repeat(76_549) }],
    [
      'two recipients',
      {
        tags: [
          ['p', assistant],
          ['p', assistant],
          ['expiration', String(NOW + 60)],
        ],
      },
    ],
    [
      'an assistant not leased',
      {
        tags: [
          ['p', 'e'.repeat(64)],
          ['expiration', String(NOW + 60)],
        ],
      },
    ],
  ])('drops a wrap with %s', (_label, overrides) => {
    expect(passesWrapPreCheck(wrap(overrides), leased, NOW)).toBe(false);
  });

  it('leaves other kinds to the normal verification', () => {
    expect(
      passesWrapPreCheck({ kind: 30402, content: '', created_at: NOW, tags: [] }, leased, NOW),
    ).toBe(true);
  });
});

describe('limits', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe(ipKey('2001:db8:1:2:aaaa::1'));
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
  });

  it('counts a fixed window', () => {
    const limiter = new WindowLimiter(2, 60_000);
    expect(limiter.hit('k', 0)).toBe(true);
    expect(limiter.hit('k', 1)).toBe(true);
    expect(limiter.hit('k', 2)).toBe(false);
    expect(limiter.hit('k', 60_000)).toBe(true);
  });

  it('backs off from 1 s doubling to 60 s with jitter', () => {
    const backoff = new Backoff(() => 1);
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([1_000, 2_000, 4_000]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      backoff.next();
    }
    expect(backoff.next()).toBe(60_000);
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
    expect(new Backoff(() => 0).next()).toBe(500);
  });
});

describe('catalog build (5.1)', () => {
  it('reads listings and policies of the authorized key', () => {
    const store = syntheticStore();
    const catalog = buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW);
    expect(catalog?.items.size).toBe(2);
    expect(catalog?.policies).toHaveLength(1);
  });

  it('refuses a config naming another assistant', () => {
    const store = syntheticStore();
    expect(buildStoreCatalog(store.events, store.owner, generateSecretKey(), NOW)).toBeUndefined();
  });

  it('ignores listings of a key the owner never authorized', () => {
    const store = syntheticStore();
    const withoutAuth = store.events.filter((event) => event.kind !== 30497);
    expect(
      buildStoreCatalog(withoutAuth, store.owner, store.assistantSecret, NOW)?.items.size,
    ).toBe(0);
  });

  it('drops a listing with a newer deletion', () => {
    const store = syntheticStore();
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW,
        tags: [['a', `30402:${store.catalogKey}:jacket-wool`]],
        content: '',
      },
      store.catalogSecret,
    );
    const catalog = buildStoreCatalog(
      [...store.events, deletion],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect([...(catalog?.items.keys() ?? [])]).toEqual(['jacket-rain']);
  });
});

describe('gateway (3)', () => {
  function setup(status: 'active' | 'suspended' = 'active') {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store, status)]);
    const gatewaySecret = generateSecretKey();
    const catalog = buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW);
    const handler = createGateway({
      state,
      gatewaySecretKey: gatewaySecret,
      configFor: (owner) => (owner === store.owner ? catalog?.config : undefined),
      isListed: (owner, address) => owner === store.owner && isListed(catalog, address),
      isUnservable: () => false,
      reserveUsd: '0.25',
      now: () => NOW,
    });
    const post = (path: string, body: unknown, origin = ORIGIN, address = '203.0.113.7') =>
      handler({
        request: new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        clientAddress: address,
      });
    return { store, state, gatewaySecret, post };
  }

  it('issues a ticket signed by G for the visitor, with the assistant key', async () => {
    const { store, gatewaySecret, post } = setup();
    const visitor = getPublicKey(generateSecretKey());
    const response = await post('/v1/session', { store: store.owner, visitor });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const body = (await response.json()) as {
      ticket: { pubkey: string; tags: string[][] };
      assistant: string;
      branding: boolean;
    };
    expect(body.assistant).toBe(store.assistant);
    expect(body.branding).toBe(true);
    expect(body.ticket.pubkey).toBe(getPublicKey(gatewaySecret));
    expect(body.ticket.tags).toContainEqual(['p', visitor]);
    expect(body.ticket.tags).toContainEqual(['store', store.owner]);
  });

  it('serves the widget script when configured, and nothing otherwise', async () => {
    const store = syntheticStore();
    const deps = {
      state: new MemoryState([storeRecord(store)]),
      gatewaySecretKey: generateSecretKey(),
      configFor: () => undefined,
      isListed: () => false,
      isUnservable: () => false,
      reserveUsd: '0.25',
    };
    const get = () => ({
      request: new Request('http://localhost/widget.js'),
      clientAddress: '203.0.113.7',
    });
    const served = await createGateway({ ...deps, widgetScript: '/* widget */' })(get());
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await served.text()).toBe('/* widget */');
    expect((await createGateway(deps)(get())).status).toBe(404);
  });

  it('refuses an origin the config does not list', async () => {
    const { store, post } = setup();
    const response = await post(
      '/v1/session',
      { store: store.owner, visitor: 'a'.repeat(64) },
      'https://evil.example',
    );
    expect(response.status).toBe(403);
  });

  it('refuses a store that is not active', async () => {
    const { store, post } = setup('suspended');
    const response = await post('/v1/session', { store: store.owner, visitor: 'a'.repeat(64) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ unavailable: true, reason: 'inactive', contact: null });
  });

  it('limits tickets per IP, sharing an IPv6 /64', async () => {
    const { store, post } = setup();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await post(
        '/v1/session',
        { store: store.owner, visitor: 'a'.repeat(64) },
        ORIGIN,
        `2001:db8::${index + 1}`,
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('counts a click under a valid ticket only', async () => {
    const { store, state, post } = setup();
    const visitor = getPublicKey(generateSecretKey());
    const session = (await (await post('/v1/session', { store: store.owner, visitor })).json()) as {
      ticket: unknown;
    };
    const address = `30402:${store.catalogKey}:jacket-wool`;
    expect((await post('/v1/click', { ticket: session.ticket, address })).status).toBe(204);
    expect(state.clicksFor(store.owner, address)).toBe(1);
    const forged = finalizeEvent(
      {
        kind: 27495,
        created_at: NOW,
        content: '',
        tags: [
          ['p', visitor],
          ['store', store.owner],
          ['expiration', String(NOW + 60)],
        ],
      },
      generateSecretKey(),
    );
    expect((await post('/v1/click', { ticket: forged, address })).status).toBe(403);
  });
});

describe('intake drop order (5.8)', () => {
  function setup() {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store)]);
    const gatewaySecret = generateSecretKey();
    return { store, state, gatewaySecret, gatewayKeys: [getPublicKey(gatewaySecret)] };
  }

  it('admits a fresh ask with a valid ticket', () => {
    const { store, state, gatewaySecret, gatewayKeys } = setup();
    const wrap = askWrap({
      store,
      visitorSecret: generateSecretKey(),
      gatewaySecret,
      askId: ASK_ID,
      text: 'hi',
    });
    expect(intakeWrap(wrap, state, gatewayKeys, NOW).action).toBe('ask');
  });

  it('drops a replayed rumor, a stale rumor and an unknown gateway silently', () => {
    const { store, state, gatewaySecret, gatewayKeys } = setup();
    const visitorSecret = generateSecretKey();
    const wrap = askWrap({ store, visitorSecret, gatewaySecret, askId: ASK_ID, text: 'hi' });
    expect(intakeWrap(wrap, state, gatewayKeys, NOW).action).toBe('ask');
    expect(intakeWrap(wrap, state, gatewayKeys, NOW).action).toBe('drop');
    const stale = askWrap({
      store,
      visitorSecret,
      gatewaySecret,
      askId: ASK_ID,
      text: 'old',
      now: NOW - 6 * 60,
    });
    expect(intakeWrap(stale, state, gatewayKeys, NOW).action).toBe('drop');
    const foreign = askWrap({
      store,
      visitorSecret,
      gatewaySecret: generateSecretKey(),
      askId: ASK_ID,
      text: 'x',
    });
    expect(intakeWrap(foreign, state, gatewayKeys, NOW).action).toBe('drop');
  });

  it('answers an expired but otherwise valid ticket with unavailable: expired', () => {
    const { store, state, gatewaySecret, gatewayKeys } = setup();
    const wrap = askWrap({
      store,
      visitorSecret: generateSecretKey(),
      gatewaySecret,
      askId: ASK_ID,
      text: 'hi',
      ticketNow: NOW - 31 * 60,
    });
    expect(intakeWrap(wrap, state, gatewayKeys, NOW).action).toBe('unavailable');
  });

  it('drops a ticket issued to someone else', () => {
    const { store, state, gatewaySecret, gatewayKeys } = setup();
    const victim = getPublicKey(generateSecretKey());
    const ticket = finalizeEvent(
      buildTicket({ visitor: victim, store: store.owner, now: NOW }),
      gatewaySecret,
    );
    const { wrap } = wrapChatMessage({
      message: { type: 'ask', ask_id: ASK_ID, text: 'hi', ticket },
      senderSecretKey: generateSecretKey(),
      recipientPubkey: store.assistant,
      expiresAt: NOW + 3_600,
      now: NOW,
    });
    expect(intakeWrap(wrap, state, gatewayKeys, NOW).action).toBe('drop');
  });
});

describe('ask records and budget (5.8)', () => {
  it('admits, answers once and refuses past the quota', () => {
    const store = syntheticStore();
    const state = new MemoryState([
      { ...storeRecord(store), tier: { ...storeRecord(store).tier, messagesPerSessionPerDay: 1 } },
    ]);
    const session = state.session(store.assistant, 'b'.repeat(64), NOW);
    const first = state.admitAsk(session, ASK_ID, '0.05', NOW);
    expect(first.admitted).toBe(true);
    expect(state.admitAsk(session, 'c'.repeat(32), '0.05', NOW)).toEqual({
      admitted: false,
      reason: 'quota',
    });
  });

  it('reserves, settles to actual spend and refuses past the budget', () => {
    const store = syntheticStore();
    const state = new MemoryState([
      { ...storeRecord(store), tier: { ...storeRecord(store).tier, dailyBudgetUsd: '0.1' } },
    ]);
    const session = state.session(store.assistant, 'b'.repeat(64), NOW);
    const admitted = state.admitAsk(session, ASK_ID, '0.06', NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    expect(state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.06' });
    expect(state.admitAsk(session, 'c'.repeat(32), '0.06', NOW)).toEqual({
      admitted: false,
      reason: 'budget',
    });
    expect(state.startAsk(session, ASK_ID, admitted.record.attemptId, Date.now() + 60_000)).toBe(
      true,
    );
    const wrap = {
      id: '0',
      pubkey: '0',
      created_at: NOW,
      kind: 1059,
      tags: [],
      content: '',
      sig: '0',
    };
    expect(state.answerAsk(session, ASK_ID, admitted.record.attemptId, wrap, '0.01', NOW)).toBe(
      true,
    );
    expect(state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.01', reserved: '0' });
    // A superseded attempt cannot answer twice.
    expect(state.answerAsk(session, ASK_ID, admitted.record.attemptId, wrap, '0.01', NOW)).toBe(
      false,
    );
  });

  it('a retry charges a running attempt in full and releases a queued one', () => {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store)]);
    const session = state.session(store.assistant, 'b'.repeat(64), NOW);
    const first = state.admitAsk(session, ASK_ID, '0.05', NOW);
    if (!first.admitted) {
      throw new Error('not admitted');
    }
    state.startAsk(session, ASK_ID, first.record.attemptId, Date.now() - 1);
    const retry = state.retryAsk(session, ASK_ID, '0.05', NOW);
    expect(retry.admitted).toBe(true);
    expect(state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0.05' });
  });

  it('starts a new session within the end margin', () => {
    const store = syntheticStore();
    const state = new MemoryState([storeRecord(store)]);
    const first = state.session(store.assistant, 'b'.repeat(64), NOW);
    expect(state.session(store.assistant, 'b'.repeat(64), NOW + 60)).toBe(first);
    const later = state.session(store.assistant, 'b'.repeat(64), first.sessionEnd - 4 * 60);
    expect(later).not.toBe(first);
  });
});

describe('security review fixes', () => {
  it('reads the last forwarded hop behind the proxy, never a spoofed first one', async () => {
    const { clientAddressOf } = await import('../src/gateway/http');
    const request = {
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' },
      socket: { remoteAddress: '10.0.0.2' },
    };
    expect(clientAddressOf(request, true)).toBe('203.0.113.7');
    expect(clientAddressOf(request, false)).toBe('10.0.0.2');
  });

  it('a retry counts against the session quota', () => {
    const store = syntheticStore();
    const state = new MemoryState([
      { ...storeRecord(store), tier: { ...storeRecord(store).tier, messagesPerSessionPerDay: 1 } },
    ]);
    const session = state.session(store.assistant, 'b'.repeat(64), NOW);
    const first = state.admitAsk(session, ASK_ID, '0.01', NOW);
    if (!first.admitted) {
      throw new Error('not admitted');
    }
    state.startAsk(session, ASK_ID, first.record.attemptId, Date.now() + 60_000);
    state.failAsk(session, ASK_ID, first.record.attemptId, '0');
    expect(state.retryAsk(session, ASK_ID, '0.01', NOW)).toEqual({
      admitted: false,
      reason: 'quota',
    });
  });

  it('a turn stops calling the model once its spend passes the ceiling', async () => {
    const { cappedProvider } = await import('../src/worker/worker');
    const provider = cappedProvider(
      scriptedProvider(['x']),
      { input: '1', cachedInput: '0', cacheWrite: '0', output: '0' },
      '0.0001',
    );
    const request = { system: [], messages: [], tools: [], maxTokens: 10 };
    await provider.turn(request);
    await expect(provider.turn(request)).rejects.toThrow('spend ceiling');
  });
});
