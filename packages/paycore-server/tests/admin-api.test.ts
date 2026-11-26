import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import { emptyLedger } from '@merchant-node/ledger';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ADMIN_PREFIX, NEW_STORES_PER_IP_PER_HOUR, createAdminApi } from '../src/admin/api';
import {
  type AdminRequest,
  type RequestKind,
  insertRequest,
  markRequest,
} from '../src/admin/requests';
import type { Db } from '../src/db/db';
import { serializeLedger } from '../src/state/ledger-store';
import { ConfigInputSchema } from '../src/state/stores';
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
    const base = { name: 'Shop', payouts, inboxRelays: [RELAY], expectedRevision: 1 };
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
    await markRequest(db, owner.pubkey, id, 'applied', NOW, { suspending: true, entered: true });
    expect((await call(owner.secret, { method: 'GET', path })).body).toMatchObject({
      request: { state: 'applied', result: { suspending: true, entered: true }, appliedAt: NOW },
    });
    expect((await call(ownerKeys().secret, { method: 'GET', path })).status).toBe(404);
  });

  it('answers 200 with the result when the holder applies within the wait', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db, {
      waitResult: async (requestOwner, id) => {
        await markRequest(db, requestOwner, id, 'applied', NOW, { suspending: true });
        return {
          id,
          owner: requestOwner,
          kind: 'suspend',
          payload: {},
          state: 'applied',
          result: { suspending: true },
          createdAt: NOW,
          appliedAt: NOW,
        };
      },
    });
    await activate(db, owner.pubkey);
    const response = await call(owner.secret, { method: 'POST', path: '/v1/admin/store/suspend' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      request: { state: 'applied', result: { suspending: true } },
    });
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
          body: { name: 'Shop', payouts: draft, inboxRelays: [RELAY], expectedRevision: 1 },
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
      body: {
        name: 'Shop',
        payouts: signedPayouts(owner.pubkey),
        inboxRelays: [RELAY],
        expectedRevision: 1,
      },
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

const RAW_TEXT = 'fetch failed. URL: https://rpc.example/?api-key=SECRET123';

