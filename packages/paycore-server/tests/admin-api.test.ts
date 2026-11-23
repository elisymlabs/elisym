import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { emptyLedger } from '@merchant-node/ledger';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ADMIN_PREFIX, NEW_STORES_PER_IP_PER_HOUR, createAdminApi } from '../src/admin/api';
import { type AdminRequest, markRequest } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import { serializeLedger } from '../src/state/ledger-store';
import { freshDb } from './pglite-db';
import {
  BASE,
  NOW,
  OPERATOR,
  PRODUCT,
  RELAY,
  activate,
  authHeader,
  directoryFor,
  ownerKeys,
  signedPayouts,
} from './stores-fixtures';

/** `value[name]` of a JSON object answer, or undefined. */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Object.entries(value).find(([key]) => key === name)?.[1]
    : undefined;
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
  /** Sign for another URL, method, time or body than the request's. */
  sign?: { url?: string; method?: string; createdAt?: number; body?: string };
  header?: string | null;
  clientAddress?: string;
}

function harness(
  db: Db,
  options: {
    waitResult?: (owner: string, id: string) => Promise<AdminRequest | undefined>;
    newestOnRelays?: number;
  } = {},
) {
  const directory = directoryFor(db);
  const api = createAdminApi({
    directory,
    db,
    publicBase: `${BASE}/`,
    operator: OPERATOR,
    now: () => NOW,
    waitResult: async (owner, id) => options.waitResult?.(owner, id),
    newestOnRelays: async () => options.newestOnRelays,
  });
  const call = async (secret: Uint8Array, input: Call) => {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const header =
      input.header === undefined
        ? authHeader({
            secret,
            method: input.sign?.method ?? input.method,
            url: input.sign?.url ?? `${BASE}${input.path}`,
            ...(input.sign?.createdAt === undefined ? {} : { createdAt: input.sign.createdAt }),
            ...((input.sign?.body ?? body) === undefined ? {} : { body: input.sign?.body ?? body }),
          })
        : input.header;
    const request = new Request(`http://internal${input.path}`, {
      method: input.method,
      headers: header === null ? {} : { authorization: header },
      ...(body === undefined ? {} : { body }),
    });
    const response = await api({ request, clientAddress: input.clientAddress ?? '203.0.113.7' });
    if (response === undefined) {
      return { status: 0, body: undefined, text: '' };
    }
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
  };
  return { api, call, directory };
}

async function created(db: Db, options: Parameters<typeof harness>[1] = {}) {
  const owner = ownerKeys();
  const { call, directory } = harness(db, options);
  const response = await call(owner.secret, {
    method: 'POST',
    path: '/v1/admin/store',
    body: { name: 'Shop', network: 'devnet' },
  });
  expect(response.status).toBe(200);
  return { owner, call, directory };
}

describe('admin API: authorization', () => {
  it('refuses every broken authorization with its reason, and a replay', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const get = { method: 'GET', path: '/v1/admin/store' };
    expect((await call(owner.secret, { ...get, header: null })).body).toEqual({
      error: 'unauthorized',
      reason: 'missing',
    });
    expect((await call(owner.secret, { ...get, header: 'Nostr !!' })).body?.reason).toBe(
      'malformed',
    );
    const good = authHeader({ secret: owner.secret, method: 'GET', url: `${BASE}/v1/admin/store` });
    const event = JSON.parse(Buffer.from(good.slice(6), 'base64').toString('utf8'));
    const tampered = `Nostr ${Buffer.from(JSON.stringify({ ...event, content: 'x' })).toString('base64')}`;
    expect((await call(owner.secret, { ...get, header: tampered })).body?.reason).toBe('signature');
    expect(
      (await call(owner.secret, { ...get, sign: { createdAt: NOW - 120 } })).body?.reason,
    ).toBe('stale');
    expect(
      (await call(owner.secret, { ...get, sign: { url: 'http://internal/v1/admin/store' } })).body
        ?.reason,
    ).toBe('url');
    expect((await call(owner.secret, { ...get, sign: { method: 'POST' } })).body?.reason).toBe(
      'method',
    );
    expect(
      (
        await call(owner.secret, {
          method: 'POST',
          path: '/v1/admin/store/suspend',
          body: {},
          sign: { body: '{"other":1}' },
        })
      ).body?.reason,
    ).toBe('payload');
    expect((await call(owner.secret, { ...get, header: good })).status).toBe(200);
    expect((await call(owner.secret, { ...get, header: good })).body).toEqual({
      error: 'unauthorized',
      reason: 'replay',
    });
  });

  it('leaves other paths to other handlers', async () => {
    const db = await freshDb();
    const { api } = harness(db);
    expect(
      await api({ request: new Request('http://internal/v1/other'), clientAddress: 'x' }),
    ).toBeUndefined();
    expect(ADMIN_PREFIX).toBe('/v1/admin/');
  });

  it('acts only on the caller’s own store', async () => {
    const db = await freshDb();
    const { call } = await created(db);
    const stranger = ownerKeys();
    expect((await call(stranger.secret, { method: 'GET', path: '/v1/admin/store' })).body).toEqual({
      error: 'no_store',
    });
  });
});

