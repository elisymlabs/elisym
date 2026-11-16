import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { createGateway } from '../src/gateway/gateway';
import { onSharedHost } from '../src/state/origins';
import { ORIGIN_DROPPED_GRACE_SECS, ORIGIN_PROOF_AGE_SECS } from '../src/state/stores';
import { FakeWeb, MemoryRelay } from './connectors/helpers';
import { HOLDER, NOW, stateWith, storeRecord, syntheticStore } from './fixtures';

const BASE = 'https://api.askr.test';
const SHOP = 'https://shop.example';
const LONG_AGO = NOW - ORIGIN_PROOF_AGE_SECS - 60;

function header(secret: Uint8Array, method: string, path: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: NOW,
      tags: [
        ['u', `${BASE}${path}`],
        ['method', method],
        ...(body ? [['payload', sha256Hex(body)]] : []),
        ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
      ],
      content: '',
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

interface Options {
  source?: 'admin' | 'paycore';
  /** When the store's site was first seen; undefined records none. */
  siteSeenAt?: number | undefined;
  /** What the shop's home page carries, given the new key's npub. */
  page?: (npub: string) => string;
}

async function setup(options: Options = {}) {
  const store = syntheticStore();
  const seeded = await stateWith([storeRecord(store)]);
  const relay = new MemoryRelay();
  relay.events.push(
    finalizeEvent(
      buildCatalogAuth({ key: store.catalogKey, mode: 'hosted', createdAt: NOW - 100 }),
      store.ownerSecret,
    ),
  );
  const paycoreKey = getPublicKey(generateSecretKey());
  const configEvent = finalizeEvent(
    buildConfigEvent(
      {
        assistant: store.assistant,
        origins: [SHOP],
        linkOrigins: [],
        name: 'Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: options.source ?? 'admin' },
        catalogKey: options.source === 'paycore' ? paycoreKey : store.catalogKey,
        ...(options.source === 'paycore' ? { policyKey: store.catalogKey } : {}),
        private: { voice: 'warm', instructions: 'Sell tea', notes: 'n' },
        createdAt: NOW - 50,
      },
      store.ownerSecret,
    ),
    store.ownerSecret,
  );
  relay.events.push(configEvent);
  if (options.siteSeenAt !== undefined) {
    await seeded.directory.noteOrigins(store.owner, [SHOP], options.siteSeenAt);
  }
  const newSecret = generateSecretKey();
  const newOwner = getPublicKey(newSecret);
  const page =
    options.page ??
    ((npub: string) =>
      `<html><head><meta name="askr-verification" content="${npub}"></head></html>`);
  /** The key the shop's page names: the new one unless a test changes it. */
  const site = { owner: newOwner };
  const web = new FakeWeb().route(`${SHOP}/`, () => ({
    headers: { 'content-type': 'text/html' },
    body: page(npubEncode(site.owner)),
  }));
  const connectors = new ConnectorService({
    directory: seeded.directory,
    holder: HOLDER,
    client: relay,
    configFor: () => undefined,
    limiter: new ShopRateLimiter(0),
    proofLimiter: new ShopRateLimiter(0),
    fetch: web.deps(),
  });
  const api = createAdminApi({
    directory: seeded.directory,
    publicBase: BASE,
    syncClient: relay,
    storeEventsChanged: () => undefined,
    connectors,
    now: () => NOW,
  });
  let address = 0;
  const call = async (
    method: string,
    path: string,
    secret: Uint8Array,
    body?: unknown,
    clientAddress?: string,
  ) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    address += 1;
    const response = await api({
      request: new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: header(secret, method, path, text) },
        ...(text ? { body: text } : {}),
      }),
      clientAddress: clientAddress ?? `203.0.113.${address}`,
    });
    if (!response) {
      throw new Error('not an admin path');
    }
    return { status: response.status, body: await response.json() };
  };
  const recover = (from: string, secret = newSecret, clientAddress?: string, dryRun?: boolean) =>
    call(
      'POST',
      '/v1/admin/store/recover',
      secret,
      { from, ...(dryRun === undefined ? {} : { dryRun }) },
      clientAddress,
    );
  return { store, seeded, relay, web, site, newSecret, newOwner, call, recover, configEvent };
}

