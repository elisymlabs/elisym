import { request as httpRequest } from 'node:http';
import {
  type SyncRelayClient,
  buildCatalogAuth,
  buildConfigEvent,
  parseCatalogItem,
} from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, checkNip98, sha256Hex } from '../src/admin/nip98';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { bodyLimitOf, serveGateway } from '../src/gateway/http';
import { HOLDER, NOW, ORIGIN, stateWith, storeRecord, syntheticStore } from './fixtures';

const BASE = 'https://api.askr.test';

/** A relay in memory: addressable events keep the newest per address. */
function memoryRelay(): SyncRelayClient & { events: NostrEvent[] } {
  const events: NostrEvent[] = [];
  const address = (event: NostrEvent) =>
    `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''}`;
  return {
    events,
    async query(_relays: readonly string[], filter: Filter) {
      return events.filter((event) => matchFilter(filter, event));
    },
    async publish(_relays: readonly string[], event: NostrEvent) {
      if (event.kind >= 30000 && event.kind < 40000) {
        const index = events.findIndex((stored) => address(stored) === address(event));
        if (index >= 0) {
          events.splice(index, 1);
        }
      }
      events.push(event);
    },
  };
}

function authHeader(input: {
  secret: Uint8Array;
  method: string;
  url: string;
  body?: string;
  createdAt?: number;
  tags?: string[][];
}): string {
  const tags = input.tags ?? [
    ['u', input.url],
    ['method', input.method],
    ...(input.body ? [['payload', sha256Hex(input.body)]] : []),
    // Two calls in one second would otherwise sign the same id, which the replay check refuses.
    ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
  ];
  const event = finalizeEvent(
    { kind: KIND_HTTP_AUTH, created_at: input.createdAt ?? NOW, tags, content: '' },
    input.secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

async function setup(status: 'pending' | 'active' = 'active', clock = { now: NOW }) {
  const store = syntheticStore();
  const seeded = await stateWith([{ ...storeRecord(store), status }]);
  const relay = memoryRelay();
  const changed: string[] = [];
  const api = createAdminApi({
    directory: seeded.directory,
    publicBase: BASE,
    syncClient: relay,
    storeEventsChanged: () => changed.push('changed'),
    connectors: new ConnectorService({
      directory: seeded.directory,
      holder: HOLDER,
      client: relay,
      configFor: () => undefined,
      limiter: new ShopRateLimiter(0),
    }),
    now: () => clock.now,
    syncPace: 1_000,
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    secret: Uint8Array = store.ownerSecret,
  ) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const request = new Request(`http://internal:8787${path}`, {
      method,
      headers: { authorization: authHeader({ secret, method, url: `${BASE}${path}`, body: text }) },
      ...(text ? { body: text } : {}),
    });
    const response = await api({ request, clientAddress: '203.0.113.9' });
    if (!response) {
      throw new Error('not an admin path');
    }
    return { status: response.status, body: await response.json() };
  };
  return { store, relay, changed, call, api, ...seeded };
}

describe('NIP-98 check (7.3)', () => {
  const secret = generateSecretKey();
  const url = `${BASE}/v1/admin/store`;
  const check = (
    header: string | null,
    overrides: { method?: string; body?: string; now?: number } = {},
  ) =>
    checkNip98({
      header,
      method: overrides.method ?? 'POST',
      publicUrl: url,
      body: overrides.body ?? '',
      now: overrides.now ?? NOW,
    });

  it('accepts a fresh, signed authorization for this URL and method', () => {
    expect(check(authHeader({ secret, method: 'POST', url }))).toMatchObject({
      ok: true,
      pubkey: getPublicKey(secret),
    });
    expect(
      check(authHeader({ secret, method: 'POST', url, body: '{"a":1}' }), { body: '{"a":1}' }),
    ).toMatchObject({ ok: true });
  });

  it('refuses each broken part', () => {
    expect(check(null)).toEqual({ ok: false, reason: 'missing' });
    expect(check('Bearer abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(check(`Nostr ${Buffer.from('{}').toString('base64')}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const valid = authHeader({ secret, method: 'POST', url });
    const event = JSON.parse(Buffer.from(valid.slice(6), 'base64').toString('utf8'));
    const forged = `Nostr ${Buffer.from(JSON.stringify({ ...event, content: 'x' })).toString('base64')}`;
    expect(check(forged)).toEqual({ ok: false, reason: 'signature' });
    expect(check(authHeader({ secret, method: 'POST', url, createdAt: NOW - 61 }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(check(authHeader({ secret, method: 'POST', url, createdAt: NOW + 61 }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(
      check(authHeader({ secret, method: 'POST', url: 'http://internal:8787/v1/admin/store' })),
    ).toEqual({ ok: false, reason: 'url' });
    expect(check(authHeader({ secret, method: 'GET', url }))).toEqual({
      ok: false,
      reason: 'method',
    });
    expect(check(authHeader({ secret, method: 'POST', url, body: 'a' }), { body: 'b' })).toEqual({
      ok: false,
      reason: 'payload',
    });
    expect(check(authHeader({ secret, method: 'POST', url }), { body: 'b' })).toEqual({
      ok: false,
      reason: 'payload',
    });
  });
});

describe('admin API (7.3)', () => {
  it('a replayed authorization is refused, and paths outside the admin are not handled', async () => {
    const { store, api } = await setup();
    const path = '/v1/admin/store';
    const header = authHeader({
      secret: store.ownerSecret,
      method: 'GET',
      url: `${BASE}${path}`,
    });
    const send = () =>
      api({
        request: new Request(`http://internal${path}`, { headers: { authorization: header } }),
        clientAddress: '203.0.113.9',
      });
    expect((await send())?.status).toBe(200);
    const replay = await send();
    expect(replay?.status).toBe(401);
    expect(await replay?.json()).toEqual({ error: 'unauthorized', reason: 'replay' });
    const other = await api({
      request: new Request('http://internal/v1/session', { method: 'POST' }),
      clientAddress: '203.0.113.9',
    });
    expect(other).toBeUndefined();
  });

  it('an authorization id outlives the last second it is valid in, across a sweep', async () => {
    const clock = { now: NOW };
    const { store, api, state } = await setup('active', clock);
    const path = '/v1/admin/store';
    const header = authHeader({ secret: store.ownerSecret, method: 'GET', url: `${BASE}${path}` });
    const send = () =>
      api({
        request: new Request(`http://internal${path}`, { headers: { authorization: header } }),
        clientAddress: '203.0.113.9',
      });
    expect((await send())?.status).toBe(200);
    clock.now = NOW + 60;
    await state.sweep(clock.now);
    expect(await (await send())?.json()).toEqual({ error: 'unauthorized', reason: 'replay' });
    clock.now = NOW + 61;
    await state.sweep(clock.now);
    expect(await (await send())?.json()).toEqual({ error: 'unauthorized', reason: 'stale' });
  });

  it('two catalog calls at once start one sync', async () => {
    const { call, store, relay, state } = await setup();
    const server = await state.store(store.owner);
    if (!server) {
      throw new Error('store missing');
    }
    await relay.publish(
      [],
      finalizeEvent(
        buildCatalogAuth({ key: server.catalogKey, mode: 'hosted', createdAt: NOW - 10 }),
        store.ownerSecret,
      ),
    );
    const item = {
      d: 'mug',
      title: 'Mug',
      description: 'A mug.',
      price: { amount: '12.50', currency: 'USD' },
    };
    // Reads take a while, so the second call arrives while the first one's preview reads.
    const query = relay.query.bind(relay);
    relay.query = async (relays, filter) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return query(relays, filter);
    };
    const results = await Promise.all([
      call('POST', '/v1/admin/catalog', { items: [item] }),
      call('POST', '/v1/admin/catalog', { items: [item] }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    await expect
      .poll(async () => (await call('GET', '/v1/admin/store')).body.catalogSync?.state)
      .toBe('done');
    expect(relay.events.filter((event) => event.kind === 30402)).toHaveLength(1);
  });

  it('onboarding creates a pending store once, and each owner sees only its own', async () => {
    const { call, store } = await setup();
    const newcomer = generateSecretKey();
    expect((await call('GET', '/v1/admin/store', undefined, newcomer)).status).toBe(404);
    const created = await call('POST', '/v1/admin/store', undefined, newcomer);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      owner: getPublicKey(newcomer),
      status: 'pending',
      tier: null,
      nextAssistant: null,
      catalogSync: null,
      usage: {
        today: { spent: '0', reserved: '0' },
        month: { spent: '0' },
        sessions: 0,
        clicks: [],
      },
    });
    const again = await call('POST', '/v1/admin/store', undefined, newcomer);
    expect(again.body.assistant).toBe(created.body.assistant);
    const own = await call('GET', '/v1/admin/store');
    expect(own.body).toMatchObject({
      owner: store.owner,
      status: 'active',
      assistant: store.assistant,
    });
    expect(own.body.tier).toMatchObject({ dailyBudgetUsd: '5.000000000' });
  });

  it('stores O-signed config, authorization and deletion events and notifies', async () => {
    const { call, store, changed, directory } = await setup();
    const [config, auth] = store.events;
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW,
        tags: [['a', `30497:${store.owner}:${store.catalogKey}`]],
        content: '',
      },
      store.ownerSecret,
    );
    const stored = await call('POST', '/v1/admin/store/events', {
      events: [config, auth, deletion],
    });
    expect(stored).toEqual({ status: 200, body: { stored: [config?.id, auth?.id, deletion.id] } });
    expect(changed).toEqual(['changed']);
    expect((await directory.unpublishedEvents()).map((row) => row.event.id)).toEqual(
      expect.arrayContaining([config?.id, auth?.id, deletion.id]),
    );
  });

  it('refuses events that are not O-signed config, authorization or deletions of them', async () => {
    const { call, store } = await setup();
    const stranger = generateSecretKey();
    const foreignConfig = finalizeEvent(
      buildConfigEvent(
        {
          assistant: getPublicKey(generateSecretKey()),
          origins: [ORIGIN],
          name: 'Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: store.catalogKey,
          createdAt: NOW,
        },
        store.ownerSecret,
      ),
      store.ownerSecret,
    );
    const note = finalizeEvent(
      { kind: 1, created_at: NOW, tags: [], content: 'hi' },
      store.ownerSecret,
    );
    const byStranger = finalizeEvent(
      buildCatalogAuth({ key: store.catalogKey, mode: 'hosted', createdAt: NOW }),
      stranger,
    );
    const future = finalizeEvent(
      buildCatalogAuth({ key: store.catalogKey, mode: 'hosted', createdAt: NOW + 601 }),
      store.ownerSecret,
    );
    const wideDeletion = finalizeEvent(
      { kind: 5, created_at: NOW, tags: [['a', `30402:${store.owner}:x`]], content: '' },
      store.ownerSecret,
    );
    const eventDeletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW,
        tags: [
          ['a', `30497:${store.owner}:${store.catalogKey}`],
          ['e', 'f'.repeat(64)],
        ],
        content: '',
      },
      store.ownerSecret,
    );
    const cases: [NostrEvent, string][] = [
      [foreignConfig, 'config_assistant'],
      [note, 'kind'],
      [byStranger, 'signature'],
      [future, 'future'],
      [wideDeletion, 'deletion_target'],
      [eventDeletion, 'deletion_target'],
    ];
    for (const [event, reason] of cases) {
      const result = await call('POST', '/v1/admin/store/events', { events: [event] });
      expect(result).toEqual({ status: 400, body: { error: 'bad_event', reason, id: event.id } });
    }
    expect((await call('POST', '/v1/admin/store/events', { events: [] })).status).toBe(400);
  });

  it('rotating A: a config naming the new A completes the rotation', async () => {
    const { call, store, state } = await setup();
    const started = await call('POST', '/v1/admin/store/assistant/rotate');
    const next: string = started.body.nextAssistant;
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('POST', '/v1/admin/store/assistant/rotate')).body.nextAssistant).toBe(next);
    const config = finalizeEvent(
      buildConfigEvent(
        {
          assistant: next,
          origins: [ORIGIN],
          name: 'Example Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: store.catalogKey,
          createdAt: NOW,
        },
        store.ownerSecret,
      ),
      store.ownerSecret,
    );
    expect((await call('POST', '/v1/admin/store/events', { events: [config] })).status).toBe(200);
    const rotated = await state.store(store.owner);
    expect(rotated?.assistant).toBe(next);
    expect(rotated && getPublicKey(rotated.assistantSecretKey)).toBe(next);
    expect((await call('GET', '/v1/admin/store')).body.nextAssistant).toBeNull();
    const leased = await state.acquireLeases(HOLDER, NOW, 60);
    expect(leased.map((lease) => lease.store.assistant)).toEqual([next]);
  });

  it('catalog writes need an active store, the server K authorized, and valid items within the tier', async () => {
    const pending = await setup('pending');
    expect((await pending.call('POST', '/v1/admin/catalog', { items: [] })).body).toEqual({
      error: 'inactive',
    });
    const { call, store, relay, state } = await setup();
    const server = await state.store(store.owner);
    if (!server) {
      throw new Error('store missing');
    }
    const item = {
      d: 'mug',
      title: 'Mug',
      description: 'A mug.',
      price: { amount: '12.50', currency: 'USD' },
      url: `${ORIGIN}/products/mug`,
    };
    const unauthorized = await call('POST', '/v1/admin/catalog', { items: [item] });
    expect(unauthorized.status).toBe(409);
    expect(unauthorized.body.error).toBe('sync_refused');
    await relay.publish(
      [],
      finalizeEvent(
        buildCatalogAuth({ key: server.catalogKey, mode: 'hosted', createdAt: NOW - 10 }),
        store.ownerSecret,
      ),
    );
    const preview = await call('POST', '/v1/admin/catalog', { items: [item], dryRun: true });
    expect(preview).toEqual({
      status: 200,
      body: { diff: { created: ['mug'], updated: [], hidden: [], unchanged: [] } },
    });
    expect(relay.events.filter((event) => event.kind === 30402)).toEqual([]);
    const started = await call('POST', '/v1/admin/catalog', { items: [item] });
    expect(started.status).toBe(202);
    await expect
      .poll(async () => (await call('GET', '/v1/admin/store')).body.catalogSync?.state)
      .toBe('done');
    const listings = relay.events.filter((event) => event.kind === 30402);
    expect(listings.map((event) => event.pubkey)).toEqual([server.catalogKey]);
    expect(parseCatalogItem(listings[0] ?? relay.events[0], { now: NOW })).toBeTruthy();
    const invalid = await call('POST', '/v1/admin/catalog', { items: [{ d: 'x' }] });
    expect(invalid.body.error).toBe('invalid_items');
    const tooMany = await call('POST', '/v1/admin/catalog', {
      items: Array.from({ length: 1001 }, (_unused, index) => ({ ...item, d: `item-${index}` })),
    });
    expect(tooMany.body).toEqual({ error: 'too_many_products', max: 1000 });
  });

  it('policies are set and removed by the server K', async () => {
    const { call, store, relay, state } = await setup();
    const server = await state.store(store.owner);
    if (!server) {
      throw new Error('store missing');
    }
    await relay.publish(
      [],
      finalizeEvent(
        buildCatalogAuth({ key: server.catalogKey, mode: 'hosted', createdAt: NOW - 10 }),
        store.ownerSecret,
      ),
    );
    const set = await call('PUT', '/v1/admin/policies/shipping', {
      title: 'Shipping',
      body: 'Ships in 2 days.',
    });
    expect(set.status).toBe(200);
    const published = relay.events.find((event) => event.id === set.body.id);
    expect(published).toMatchObject({ kind: 30495, pubkey: server.catalogKey });
    expect((await call('PUT', '/v1/admin/policies/shipping', { title: '' })).status).toBe(400);
    const removed = await call('DELETE', '/v1/admin/policies/shipping');
    expect(removed.status).toBe(200);
    expect(relay.events.find((event) => event.id === removed.body.id)?.kind).toBe(5);
    expect((await call('PUT', '/v1/admin/policies/Bad_Slug', {})).status).toBe(404);
  });
});

/** A raw request, path sent as is (fetch would resolve `..` before sending). */
function rawRequest(input: {
  port: number;
  method: string;
  path: string;
  body: string;
  authorization?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        method: input.method,
        path: input.path,
        headers: {
          'content-length': Buffer.byteLength(input.body),
          ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(input.body);
  });
}

describe('server core review: admin over HTTP and stored events (7.3)', () => {
  it('chooses the body cap by the normalized path and reads no admin body without a NIP-98 header', async () => {
    const reached: string[] = [];
    const server = serveGateway(
      async ({ request }) => {
        reached.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response('ok', { status: 200 });
      },
      { port: 0, trustProxy: false },
    );
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const authorization = `Nostr ${Buffer.from('{}').toString('base64')}`;
    const kib = (size: number) => 'x'.repeat(size * 1024);
    try {
      // A gateway path dressed as an admin one keeps the gateway's 16 KiB cap.
      expect(
        await rawRequest({ port, method: 'POST', path: '/v1/admin/../v1/session', body: kib(20) }),
      ).toBe(413);
      expect(
        await rawRequest({
          port,
          method: 'POST',
          path: '/v1/admin/%2e%2e/v1/session',
          body: kib(20),
          authorization,
        }),
      ).toBe(413);
      expect(
        await rawRequest({ port, method: 'POST', path: '/v1/admin/store/events', body: kib(20) }),
      ).toBe(401);
      expect(
        await rawRequest({
          port,
          method: 'POST',
          path: '/v1/admin/store/events',
          body: kib(20),
          authorization: 'Bearer abc',
        }),
      ).toBe(401);
      expect(
        await rawRequest({
          port,
          method: 'POST',
          path: '/v1/admin/store/events',
          body: kib(20),
          authorization,
        }),
      ).toBe(200);
      expect(reached).toEqual(['POST /v1/admin/store/events']);
    } finally {
      server.close();
    }
    // The size classes (a body past its cap is refused while still arriving, which a test
    // client sending megabytes may see as a reset, so they are checked here).
    const nostr = 'Nostr abc=';
    expect(bodyLimitOf('POST', '/v1/session', undefined)).toBe(16 * 1024);
    expect(bodyLimitOf('POST', '/v1/admin/catalog', nostr)).toBe(8 * 1024 * 1024);
    expect(bodyLimitOf('PUT', '/v1/admin/catalog', nostr)).toBe(2 * 1024 * 1024);
    expect(bodyLimitOf('POST', '/v1/admin/store/events', nostr)).toBe(2 * 1024 * 1024);
    expect(bodyLimitOf('POST', '/v1/admin/catalog', undefined)).toBe('unauthorized');
    expect(bodyLimitOf('POST', '/v1/admin/catalog', 'Nostr')).toBe('unauthorized');
  });

  it('refuses stored events past the per-store cap with 409', async () => {
    const { call, store } = await setup();
    const auths = Array.from({ length: 60 }, (_unused, index) =>
      finalizeEvent(
        buildCatalogAuth({
          key: getPublicKey(generateSecretKey()),
          mode: 'self-host',
          createdAt: NOW - 100 + index,
        }),
        store.ownerSecret,
      ),
    );
    for (let index = 0; index < 50; index += 10) {
      const batch = auths.slice(index, index + 10);
      expect((await call('POST', '/v1/admin/store/events', { events: batch })).status).toBe(200);
    }
    expect(await call('POST', '/v1/admin/store/events', { events: auths.slice(50, 51) })).toEqual({
      status: 409,
      body: { error: 'too_many_events' },
    });
  });

  it('refuses a deletion with no address, an authorization whose key is not hex, an event over 64 KiB in UTF-8, and a stale config', async () => {
    const { call, store } = await setup();
    const noAddress = finalizeEvent(
      { kind: 5, created_at: NOW, tags: [['k', '30497']], content: '' },
      store.ownerSecret,
    );
    const badKey = finalizeEvent(
      { kind: 30497, created_at: NOW, tags: [['d', 'Z'.repeat(64)]], content: '' },
      store.ownerSecret,
    );
    // 30 000 three-byte characters: under 64 Ki UTF-16 units, over 64 KiB as UTF-8.
    const wide = finalizeEvent(
      {
        kind: 30497,
        created_at: NOW,
        tags: [['d', store.catalogKey]],
        content: '€'.repeat(30_000),
      },
      store.ownerSecret,
    );
    expect(JSON.stringify(wide).length).toBeLessThan(64 * 1024);
    const cases: [NostrEvent, string][] = [
      [noAddress, 'deletion_target'],
      [badKey, 'auth_key'],
      [wide, 'too_large'],
    ];
    for (const [event, reason] of cases) {
      expect(await call('POST', '/v1/admin/store/events', { events: [event] })).toEqual({
        status: 400,
        body: { error: 'bad_event', reason, id: event.id },
      });
    }
    const [config] = store.events;
    if (!config) {
      throw new Error('fixture events missing');
    }
    expect((await call('POST', '/v1/admin/store/events', { events: [config] })).status).toBe(200);
    const older = finalizeEvent(
      buildConfigEvent(
        {
          assistant: store.assistant,
          origins: [ORIGIN],
          name: 'Older',
          language: 'en',
          currency: 'USD',
          source: { kind: 'catalog' },
          catalogKey: store.catalogKey,
          createdAt: config.created_at - 1,
        },
        store.ownerSecret,
      ),
      store.ownerSecret,
    );
    expect(await call('POST', '/v1/admin/store/events', { events: [older] })).toEqual({
      status: 400,
      body: { error: 'bad_event', reason: 'stale_config', id: older.id },
    });
  });

  it('accepts a NIP-98 `u` with the query string, and a public base given with a trailing slash', async () => {
    const store = syntheticStore();
    const seeded = await stateWith([storeRecord(store)]);
    const relay = memoryRelay();
    const api = createAdminApi({
      directory: seeded.directory,
      publicBase: `${BASE}/`,
      syncClient: relay,
      storeEventsChanged: () => undefined,
      connectors: new ConnectorService({
        directory: seeded.directory,
        holder: HOLDER,
        client: relay,
        configFor: () => undefined,
        limiter: new ShopRateLimiter(0),
      }),
      now: () => NOW,
    });
    const get = async (path: string, signedUrl: string) => {
      const response = await api({
        request: new Request(`http://internal${path}`, {
          headers: {
            authorization: authHeader({ secret: store.ownerSecret, method: 'GET', url: signedUrl }),
          },
        }),
        clientAddress: '203.0.113.9',
      });
      return { status: response?.status, body: await response?.json() };
    };
    expect(
      (await get('/v1/admin/store?view=full', `${BASE}/v1/admin/store?view=full`)).status,
    ).toBe(200);
    expect(await get('/v1/admin/store?view=full', `${BASE}/v1/admin/store`)).toEqual({
      status: 401,
      body: { error: 'unauthorized', reason: 'url' },
    });
    expect((await get('/v1/admin/store', `${BASE}/v1/admin/store`)).body).toMatchObject({
      owner: store.owner,
      events: { pending: 0, failing: [] },
    });
  });
});