describe('admin API: store', () => {
  it('creates once, answers the existing store again, and rate-limits new stores per IP', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const again = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/store',
      body: { name: 'Shop', network: 'devnet' },
    });
    expect(again.body).toMatchObject({ owner: owner.pubkey, status: 'pending', tier: null });
    const create = (secret: Uint8Array, clientAddress: string) =>
      call(secret, {
        method: 'POST',
        path: '/v1/admin/store',
        body: { name: 'Shop', network: 'devnet' },
        clientAddress,
      });
    for (let index = 0; index < NEW_STORES_PER_IP_PER_HOUR; index += 1) {
      expect((await create(ownerKeys().secret, '198.51.100.1')).status).toBe(200);
    }
    expect((await create(ownerKeys().secret, '198.51.100.1')).body).toEqual({
      error: 'rate_limited',
    });
    expect((await create(ownerKeys().secret, '198.51.100.2')).status).toBe(200);
    expect(
      (
        await call(ownerKeys().secret, {
          method: 'POST',
          path: '/v1/admin/store',
          body: { name: '', network: 'devnet' },
        })
      ).status,
    ).toBe(400);
  });

  it('validates the config: unsigned payout, relay outside the allowlist, webhook on 8443', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const put = (body: unknown) =>
      call(owner.secret, { method: 'PUT', path: '/v1/admin/store/config', body });
    const payouts = signedPayouts(owner.pubkey);
    const base = { name: 'Shop', payouts, inboxRelays: [RELAY] };
    const unsigned = await put({
      ...base,
      payouts: payouts.map(({ caip19, address }) => ({ caip19, address })),
    });
    expect(unsigned.status).toBe(400);
    expect(unsigned.body).toMatchObject({ error: 'bad_config' });
    expect((await put({ ...base, inboxRelays: ['wss://nos.lol'] })).body).toMatchObject({
      error: 'bad_config',
    });
    expect((await put({ ...base, webhookUrl: 'https://hooks.example:8443/x' })).body).toMatchObject(
      { error: 'bad_config' },
    );
    expect((await put({ ...base, network: 'mainnet' })).status).toBe(400);
    const good = await put({ ...base, webhookUrl: 'https://hooks.example/x' });
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ config: { draftPayouts: payouts }, requestId: null });
  });

  it('suspends through a request: 202 when the holder is slow, then GET requests/:id', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    expect(
      (await call(owner.secret, { method: 'POST', path: '/v1/admin/store/suspend' })).body,
    ).toEqual({ error: 'inactive' });
    await activate(db, owner.pubkey);
    const queued = await call(owner.secret, { method: 'POST', path: '/v1/admin/store/suspend' });
    expect(queued.status).toBe(202);
    const id = String(field(queued.body?.request, 'id'));
    const path = `/v1/admin/requests/${id}`;
    expect((await call(owner.secret, { method: 'GET', path })).body).toMatchObject({
      request: { id, kind: 'suspend', state: 'pending' },
    });
    await markRequest(db, owner.pubkey, id, 'applied', NOW, { status: 'suspending' });
    expect((await call(owner.secret, { method: 'GET', path })).body).toMatchObject({
      request: { state: 'applied', result: { status: 'suspending' }, appliedAt: NOW },
    });
    expect((await call(ownerKeys().secret, { method: 'GET', path })).status).toBe(404);
  });

  it('answers 200 with the result when the holder applies within the wait', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db, {
      waitResult: async (requestOwner, id) => {
        await markRequest(db, requestOwner, id, 'applied', NOW, { ok: true });
        return {
          id,
          owner: requestOwner,
          kind: 'suspend',
          payload: {},
          state: 'applied',
          result: { ok: true },
          createdAt: NOW,
          appliedAt: NOW,
        };
      },
    });
    await activate(db, owner.pubkey);
    const response = await call(owner.secret, { method: 'POST', path: '/v1/admin/store/suspend' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ request: { state: 'applied', result: { ok: true } } });
  });
});