describe('replacing an owner key through the site (K21)', () => {
  it('moves the store to the new key: keys kept and readable, rows renamed, old events dropped', async () => {
    const { store, seeded, newOwner, recover, configEvent } = await setup({
      siteSeenAt: LONG_AGO,
    });
    const { db, directory, state } = seeded;
    await directory.setConnector(store.owner, {
      platform: 'shopify',
      url: SHOP,
      importPolicies: true,
    });
    await db.query(
      `insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb)`,
      [configEvent.id, store.owner, JSON.stringify(configEvent)],
    );
    await db.query(`insert into clicks (owner, address, count) values ($1, 'a', 3)`, [store.owner]);
    await db.query(`insert into store_totals (owner, conversations) values ($1, 7)`, [store.owner]);
    const moved = await recover(npubEncode(store.owner));
    expect(moved.body).toMatchObject({ owner: newOwner });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ owner: newOwner, proven: SHOP, movedFrom: store.owner });
    expect(await directory.store(store.owner)).toBeUndefined();
    const record = await state.store(newOwner);
    // A and K are the same keys, sealed again for the new owner: they still open.
    expect(record?.assistant).toBe(store.assistant);
    expect(record?.catalogKey).toBe(store.catalogKey);
    expect(record?.assistantSecretKey).toEqual(store.assistantSecret);
    expect(record?.catalogSecretKey).toEqual(store.catalogSecret);
    expect(record?.tier).toBeDefined();
    expect((await directory.connector(newOwner))?.url).toBe(SHOP);
    expect(await db.query('select 1 from store_events')).toHaveLength(0);
    expect(await db.query('select count from clicks where owner = $1', [newOwner])).toHaveLength(1);
    expect(
      await db.query('select conversations from store_totals where owner = $1', [newOwner]),
    ).toHaveLength(1);
    expect((await directory.originsHeld(newOwner)).map((entry) => entry.origin)).toEqual([SHOP]);
    expect(await directory.movedTo(store.owner)).toBe(newOwner);
  });

  it('gives the new owner the private part the old key sealed, read with A', async () => {
    const { store, newSecret, recover, call } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    const settings = await call('GET', '/v1/admin/store/moved-settings', newSecret);
    expect(settings.status).toBe(200);
    expect(settings.body.from).toBe(store.owner);
    expect(settings.body.config.pubkey).toBe(store.owner);
    expect(settings.body.private).toEqual({ voice: 'warm', instructions: 'Sell tea', notes: 'n' });
  });

  it('refuses a site the store has had for less than 72 hours, and says when it will count', async () => {
    const seen = NOW - ORIGIN_PROOF_AGE_SECS + 600;
    const { store, recover } = await setup({ siteSeenAt: seen });
    const refused = await recover(store.owner);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: 'no_site_yet', readyAt: seen + ORIGIN_PROOF_AGE_SECS },
    });
  });

  it('refuses a store with no site on record', async () => {
    const { store, recover } = await setup();
    expect((await recover(store.owner)).body).toMatchObject({
      error: 'no_site_yet',
      readyAt: null,
    });
  });

  it('refuses when the site does not name the new key, and moves nothing', async () => {
    const { store, seeded, recover, web } = await setup({
      siteSeenAt: LONG_AGO,
      page: () => '<html><head></head></html>',
    });
    const refused = await recover(store.owner);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: 'site_not_proven', failures: [{ origin: SHOP, reason: 'not_found' }] },
    });
    expect(await seeded.directory.store(store.owner)).toBeDefined();
    expect(web.urls).toContain(`${SHOP}/.well-known/askr`);
  });

  it('accepts the proof from the well-known file too', async () => {
    const { store, recover, web, newOwner } = await setup({
      siteSeenAt: LONG_AGO,
      page: () => '<html></html>',
    });
    web.route(`${SHOP}/.well-known/askr`, {
      headers: { 'content-type': 'text/plain' },
      body: `${npubEncode(newOwner)}\n`,
    });
    expect((await recover(store.owner)).status).toBe(200);
  });

  it('a site the old key dropped from its settings still proves it', async () => {
    const { store, seeded, recover } = await setup({ siteSeenAt: LONG_AGO });
    // A thief with the old key cannot take the owner's site off the record by editing settings.
    await seeded.directory.noteOrigins(store.owner, ['https://thief.example'], NOW);
    expect((await recover(store.owner)).status).toBe(200);
  });

  it('moves a Pay Core store too: a thief cannot turn recovery into "contact us" by its source', async () => {
    const { store, recover } = await setup({ siteSeenAt: LONG_AGO, source: 'paycore' });
    expect((await recover(store.owner)).status).toBe(200);
  });

  it('refuses a new key that is a store or a key a store left, and an unknown or bad store', async () => {
    const { store, seeded, recover, newSecret } = await setup({ siteSeenAt: LONG_AGO });
    const other = syntheticStore();
    await seeded.db.query(
      `insert into stores (owner, status, assistant, assistant_key, catalog_key, catalog_key_secret, created_at)
       select $1, 'pending', $2, assistant_key, $3, catalog_key_secret, 0 from stores limit 1`,
      [getPublicKey(newSecret), other.assistant, other.catalogKey],
    );
    expect((await recover(store.owner)).body).toMatchObject({ error: 'key_in_use' });
    const fresh = generateSecretKey();
    expect((await recover(getPublicKey(generateSecretKey()), fresh)).status).toBe(404);
    expect((await recover('not a key', fresh)).status).toBe(400);
    expect((await recover(getPublicKey(fresh), fresh)).status).toBe(400);
  });

  it('a key a store moved away from never opens a store again', async () => {
    const { store, recover, call } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    expect((await call('POST', '/v1/admin/store', store.ownerSecret)).body).toMatchObject({
      error: 'moved',
    });
  });

  it('takes a store back from where a thief moved it, starting from the original Store ID', async () => {
    const { store, seeded, site, recover } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    const ownerAgain = generateSecretKey();
    site.owner = getPublicKey(ownerAgain);
    const back = await recover(store.owner, ownerAgain);
    expect(back.status).toBe(200);
    expect(await seeded.directory.movedTo(store.owner)).toBe(getPublicKey(ownerAgain));
  });

  it('answers a retried move with its result, not an error', async () => {
    const { store, recover, newOwner } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    const again = await recover(npubEncode(store.owner));
    expect(again).toMatchObject({ status: 200, body: { owner: newOwner } });
  });

  it('checks all but the site on a dry run, reading no site and moving nothing', async () => {
    const { store, seeded, web, recover } = await setup({ siteSeenAt: LONG_AGO });
    const dry = await recover(store.owner, generateSecretKey(), undefined, true);
    expect(dry).toMatchObject({ status: 200, body: { ok: true } });
    expect(web.requests).toHaveLength(0);
    expect(await seeded.directory.store(store.owner)).toBeDefined();
    const early = await setup({ siteSeenAt: NOW });
    expect(
      (await early.recover(early.store.owner, generateSecretKey(), undefined, true)).body,
    ).toMatchObject({ error: 'no_site_yet' });
  });

  it('a site counts until 30 days after it was last seen listed', async () => {
    const DROPPED = 'https://dropped.example';
    const dropped = await setup();
    await dropped.seeded.directory.noteOrigins(dropped.store.owner, [DROPPED], LONG_AGO);
    dropped.web.route(`${DROPPED}/.well-known/askr`, {
      headers: { 'content-type': 'text/plain' },
      body: npubEncode(dropped.newOwner),
    });
    await dropped.seeded.db.query('update store_origins set last_seen = $1', [
      NOW - ORIGIN_DROPPED_GRACE_SECS - 1,
    ]);
    expect((await dropped.recover(dropped.store.owner)).body).toMatchObject({
      error: 'no_site_yet',
      readyAt: null,
    });
    await dropped.seeded.db.query('update store_origins set last_seen = $1', [
      NOW - ORIGIN_DROPPED_GRACE_SECS + 60,
    ]);
    expect((await dropped.recover(dropped.store.owner)).body).toMatchObject({ proven: DROPPED });

    // A site still listed but not seen for longer (a store nobody serves, a domain that may have
    // lapsed) does not count either: a served store's sites are noted again every few hours.
    const lapsed = await setup({ siteSeenAt: LONG_AGO });
    await lapsed.seeded.db.query('update store_origins set last_seen = $1', [
      NOW - 10 * ORIGIN_DROPPED_GRACE_SECS,
    ]);
    expect((await lapsed.recover(lapsed.store.owner)).body).toMatchObject({ error: 'no_site_yet' });
  });

  it('never counts a site on a shared host, however its name is written', async () => {
    for (const origin of ['https://my-shop.vercel.app', 'https://my-shop.vercel.app.']) {
      const shared = await setup();
      await shared.seeded.directory.noteOrigins(shared.store.owner, [origin], LONG_AGO);
      expect((await shared.recover(shared.store.owner)).body).toMatchObject({
        error: 'no_site_yet',
      });
    }
    expect(onSharedHost('https://vercel.app')).toBe(false);
    expect(onSharedHost('https://shop.WixSite.com')).toBe(true);
  });

  it('reads the sites held longest first, so ones a thief added later never crowd out the owner', async () => {
    const { store, seeded, web, recover, newOwner } = await setup({
      siteSeenAt: LONG_AGO - 600,
      page: () => '<html></html>',
    });
    const later = Array.from({ length: 12 }, (_unused, index) => `https://t${index}.thief.example`);
    await seeded.directory.noteOrigins(store.owner, later, LONG_AGO);
    web.route(`${SHOP}/.well-known/askr`, {
      headers: { 'content-type': 'text/plain' },
      body: npubEncode(newOwner),
    });
    const moved = await recover(store.owner);
    expect(moved.body).toMatchObject({ proven: SHOP });
    expect(web.urls.some((url) => url.includes('thief.example'))).toBe(false);
    // At most ten sites are read, the oldest ones.
    const second = await setup({ siteSeenAt: LONG_AGO, page: () => '<html></html>' });
    await second.seeded.directory.noteOrigins(second.store.owner, later, LONG_AGO);
    const refused = await second.recover(second.store.owner);
    expect(refused.body).toMatchObject({ error: 'site_not_proven', unlisted: 9 });
    expect(second.web.urls.some((url) => url.includes('t9.thief'))).toBe(false);
  });

  it('names only the sites the settings list now when none proves it', async () => {
    const { store, seeded, recover } = await setup({
      siteSeenAt: LONG_AGO,
      page: () => '<html></html>',
    });
    await seeded.directory.noteOrigins(store.owner, ['https://old.example'], LONG_AGO);
    const refused = await recover(store.owner);
    expect(refused.body).toMatchObject({
      error: 'site_not_proven',
      failures: [{ origin: SHOP, reason: 'not_found' }],
      unlisted: 1,
    });
    expect(JSON.stringify(refused.body)).not.toContain('old.example');
  });

  it('tries the next site when the first does not prove it', async () => {
    const { store, seeded, web, recover, newOwner } = await setup({
      siteSeenAt: LONG_AGO,
      page: () => '<html></html>',
    });
    await seeded.directory.noteOrigins(store.owner, ['https://second.example'], LONG_AGO);
    await seeded.db.query('update store_origins set last_seen = $1 where origin = $2', [
      LONG_AGO,
      'https://second.example',
    ]);
    web.route('https://second.example/.well-known/askr', {
      headers: { 'content-type': 'text/plain' },
      body: npubEncode(newOwner),
    });
    expect((await recover(store.owner)).body).toMatchObject({ proven: 'https://second.example' });
  });

  it('ignores a config dated far ahead: a thief cannot pin the settings the owner signs again', async () => {
    const { store, relay, recover, newSecret, call } = await setup({ siteSeenAt: LONG_AGO });
    relay.events.push(
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: store.assistant,
            origins: ['https://thief.example'],
            linkOrigins: [],
            name: 'Thief',
            language: 'en',
            currency: 'USD',
            source: { kind: 'admin' },
            catalogKey: store.catalogKey,
            createdAt: NOW + 3_600,
          },
          store.ownerSecret,
        ),
        store.ownerSecret,
      ),
    );
    expect((await recover(store.owner)).status).toBe(200);
    const settings = await call('GET', '/v1/admin/store/moved-settings', newSecret);
    expect(settings.body.config.content).not.toContain('Thief');
    expect(JSON.stringify(settings.body.config.tags)).toContain('Shop');
  });

  it('limits tries per client address, never per store, so nobody can lock its owner out', async () => {
    const { store, recover } = await setup({ siteSeenAt: NOW });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await recover(store.owner, generateSecretKey(), '198.51.100.1')).status).toBe(409);
    }
    expect((await recover(store.owner, generateSecretKey(), '198.51.100.1')).status).toBe(429);
    expect((await recover(store.owner, generateSecretKey(), '198.51.100.2')).status).toBe(409);
  });

  it('records the origins of a config the admin stores, dated by the server', async () => {
    const { store, seeded } = await setup();
    const event = finalizeEvent(
      buildConfigEvent(
        {
          assistant: store.assistant,
          origins: ['https://new.example'],
          linkOrigins: [],
          name: 'Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: store.catalogKey,
          createdAt: NOW - 10 * ORIGIN_PROOF_AGE_SECS,
        },
        store.ownerSecret,
      ),
      store.ownerSecret,
    );
    expect((await seeded.directory.addEvents(store.owner, [event])).ok).toBe(true);
    const held = await seeded.directory.originsHeld(store.owner);
    // A backdated config proves nothing: the date is the server's, not the event's.
    expect(held.map((entry) => entry.origin)).toEqual(['https://new.example']);
    expect(held[0]?.firstSeen).toBeGreaterThan(NOW);
  });
});