describe('admin API: store view (phase 2)', () => {
  it('shows a pending store the pending cap, no alerts, nothing to sign and no owner events', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const view = await call(owner.secret, { method: 'GET', path: '/v1/admin/store' });
    expect(view.body).toMatchObject({
      status: 'pending',
      tier: null,
      maxProducts: 20,
      alerts: [],
      payouts: { needsSigning: false },
      ownerEvents: { payto: null, auth: null },
    });
    expect(view.body).not.toHaveProperty('statusReason');
    await activate(db, owner.pubkey, 7);
    expect(
      (await call(owner.secret, { method: 'GET', path: '/v1/admin/store' })).body,
    ).toMatchObject({ tier: 'tier-7', maxProducts: 7 });
  });

  it('shows open alert kinds, never their messages nor the status reason', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey, 2, 'degraded');
    await db.query('update stores set status_reason = $2 where owner = $1', [
      owner.pubkey,
      `rail_unavailable: ${RAW_TEXT}`,
    ]);
    for (const [kind, cleared] of [
      ['rail_unavailable', null],
      ['drift', null],
      ['setup_failed', NOW],
    ] as const) {
      await db.query(
        `insert into alerts (owner, kind, message, created_at, last_seen_at, cleared_at)
         values ($1, $2, $3, $4, $4, $5)`,
        [owner.pubkey, kind, RAW_TEXT, NOW, cleared],
      );
    }
    await db.query(
      `insert into alerts (owner, kind, message, created_at, last_seen_at) values ($1, 'other', $2, $3, $3)`,
      [ownerKeys().pubkey, RAW_TEXT, NOW],
    );
    const view = await call(owner.secret, { method: 'GET', path: '/v1/admin/store' });
    expect(view.body).toMatchObject({ status: 'degraded', alerts: ['drift', 'rail_unavailable'] });
    expect(view.text).not.toContain('SECRET123');
    expect(view.text).not.toContain('rpc.example');
  });

  it('tracks the payout list to sign against the newest committed one, a pending store included', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db, {
      waitResult: async () => {
        throw new Error('waited for a pending store');
      },
    });
    const view = async () =>
      (await call(owner.secret, { method: 'GET', path: '/v1/admin/store' })).body ?? {};
    const config = { name: 'Shop', inboxRelays: [RELAY] };
    expect(
      (
        await call(owner.secret, {
          method: 'PUT',
          path: '/v1/admin/store/config',
          body: { ...config, payouts: signedPayouts(owner.pubkey), expectedRevision: 1 },
        })
      ).status,
    ).toBe(200);
    expect(await view()).toMatchObject({ payouts: { needsSigning: true } });
    const sign = async () => {
      const prepared = await call(owner.secret, {
        method: 'POST',
        path: '/v1/admin/owner-events/prepare',
        body: { kind: KIND_PAYTO },
      });
      return finalizeEvent(
        prepared.body?.template as Parameters<typeof finalizeEvent>[0],
        owner.secret,
      );
    };
    const event = await sign();
    const commit = (signed: unknown) =>
      call(owner.secret, {
        method: 'POST',
        path: '/v1/admin/owner-events/commit',
        body: { event: signed },
      });
    // Pending: no holder, the commit answers 202 and `state.payto` stays unset.
    expect((await commit(event)).status).toBe(202);
    const committed = await view();
    expect(committed).toMatchObject({
      payouts: { needsSigning: false },
      activePayouts: null,
      ownerEvents: { payto: { event, committedAt: NOW, publishedAt: null }, auth: null },
    });
    // Its recording failed: still signed (nothing to sign), not published; Retry posts the view's event back.
    const [request] = await db.query<{ id: string }>(
      "select id from admin_requests where kind = 'record_owner_event'",
    );
    await markRequest(db, owner.pubkey, request?.id ?? '', 'failed', NOW, { problem: RAW_TEXT });
    const failed = await view();
    expect(failed).toMatchObject({
      payouts: { needsSigning: false },
      ownerEvents: { payto: { publishedAt: null } },
    });
    const shown = field(field(field(failed, 'ownerEvents'), 'payto'), 'event');
    expect(shown).toEqual(JSON.parse(JSON.stringify(event)));
    const retried = await commit(shown);
    expect(retried.status).toBe(202);
    expect(retried.body).toMatchObject({ id: event.id, alreadyCommitted: true });
    await db.query('update owner_events set published_at = $2 where id = $1', [event.id, NOW + 5]);
    expect(await view()).toMatchObject({ ownerEvents: { payto: { publishedAt: NOW + 5 } } });
    // A new draft needs a new signature; once committed, the newer list is the one shown.
    expect(
      (
        await call(owner.secret, {
          method: 'PUT',
          path: '/v1/admin/store/config',
          body: { ...config, payouts: signedPayouts(owner.pubkey), expectedRevision: 2 },
        })
      ).status,
    ).toBe(200);
    expect(await view()).toMatchObject({ payouts: { needsSigning: true } });
    const newer = await sign();
    expect(newer.created_at).toBeGreaterThan(event.created_at);
    expect((await commit(newer)).status).toBe(202);
    expect(await view()).toMatchObject({
      payouts: { needsSigning: false },
      ownerEvents: { payto: { event: newer, publishedAt: null } },
    });
    // The newest by `created_at`, not by commit time.
    await db.query('update owner_events set committed_at = $2 where id = $1', [event.id, NOW + 99]);
    expect(await view()).toMatchObject({ ownerEvents: { payto: { event: newer } } });
  });

  it('shows the committed authorization', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const prepared = await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/prepare',
      body: { kind: KIND_STORE_AUTH },
    });
    const event = finalizeEvent(
      prepared.body?.template as Parameters<typeof finalizeEvent>[0],
      owner.secret,
    );
    await call(owner.secret, {
      method: 'POST',
      path: '/v1/admin/owner-events/commit',
      body: { event },
    });
    expect(
      (await call(owner.secret, { method: 'GET', path: '/v1/admin/store' })).body,
    ).toMatchObject({
      payouts: { needsSigning: false },
      ownerEvents: { payto: null, auth: { event, committedAt: NOW, publishedAt: null } },
    });
  });
});