describe('admin API: active payouts', () => {
  it('shows the payout list the ledger recorded, apart from the draft', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const draft = signedPayouts(owner.pubkey);
    expect(
      (
        await call(owner.secret, {
          method: 'PUT',
          path: '/v1/admin/store/config',
          body: { name: 'Shop', payouts: draft, inboxRelays: [RELAY] },
        })
      ).status,
    ).toBe(200);
    const before = await call(owner.secret, { method: 'GET', path: '/v1/admin/store' });
    expect(before.body).toMatchObject({ activePayouts: null });
    const recorded = [
      { caip19: draft[0]?.caip19 ?? '', address: 'Recorded1111111111111111111111111' },
    ];
    const state = emptyLedger();
    state.payto = { createdAt: NOW - 60, payouts: JSON.stringify(recorded) };
    await db.query('update ledgers set state = $2 where owner = $1', [
      owner.pubkey,
      serializeLedger(state),
    ]);
    const after = await call(owner.secret, { method: 'GET', path: '/v1/admin/store' });
    expect(after.body).toMatchObject({
      activePayouts: { createdAt: NOW - 60, payouts: recorded },
      config: { draftPayouts: draft },
    });
  });
});

describe('admin API: products', () => {
  it('writes, reads, caps and stops products', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey, 1);
    const put = (d: string, body: unknown) =>
      call(owner.secret, { method: 'PUT', path: `/v1/admin/products/${d}`, body });
    const first = await put('socks', PRODUCT);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ product: { d: 'socks', onSale: true } });
    expect(typeof first.body?.requestId).toBe('string');
    expect((await put('hats', PRODUCT)).body).toEqual({
      error: 'product_cap',
      problems: ['at most 1 products on sale'],
    });
    expect((await put('hats', { ...PRODUCT, priceUsd: 5 })).body).toMatchObject({
      error: 'bad_product',
    });
    expect((await put('hats', { ...PRODUCT, title: 'a\u0000' })).status).toBe(400);
    expect(
      (await call(owner.secret, { method: 'GET', path: '/v1/admin/products/socks' })).body,
    ).toMatchObject({ product: { title: 'Socks', priceUsd: '5' } });
    const listed = await call(owner.secret, { method: 'GET', path: '/v1/admin/products' });
    expect(listed.body?.products).toHaveLength(1);
    expect(
      (await call(owner.secret, { method: 'DELETE', path: '/v1/admin/products/socks' })).body,
    ).toMatchObject({ outcome: 'removed' });
    expect(
      (await call(owner.secret, { method: 'GET', path: '/v1/admin/products/socks' })).status,
    ).toBe(404);
  });
});