describe('the gateway after a move (K21)', () => {
  it('points a widget embedded with the old key at the new one, and refuses an unknown store', async () => {
    const { store, seeded, recover, newOwner } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    const gateway = createGateway({
      state: seeded.state,
      gatewaySecretKey: generateSecretKey(),
      configFor: () => undefined,
      isListed: () => false,
      isUnservable: () => false,
      reserveUsd: '0.25',
      now: () => NOW,
    });
    const session = (owner: string) =>
      gateway({
        request: new Request('http://localhost/v1/session', {
          method: 'POST',
          headers: { origin: SHOP, 'content-type': 'application/json' },
          body: JSON.stringify({ store: owner, visitor: getPublicKey(generateSecretKey()) }),
        }),
        clientAddress: '203.0.113.50',
      });
    const moved = await session(store.owner);
    expect(moved?.status).toBe(410);
    expect(await moved?.json()).toMatchObject({
      unavailable: true,
      reason: 'moved',
      moved: newOwner,
    });
    expect((await session(getPublicKey(generateSecretKey())))?.status).toBe(403);
  });
});

describe('moves and origins in the state (K21)', () => {
  it('follows a store across every move, from any key it left', async () => {
    const { store, seeded } = await setup();
    const keys = Array.from({ length: 6 }, () => getPublicKey(generateSecretKey()));
    let from = store.owner;
    for (const key of keys) {
      expect(await seeded.directory.moveStore(from, key, NOW, undefined)).toEqual({ ok: true });
      from = key;
    }
    expect(await seeded.state.movedTo(store.owner)).toBe(keys[5]);
    expect(await seeded.state.movedTo(keys[2] ?? '')).toBe(keys[5]);
    expect(await seeded.state.movedTo(keys[5] ?? '')).toBeUndefined();
    expect(await seeded.directory.moveStore(store.owner, keys[0] ?? '', NOW, undefined)).toEqual({
      ok: false,
      reason: 'moved',
    });
  });

  it('notes an origin once, from when it was first seen, and only for a store', async () => {
    const { store, seeded } = await setup();
    await seeded.state.noteOrigins(store.owner, [SHOP, SHOP], NOW - 100);
    await seeded.state.noteOrigins(store.owner, [SHOP], NOW);
    await seeded.state.noteOrigins(getPublicKey(generateSecretKey()), [SHOP], NOW);
    expect(await seeded.directory.originsHeld(store.owner)).toEqual([
      { origin: SHOP, firstSeen: NOW - 100, lastSeen: NOW },
    ]);
    expect(await seeded.db.query('select 1 from store_origins')).toHaveLength(1);
  });
});