describe('admin API: config revision', () => {
  it('keeps every field of a full PUT built from the view, and refuses a stale revision', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    const put = (body: unknown) =>
      call(owner.secret, { method: 'PUT', path: '/v1/admin/store/config', body });
    const payouts = signedPayouts(owner.pubkey);
    const first = await put({
      name: 'Shop',
      payouts,
      inboxRelays: [RELAY],
      webhookUrl: 'https://hooks.example/x',
      evmCredit: 'safe',
      expectedRevision: 1,
    });
    expect(first.status).toBe(200);
    const config = (await call(owner.secret, { method: 'GET', path: '/v1/admin/store' })).body
      ?.config as {
      name: string;
      draftPayouts: unknown;
      inboxRelays: string[];
      webhookUrl?: string;
      evmCredit: string;
      revision: number;
    };
    expect(config).toMatchObject({
      revision: 2,
      webhookUrl: 'https://hooks.example/x',
      evmCredit: 'safe',
    });
    const full = {
      name: 'Renamed',
      payouts: config.draftPayouts,
      inboxRelays: config.inboxRelays,
      webhookUrl: config.webhookUrl ?? null,
      evmCredit: config.evmCredit,
      expectedRevision: config.revision,
    };
    const second = await put(full);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      config: {
        name: 'Renamed',
        webhookUrl: 'https://hooks.example/x',
        evmCredit: 'safe',
        draftPayouts: payouts,
        revision: 3,
      },
    });
    const stale = await put({ ...full, name: 'Late' });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'stale_config' });
    // The admin route needs the revision; the import's schema stays without one.
    const { expectedRevision: _revision, ...withoutRevision } = full;
    expect((await put(withoutRevision)).status).toBe(400);
    expect((await put({ ...full, expectedRevision: -1 })).status).toBe(400);
    expect(ConfigInputSchema.safeParse(full).success).toBe(false);
    expect(ConfigInputSchema.safeParse(withoutRevision).success).toBe(true);
    expect(
      (await call(owner.secret, { method: 'GET', path: '/v1/admin/store' })).body,
    ).toMatchObject({ config: { name: 'Renamed', revision: 3 } });
  });
});

