import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { createGateway } from '../src/gateway/gateway';
import { ORIGIN_PROOF_AGE_SECS } from '../src/state/stores';
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
  const web = new FakeWeb().route(`${SHOP}/`, {
    headers: { 'content-type': 'text/html' },
    body: page(npubEncode(newOwner)),
  });
  const connectors = new ConnectorService({
    directory: seeded.directory,
    holder: HOLDER,
    client: relay,
    configFor: () => undefined,
    limiter: new ShopRateLimiter(0),
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
  const recover = (from: string, secret = newSecret, clientAddress?: string) =>
    call('POST', '/v1/admin/store/recover', secret, { from }, clientAddress);
  return { store, seeded, relay, web, newSecret, newOwner, call, recover, configEvent };
}

describe('replacing an owner key through the site (K20)', () => {
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

  it('refuses a Pay Core store: its key is authorized in Pay Core', async () => {
    const { store, recover } = await setup({ siteSeenAt: LONG_AGO, source: 'paycore' });
    expect((await recover(store.owner)).body).toMatchObject({ error: 'paycore_source' });
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

  it('a key a store moved away from never opens a store again, nor moves it twice', async () => {
    const { store, recover, call } = await setup({ siteSeenAt: LONG_AGO });
    expect((await recover(store.owner)).status).toBe(200);
    expect((await call('POST', '/v1/admin/store', store.ownerSecret)).body).toMatchObject({
      error: 'moved',
    });
    expect((await recover(store.owner, generateSecretKey())).body).toMatchObject({
      error: 'moved',
    });
  });

  it('limits tries per client address and per store', async () => {
    const { store, recover } = await setup({ siteSeenAt: NOW });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await recover(store.owner, generateSecretKey())).status).toBe(409);
    }
    expect((await recover(store.owner, generateSecretKey())).status).toBe(429);
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

describe('the gateway after a move (K20)', () => {
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

describe('moves and origins in the state (K20)', () => {
  it('follows a store across moves, at most three, from any key it left', async () => {
    const { store, seeded } = await setup();
    const keys = Array.from({ length: 4 }, () => getPublicKey(generateSecretKey()));
    let from = store.owner;
    for (const key of keys) {
      expect(await seeded.directory.moveStore(from, key, NOW, undefined)).toEqual({ ok: true });
      from = key;
    }
    expect(await seeded.state.movedTo(keys[2] ?? '')).toBe(keys[3]);
    // Four moves away: the first key reaches the third hop, never further.
    expect(await seeded.state.movedTo(store.owner)).toBe(keys[2]);
    expect(await seeded.state.movedTo(keys[3] ?? '')).toBeUndefined();
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
      { origin: SHOP, firstSeen: NOW - 100 },
    ]);
    expect(await seeded.db.query('select 1 from store_origins')).toHaveLength(1);
  });
});