describe('the move itself (K21)', () => {
  it('carries sessions, budgets and reservations, drops the lease, frees a sync guard, keeps the newest move', async () => {
    const { store, seeded } = await setup();
    const { db, directory, state } = seeded;
    const visitor = getPublicKey(generateSecretKey());
    await state.session(store.owner, store.assistant, visitor, NOW);
    await db.query(`insert into store_days (owner, day, spent) values ($1, 1, 2)`, [store.owner]);
    await db.query(
      `insert into reservations (attempt_id, owner, day, amount, created_at) values ('r', $1, 1, 1, 0)`,
      [store.owner],
    );
    await state.acquireLeases(HOLDER, NOW, 60);
    await db.query(
      `insert into catalog_syncs (owner, holder, expires_at, state) values ($1, 'h', $2, 'running')`,
      [store.owner, NOW + 600],
    );
    const middle = getPublicKey(generateSecretKey());
    const last = getPublicKey(generateSecretKey());
    expect(await directory.moveStore(store.owner, middle, NOW, undefined)).toEqual({ ok: true });
    for (const table of ['sessions', 'store_days', 'reservations']) {
      const rows = await db.query<{ owner: string }>(`select owner from ${table}`);
      expect(rows.map((row) => row.owner)).toEqual([middle]);
    }
    expect(await db.query('select 1 from leases')).toHaveLength(0);
    const [guard] = await db.query<{ holder: string | null }>('select holder from catalog_syncs');
    expect(guard?.holder).toBeNull();
    expect(await directory.moveStore(middle, last, NOW + 10, undefined)).toEqual({ ok: true });
    expect((await directory.movedFrom(last))?.from).toBe(middle);
    // A key a store left, or one that is a store, is taken.
    expect(await directory.moveStore(last, middle, NOW + 20, undefined)).toEqual({
      ok: false,
      reason: 'taken',
    });
  });

  it('reads the private part sealed for the next assistant key mid-rotation', async () => {
    const { store, seeded, call, newSecret, newOwner } = await setup({ siteSeenAt: LONG_AGO });
    const next = await seeded.directory.beginRotation(store.owner);
    const nextSecret = await seeded.directory.nextAssistantSecret(store.owner);
    if (next === undefined || nextSecret === undefined) {
      throw new Error('no rotation');
    }
    const rotated = finalizeEvent(
      buildConfigEvent(
        {
          assistant: next,
          origins: [SHOP],
          linkOrigins: [],
          name: 'Rotated',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: store.catalogKey,
          private: { voice: 'calm', instructions: 'i', notes: '' },
          createdAt: NOW - 10,
        },
        store.ownerSecret,
      ),
      store.ownerSecret,
    );
    await seeded.db.query(
      `insert into store_events (id, owner, event) values ($1, $2, ($3::text)::jsonb)`,
      [rotated.id, store.owner, JSON.stringify(rotated)],
    );
    expect(
      (await call('POST', '/v1/admin/store/recover', newSecret, { from: store.owner })).body,
    ).toMatchObject({ owner: newOwner });
    const settings = await call('GET', '/v1/admin/store/moved-settings', newSecret);
    expect(settings.body.private).toEqual({ voice: 'calm', instructions: 'i', notes: '' });
  });

  it('keeps at most a hundred origins per store on record', async () => {
    const { store, seeded } = await setup();
    const many = Array.from({ length: 120 }, (_unused, index) => `https://s${index}.example`);
    for (let start = 0; start < many.length; start += 10) {
      await seeded.state.noteOrigins(store.owner, many.slice(start, start + 10), NOW);
    }
    expect((await seeded.directory.originsHeld(store.owner)).length).toBe(100);
  });
});