describe('admin API: request results (A15)', () => {
  it('shows a whitelisted result, a failure only as its code, never the recorded text', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey);
    const key = `${'b'.repeat(64)}:order-1`;
    const cases: [RequestKind, 'applied' | 'failed', unknown, unknown][] = [
      ['setup', 'failed', { problem: RAW_TEXT }, { code: 'setup_failed' }],
      ['record_owner_event', 'failed', { problem: RAW_TEXT }, { code: 'setup_failed' }],
      [
        'record_owner_event',
        'failed',
        { problem: 'no such owner event' },
        { code: 'no_owner_event' },
      ],
      ['hand_answer', 'failed', { problem: `no order ${key} in the ledger` }, { code: 'no_order' }],
      [
        'hand_answer',
        'failed',
        { problem: `${key} was already answered as delivered: the other answer is refused` },
        { code: 'already_answered' },
      ],
      [
        'hand_answer',
        'failed',
        {
          problem: `${key} is paid: the node completes it itself (a refund of a paid order is not handled here)`,
        },
        { code: 'order_paid' },
      ],
      [
        'hand_answer',
        'failed',
        { problem: 'the refund tx is neither a Solana signature nor a Tempo hash' },
        { code: 'bad_refund_tx' },
      ],
      [
        'hand_answer',
        'failed',
        {
          problem:
            'the refund amount must be subunits above 0 (an unpaid order is released with complete, never a zero refund)',
        },
        { code: 'bad_refund_amount' },
      ],
      [
        'hand_answer',
        'failed',
        { problem: 'the store has several payouts: pass --asset <caip19> for the coin refunded' },
        { code: 'bad_refund_asset' },
      ],
      [
        'hand_answer',
        'failed',
        { problem: '--asset eip155:1/erc20:0x00 is not an asset this node knows' },
        { code: 'bad_refund_asset' },
      ],
      ['hand_answer', 'failed', { problem: 'not a hand answer' }, { code: 'bad_request' }],
      [
        'hand_answer',
        'applied',
        { done: false, problem: RAW_TEXT },
        { done: false, code: 'failed' },
      ],
      [
        'hand_answer',
        'applied',
        { done: true, rerun: false, taken: 2, copyTaken: 1, relays: 2, extra: RAW_TEXT },
        { done: true, rerun: false, taken: 2, copyTaken: 1, relays: 2 },
      ],
      ['suspend', 'failed', undefined, { code: 'failed' }],
      [
        'suspend',
        'applied',
        { suspending: true, entered: false },
        { suspending: true, entered: false },
      ],
      ['restart', 'applied', { restarted: true, note: RAW_TEXT }, { restarted: true }],
      ['setup', 'applied', { coveredBy: 'abc123' }, { coveredBy: 'abc123' }],
      ['setup', 'applied', { coveredBy: RAW_TEXT }, null],
      ['setup', 'applied', { setup: 'no_payout_list' }, { setup: 'no_payout_list' }],
      [
        'setup',
        'applied',
        {
          setup: 'done',
          payoutListOut: true,
          authorizationOut: null,
          listings: [
            { d: 'socks', listing: 'out' },
            { d: 'hats', listing: RAW_TEXT },
          ],
          missedDefaults: ['the payout list', 'products/socks', RAW_TEXT],
        },
        {
          setup: 'done',
          payoutListOut: true,
          authorizationOut: null,
          listings: [{ d: 'socks', listing: 'out' }],
          missedDefaults: ['the payout list', 'products/socks'],
        },
      ],
      [
        'record_owner_event',
        'applied',
        { recorded: false, replacedBy: 'f'.repeat(64) },
        { recorded: false, replacedBy: 'f'.repeat(64) },
      ],
      ['setup', 'applied', { problem: { nested: RAW_TEXT } }, null],
    ];
    for (const [kind, state, result, expected] of cases) {
      const id = await db.transaction((tx) => insertRequest(tx, owner.pubkey, kind, {}, NOW));
      await markRequest(db, owner.pubkey, id, state, NOW, result);
      const answer = await call(owner.secret, { method: 'GET', path: `/v1/admin/requests/${id}` });
      const label = `${kind} ${JSON.stringify(result)}`;
      expect(answer.body?.request, label).toMatchObject({ id, kind, state });
      expect(field(answer.body?.request, 'result'), label).toEqual(expected);
      expect(answer.text, label).not.toContain('SECRET123');
      expect(answer.text, label).not.toContain('order-1');
    }
  });

  it('whitelists the result a request route waits for too', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db, {
      waitResult: async (requestOwner, id) => {
        await markRequest(db, requestOwner, id, 'failed', NOW, { problem: RAW_TEXT });
        return {
          id,
          owner: requestOwner,
          kind: 'hand_answer',
          payload: {},
          state: 'failed',
          result: { problem: RAW_TEXT },
          createdAt: NOW,
          appliedAt: NOW,
        };
      },
    });
    await activate(db, owner.pubkey);
    const answered = await call(owner.secret, {
      method: 'POST',
      path: `/v1/admin/orders/${encodeURIComponent(`${'b'.repeat(64)}:x`)}/hand`,
      body: { kind: 'complete' },
    });
    expect(answered.status).toBe(422);
    expect(answered.body).toMatchObject({
      request: { state: 'failed', result: { code: 'failed' } },
    });
    expect(answered.text).not.toContain('SECRET123');
  });

  it('names the current product title in the orders answer', async () => {
    const db = await freshDb();
    const { owner, call } = await created(db);
    await activate(db, owner.pubkey);
    await call(owner.secret, { method: 'PUT', path: '/v1/admin/products/socks', body: PRODUCT });
    const state = emptyLedger();
    const buyer = 'b'.repeat(64);
    for (const [orderId, d] of [
      ['one', 'socks'],
      ['two', 'gone'],
    ] as const) {
      state.orders[`${buyer}:${orderId}`] = {
        key: `${buyer}:${orderId}`,
        buyerPubkey: buyer,
        orderId,
        rumorId: 'r',
        createdAt: orderId === 'one' ? 1 : 2,
        reference: 'ref',
        product: `30402:s:${d}`,
        reportedTxs: [],
      };
    }
    await db.query('update ledgers set state = $2 where owner = $1', [
      owner.pubkey,
      serializeLedger(state),
    ]);
    const orders = await call(owner.secret, { method: 'GET', path: '/v1/admin/orders' });
    expect(orders.body).toMatchObject({
      orders: [
        { orderId: 'two', productTitle: null },
        { orderId: 'one', productTitle: 'Socks' },
      ],
    });
  });
});