describe('admin API: owner events', () => {
  it('prepares and commits the 10133 of a pending store, whose recording waits for activation', async () => {
    const db = await freshDb();
    // No holder serves a pending store: the route does not wait for one.
    const { owner, call } = await created(db, {
      waitResult: async () => {
        throw new Error('waited for a pending store');
      },
    });
    await call(owner.secret, {
      method: 'PUT',
      path: '/v1/admin/store/config',
      body: { name: 'Shop', payouts: signedPayouts(owner.pubkey), inboxRelays: [RELAY] },
    });
    const prepared = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/prepare',
      body: { kind: KIND_PAYTO },
    });
    expect(prepared.status).toBe(200);
    const template = prepared.body?.template as Parameters<typeof finalizeEvent>[0];
    const event = finalizeEvent(template, owner.secret);
    const committed = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/commit',
      body: { event },
    });
    expect(committed.status).toBe(202);
    expect(committed.body).toMatchObject({ id: event.id, request: { state: 'pending' } });
    const again = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/commit',
      body: { event },
    });
    expect(again.body).toEqual({ id: event.id, alreadyCommitted: true });
    // Its recording failed: committing it again queues a new one, answered like the first.
    const [request] = await db.query<{ id: string }>(
      "select id from admin_requests where kind = 'record_owner_event'",
    );
    await markRequest(db, owner.pubkey, request?.id ?? '', 'failed', NOW);
    const retried = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/commit',
      body: { event },
    });
    expect(retried.status).toBe(202);
    expect(retried.body).toMatchObject({
      id: event.id,
      alreadyCommitted: true,
      request: { state: 'pending' },
    });
    expect(field(retried.body?.request, 'id')).not.toBe(request?.id);
  });

  it('refuses a commit by another key, and a stale one the relays outdate', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db, { newestOnRelays: NOW + 100 });
    const prepared = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/prepare',
      body: { kind: KIND_STORE_AUTH },
    });
    const template = prepared.body?.template as Parameters<typeof finalizeEvent>[0];
    expect(template.created_at).toBe(NOW + 101);
    const foreign = finalizeEvent(template, ownerKeys().secret);
    expect(
      (
        await call(owner.secret, {
          method: 'POST',
          path: '/v1/admin/owner-events/commit',
          body: { event: foreign },
        })
      ).body,
    ).toEqual({ error: 'author' });
    expect(
      (
        await call(owner.secret, {
          method: 'POST',
          path: '/v1/admin/owner-events/commit',
          body: { event: { kind: 1 } },
        })
      ).body,
    ).toEqual({ error: 'malformed' });
  });
});

describe('admin API: webhook secret, orders, hand answers', () => {
  it('returns the webhook secret once and never again, nor from a request', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey);
    const rotated = await call(owner.secret, { method: 'POST', path: '/v1/admin/webhook/secret' });
    const secret = rotated.body?.secret as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const store = await call(owner.secret, { method: 'GET', path: '/v1/admin/store' });
    expect(store.body).toMatchObject({ webhookSecretSet: true });
    expect(store.text).not.toContain(secret);
    const request = await call(owner.secret, {
      method: 'GET',
      path: `/v1/admin/requests/${rotated.body?.requestId as string}`,
    });
    expect(request.body).toMatchObject({ request: { kind: 'restart' } });
    expect(request.text).not.toContain(secret);
    const rows = await db.query('select * from admin_requests');
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('lists orders from the ledger row', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    expect((await call(owner.secret, { method: 'GET', path: '/v1/admin/orders' })).body).toEqual({
      orders: [],
      answeredByHand: {},
      unresolvedPayments: [],
    });
  });

  it('refuses with 409 what no holder would apply for a suspended store', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey, 2, 'suspended');
    const key = encodeURIComponent(`${'b'.repeat(64)}:order-1`);
    for (const [path, body] of [
      [`/v1/admin/orders/${key}/hand`, { kind: 'complete' }],
      ['/v1/admin/webhook/secret', undefined],
      ['/v1/admin/owner-events/prepare', { kind: KIND_STORE_AUTH }],
      ['/v1/admin/store/suspend', undefined],
    ] as const) {
      const answer = await call(owner.secret, { method: 'POST', path, body });
      expect(answer.status, path).toBe(409);
      expect(answer.body, path).toMatchObject({ error: 'suspended' });
    }
    expect(await db.query('select 1 from admin_requests')).toEqual([]);
  });

  it('queues a hand answer for a well-formed key only', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey);
    const key = encodeURIComponent(`${'b'.repeat(64)}:order/1`);
    const answered = await call(owner.secret, {
      method: 'POST',
      path: `/v1/admin/orders/${key}/hand`,
      body: { kind: 'complete' },
    });
    expect(answered.status).toBe(202);
    for (const [path, body] of [
      ['/v1/admin/orders/nokey/hand', { kind: 'complete' }],
      [`/v1/admin/orders/${key}/hand`, { kind: 'refunded', tx: 't', amount: '0' }],
      [`/v1/admin/orders/%E0%A4%A/hand`, { kind: 'complete' }],
    ] as const) {
      expect((await call(owner.secret, { method: 'POST', path, body })).status).toBe(400);
    }
  });
});