describe('origin records and retries (K21, review round 2)', () => {
  it('forgets sites past the grace period before the cap, so junk never keeps new sites out', async () => {
    const { store, seeded } = await setup();
    const junk = Array.from({ length: 100 }, (_unused, index) => `https://j${index}.example`);
    for (let start = 0; start < junk.length; start += 20) {
      await seeded.state.noteOrigins(store.owner, junk.slice(start, start + 20), LONG_AGO);
    }
    // While the junk may still prove a replacement it holds its places; sites held before it stay.
    await seeded.state.noteOrigins(store.owner, ['https://new.example'], NOW);
    const full = (await seeded.directory.originsHeld(store.owner)).map((entry) => entry.origin);
    expect(full).toHaveLength(100);
    expect(full).not.toContain('https://new.example');
    // Once past the grace period it is forgotten, and the store's new site is recorded.
    const later = LONG_AGO + ORIGIN_DROPPED_GRACE_SECS + 1;
    await seeded.state.noteOrigins(store.owner, ['https://newer.example'], later);
    const held = (await seeded.directory.originsHeld(store.owner)).map((entry) => entry.origin);
    expect(held).toEqual(['https://newer.example']);
  });

  it('never dates a site last seen back, and keeps its first sighting when listed again after long', async () => {
    const { store, seeded } = await setup();
    await seeded.state.noteOrigins(store.owner, [SHOP], NOW - 100);
    await seeded.state.noteOrigins(store.owner, [SHOP], NOW);
    await seeded.state.noteOrigins(store.owner, [SHOP], NOW - 50);
    expect(await seeded.directory.originsHeld(store.owner)).toEqual([
      { origin: SHOP, firstSeen: NOW - 100, lastSeen: NOW },
    ]);
    await seeded.state.noteOrigins(store.owner, [SHOP], NOW + 2 * ORIGIN_DROPPED_GRACE_SECS);
    expect((await seeded.directory.originsHeld(store.owner))[0]?.firstSeen).toBe(NOW - 100);
  });

  it('says when the first of several young sites will count', async () => {
    const { store, seeded, recover } = await setup();
    await seeded.state.noteOrigins(store.owner, ['https://b.example'], NOW - 100);
    await seeded.state.noteOrigins(store.owner, ['https://a.example'], NOW - 200);
    expect((await recover(store.owner)).body).toMatchObject({
      error: 'no_site_yet',
      readyAt: NOW - 200 + ORIGIN_PROOF_AGE_SECS,
    });
  });

  it('answers a retried take-back with its result', async () => {
    const { store, site, recover } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    const again = generateSecretKey();
    site.owner = getPublicKey(again);
    expect((await recover(store.owner, again)).status).toBe(200);
    const retried = await recover(store.owner, again);
    expect(retried).toMatchObject({ status: 200, body: { owner: getPublicKey(again) } });
  });

  it('keeps the old settings only when genuinely signed by the old key', async () => {
    const { store, relay, recover, call, newSecret, configEvent } = await setup({
      siteSeenAt: LONG_AGO,
    });
    const forged = {
      ...configEvent,
      created_at: NOW - 5,
      sig: configEvent.sig.replace(/^./u, '0'),
    };
    relay.events.push(forged);
    expect((await recover(store.owner)).status).toBe(200);
    const settings = await call('GET', '/v1/admin/store/moved-settings', newSecret);
    expect(settings.body.config.id).toBe(configEvent.id);
  });
});
