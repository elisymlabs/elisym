import { PGlite } from '@electric-sql/pglite';
import { type SyncRelayClient, buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import {
  type AutoTier,
  DEFAULT_AUTO_TIER_MAX_ACTIVE,
  DEFAULT_AUTO_TIER_PER_DAY,
  autoTierFromEnv,
  autoTierWarning,
} from '../src/config';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { STORES_CHANNEL } from '../src/db/db';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { StoreEventPublisher } from '../src/publisher';
import type { RelayLike, ServerPool } from '../src/relay/pool';
import type { Tier } from '../src/state/types';
import { HOLDER, NOW, ORIGIN, stateWith } from './fixtures';
import { pgliteDb } from './pglite-db';

const BASE = 'https://api.askr.test';
const DAY_SECS = 24 * 60 * 60;

const FREE: Tier = {
  name: 'free',
  messagesPerSessionPerDay: 20,
  dailyBudgetUsd: '1',
  monthlyBudgetUsd: '10',
  ticketsPerStorePerMinute: 30,
  maxProducts: 100,
  syncIntervalMinutes: 1440,
  branding: true,
};

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

/** The server's publisher pool, publishing into the memory relay. */
function poolInto(relay: SyncRelayClient): Pick<ServerPool, 'ensureRelay'> {
  return {
    async ensureRelay(): Promise<RelayLike> {
      return {
        connected: true,
        subscribe() {
          throw new Error('not used');
        },
        async publish(event: NostrEvent) {
          await relay.publish([], event);
          return '';
        },
      };
    },
  };
}

function authHeader(secret: Uint8Array, method: string, path: string, body: string, now: number) {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: now,
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

interface Owner {
  secret: Uint8Array;
  pubkey: string;
}

function newOwner(): Owner {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
}

async function setup(options: { autoTier?: AutoTier; tier?: Tier | null } = {}) {
  const seeded = await stateWith([]);
  const tier = options.tier === undefined ? FREE : options.tier;
  if (tier !== null) {
    await seeded.directory.setTier(tier);
  }
  const relay = memoryRelay();
  const clock = { now: NOW };
  const changed: string[] = [];
  const logs: string[] = [];
  const notified: string[] = [];
  await seeded.db.listen(STORES_CHANNEL, () => notified.push('stores'));
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
    ...(options.autoTier === undefined ? {} : { autoTier: options.autoTier }),
    now: () => clock.now,
    syncPace: 1_000,
    log: (message) => logs.push(message),
  });
  const call = async (owner: Owner, method: string, path: string, body?: unknown) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const response = await api({
      request: new Request(`http://internal:8787${path}`, {
        method,
        headers: { authorization: authHeader(owner.secret, method, path, text, clock.now) },
        ...(text ? { body: text } : {}),
      }),
      clientAddress: '203.0.113.9',
    });
    if (!response) {
      throw new Error('not an admin path');
    }
    return { status: response.status, body: await response.json() };
  };
  /** Open (or create) the owner's store, as the admin's onboarding and the CLI do. */
  const open = (owner: Owner) => call(owner, 'POST', '/v1/admin/store');
  /** The settings the admin's first save signs: a config with an origin, and K's authorization. */
  const settingsOf = async (owner: Owner, options: { configOnly?: boolean } = {}) => {
    const view = (await call(owner, 'GET', '/v1/admin/store')).body;
    const config = finalizeEvent(
      buildConfigEvent(
        {
          assistant: view.assistant,
          origins: [ORIGIN],
          name: 'Example Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: view.catalogKey,
          createdAt: clock.now,
        },
        owner.secret,
      ),
      owner.secret,
    );
    const auth = finalizeEvent(
      buildCatalogAuth({ key: view.catalogKey, mode: 'hosted', createdAt: clock.now }),
      owner.secret,
    );
    return { config, auth, events: options.configOnly === true ? [config] : [config, auth] };
  };
  const save = async (owner: Owner) =>
    call(owner, 'POST', '/v1/admin/store/events', { events: (await settingsOf(owner)).events });
  const statusOf = (owner: Owner) => seeded.directory.statusOf(owner.pubkey);
  return {
    ...seeded,
    relay,
    clock,
    changed,
    logs,
    notified,
    call,
    open,
    settingsOf,
    save,
    statusOf,
  };
}

const CAPS = { perDay: 50, maxActive: 500 };

describe('Free on the first settings (6.1)', () => {
  it('opening a store alone leaves it pending, with nothing to activate', async () => {
    const { open, statusOf } = await setup({ autoTier: { tier: 'free', ...CAPS } });
    const owner = newOwner();
    const created = await open(owner);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ status: 'pending', tier: null, activation: null });
    const again = await open(owner);
    expect(again.body).toMatchObject({ status: 'pending', activation: null });
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
  });

  it('the first settings with an origin activate the store on the auto tier and notify', async () => {
    const { open, call, save, settingsOf, statusOf, changed, notified, db, clock } = await setup({
      autoTier: { tier: 'free', ...CAPS },
    });
    const owner = newOwner();
    await open(owner);
    const { auth } = await settingsOf(owner);
    const authOnly = await call(owner, 'POST', '/v1/admin/store/events', { events: [auth] });
    expect(authOnly).toEqual({ status: 200, body: { stored: [auth.id], activation: null } });
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    await expect.poll(() => notified.length).toBe(1);
    changed.length = 0;
    const saved = await save(owner);
    expect(saved.status).toBe(200);
    expect(saved.body.activation).toBe('activated');
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
    // The events' own notify, then the activation's.
    await expect.poll(() => notified.length).toBe(3);
    expect(changed).toEqual(['changed']);
    const view = await call(owner, 'GET', '/v1/admin/store');
    expect(view.body).toMatchObject({ status: 'active', tier: { name: 'free', maxProducts: 100 } });
    const [row] = await db.query<{ auto_activated_at: number | null }>(
      'select auto_activated_at from stores where owner = $1',
      [owner.pubkey],
    );
    expect(row?.auto_activated_at).toBe(NOW);
    // Saving again on an active store has nothing to activate.
    clock.now += 1;
    expect(await save(owner)).toMatchObject({ status: 200, body: { activation: null } });
  });

  it('says disabled with ASKR_AUTO_TIER unset, and no_tier when the tier is missing', async () => {
    const off = await setup();
    const owner = newOwner();
    await off.open(owner);
    expect((await off.save(owner)).body.activation).toBe('disabled');
    expect((await off.open(owner)).body).toMatchObject({
      status: 'pending',
      activation: 'disabled',
    });
    expect(await off.statusOf(owner)).toEqual({ status: 'pending', tier: null });
    const demoted = newOwner();
    await off.open(demoted);
    await off.directory.setStatus(demoted.pubkey, 'active', 'free');
    await off.directory.setStatus(demoted.pubkey, 'pending');
    expect((await off.save(demoted)).body.activation).toBe('disabled');

    const missing = await setup({ autoTier: { tier: 'free', ...CAPS }, tier: null });
    await missing.open(owner);
    expect((await missing.save(owner)).body.activation).toBe('no_tier');
    expect(await missing.statusOf(owner)).toEqual({ status: 'pending', tier: null });
    expect(missing.logs).toContain(
      `store ${owner.pubkey} not activated: the tier free does not exist`,
    );
    await missing.directory.setTier(FREE);
    expect((await missing.open(owner)).body).toMatchObject({
      status: 'active',
      activation: 'activated',
    });
  });

  it('stops at the per-day cap, and a re-opened store with settings is activated a day later', async () => {
    const { open, save, clock, statusOf, logs, changed, notified } = await setup({
      autoTier: { tier: 'free', perDay: 1, maxActive: 10 },
    });
    const first = newOwner();
    const second = newOwner();
    await open(first);
    await open(second);
    expect((await save(first)).body.activation).toBe('activated');
    expect((await save(second)).body.activation).toBe('capacity_reached');
    expect(await statusOf(second)).toEqual({ status: 'pending', tier: null });
    expect(logs).toContain(`store ${second.pubkey} not activated on free: a cap is reached`);
    expect((await open(second)).body.activation).toBe('capacity_reached');
    // A second short of 24 hours later the first activation still counts; at 24 hours it does not.
    clock.now += DAY_SECS - 1;
    expect((await open(second)).body.activation).toBe('capacity_reached');
    clock.now += 1;
    const notifiedBefore = notified.length;
    changed.length = 0;
    const reopened = await open(second);
    expect(reopened.body).toMatchObject({
      status: 'active',
      tier: { name: 'free' },
      activation: 'activated',
    });
    expect(changed).toEqual(['changed']);
    await expect.poll(() => notified.length).toBe(notifiedBefore + 1);
    const withoutSettings = newOwner();
    await open(withoutSettings);
    clock.now += 2 * DAY_SECS;
    expect((await open(withoutSettings)).body).toMatchObject({
      status: 'pending',
      activation: null,
    });
  });

  it('stops at the active cap; a suspended store or one moved to a paid tier frees its place', async () => {
    const { open, save, directory, statusOf } = await setup({
      autoTier: { tier: 'free', perDay: 10, maxActive: 1 },
    });
    await directory.setTier({ ...FREE, name: 'pro', maxProducts: 1000 });
    const [first, second, third] = [newOwner(), newOwner(), newOwner()];
    for (const owner of [first, second, third]) {
      await open(owner);
    }
    expect((await save(first)).body.activation).toBe('activated');
    expect((await save(second)).body.activation).toBe('capacity_reached');
    expect(await directory.setStatus(first.pubkey, 'suspended')).toBe(true);
    expect((await open(second)).body.activation).toBe('activated');
    expect((await save(third)).body.activation).toBe('capacity_reached');
    expect(await directory.setStatus(second.pubkey, 'active', 'pro')).toBe(true);
    expect((await open(third)).body.activation).toBe('activated');
    expect(await statusOf(second)).toEqual({ status: 'active', tier: 'pro' });
  });

  it('never activates a suspended store or one that had a tier, and a moved key stays moved', async () => {
    const { open, save, directory, statusOf, clock } = await setup({
      autoTier: { tier: 'free', ...CAPS },
    });
    const suspended = newOwner();
    await open(suspended);
    expect((await save(suspended)).body.activation).toBe('activated');
    await directory.setStatus(suspended.pubkey, 'suspended');
    expect((await open(suspended)).body).toMatchObject({ status: 'suspended', activation: null });
    clock.now += 1;
    expect(await save(suspended)).toMatchObject({ status: 200, body: { activation: null } });
    expect(await statusOf(suspended)).toEqual({ status: 'suspended', tier: 'free' });

    const demoted = newOwner();
    await open(demoted);
    await directory.setStatus(demoted.pubkey, 'active', 'free');
    await directory.setStatus(demoted.pubkey, 'pending');
    expect((await save(demoted)).body.activation).toBe('disabled');
    expect((await open(demoted)).body.activation).toBe('disabled');
    expect(await statusOf(demoted)).toEqual({ status: 'pending', tier: 'free' });

    const from = newOwner();
    const to = newOwner();
    await open(from);
    await save(from);
    expect((await directory.moveStore(from.pubkey, to.pubkey, NOW, undefined)).ok).toBe(true);
    expect(await open(from)).toEqual({ status: 409, body: { error: 'moved' } });
  });

  it('counts only auto-activated stores toward the active cap, not ones the operator activated', async () => {
    const { open, save, directory } = await setup({
      autoTier: { tier: 'free', perDay: 10, maxActive: 1 },
    });
    const byOperator = newOwner();
    await open(byOperator);
    expect(await directory.setStatus(byOperator.pubkey, 'active', 'free')).toBe(true);
    const owner = newOwner();
    await open(owner);
    expect((await save(owner)).body.activation).toBe('activated');
  });

  it('autoActivate itself leaves alone a store that is active, suspended or pending with a tier', async () => {
    const { open, directory, statusOf, notified } = await setup();
    const [active, suspended, tiered] = [newOwner(), newOwner(), newOwner()];
    for (const owner of [active, suspended, tiered]) {
      await open(owner);
      await directory.setStatus(owner.pubkey, 'active', 'free');
    }
    await directory.setStatus(suspended.pubkey, 'suspended');
    await directory.setStatus(tiered.pubkey, 'pending');
    await expect.poll(() => notified.length).toBe(5);
    for (const owner of [active, suspended, tiered]) {
      expect(await directory.autoActivate(owner.pubkey, 'free', NOW, CAPS)).toBeNull();
    }
    expect(await statusOf(active)).toEqual({ status: 'active', tier: 'free' });
    expect(await statusOf(suspended)).toEqual({ status: 'suspended', tier: 'free' });
    expect(await statusOf(tiered)).toEqual({ status: 'pending', tier: 'free' });
    // Give a stray notify time to arrive: none does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notified).toHaveLength(5);
  });

  it('counts only new stores per client address, not re-opening one to activate it', async () => {
    const { open, save } = await setup({ autoTier: { tier: 'free', perDay: 1, maxActive: 10 } });
    const owners = Array.from({ length: 5 }, () => newOwner());
    for (const owner of owners) {
      expect((await open(owner)).status).toBe(200);
    }
    const [first, second] = owners;
    if (first === undefined || second === undefined) {
      throw new Error('owners missing');
    }
    await save(first);
    await save(second);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await open(second)).body.activation).toBe('capacity_reached');
    }
    expect((await open(newOwner())).status).toBe(429);
  });

  it('catalog and policy writes right after activation succeed once the publisher ran', async () => {
    const { open, call, save, directory, relay, logs } = await setup({
      autoTier: { tier: 'free', ...CAPS },
    });
    const owner = newOwner();
    await open(owner);
    expect((await save(owner)).body.activation).toBe('activated');
    const item = {
      d: 'mug',
      title: 'Mug',
      price: { amount: '12.50', currency: 'USD' },
      url: `${ORIGIN}/products/mug`,
    };
    // Before the settings are on the relay, K is not authorized there yet.
    const early = await call(owner, 'POST', '/v1/admin/catalog', { items: [item] });
    expect(early.body.error).toBe('sync_refused');
    await new StoreEventPublisher({
      directory,
      pool: poolInto(relay),
      relayUrl: 'wss://relay.test',
      log: (message) => logs.push(message),
      now: () => NOW,
    }).run();
    expect((await call(owner, 'GET', '/v1/admin/store')).body.events).toEqual({
      pending: 0,
      failing: [],
    });
    const started = await call(owner, 'POST', '/v1/admin/catalog', { items: [item] });
    expect(started.status).toBe(202);
    await expect
      .poll(async () => (await call(owner, 'GET', '/v1/admin/store')).body.catalogSync?.state)
      .toBe('done');
    const policy = await call(owner, 'PUT', '/v1/admin/policies/returns', {
      title: 'Returns',
      body: 'Returns within 30 days.',
    });
    expect(policy.status).toBe(200);
  });
});

describe('the auto tier settings (6.1)', () => {
  it('is off unless ASKR_AUTO_TIER is set, with the caps defaulted', () => {
    expect(autoTierFromEnv({})).toBeUndefined();
    expect(autoTierFromEnv({ ASKR_AUTO_TIER: '' })).toBeUndefined();
    expect(autoTierFromEnv({ ASKR_AUTO_TIER: 'free' })).toEqual({
      tier: 'free',
      perDay: DEFAULT_AUTO_TIER_PER_DAY,
      maxActive: DEFAULT_AUTO_TIER_MAX_ACTIVE,
    });
    expect([DEFAULT_AUTO_TIER_PER_DAY, DEFAULT_AUTO_TIER_MAX_ACTIVE]).toEqual([50, 500]);
    expect(
      autoTierFromEnv({
        ASKR_AUTO_TIER: 'free',
        ASKR_AUTO_TIER_PER_DAY: '5',
        ASKR_AUTO_TIER_MAX_ACTIVE: '20',
      }),
    ).toEqual({ tier: 'free', perDay: 5, maxActive: 20 });
  });

  it('refuses a bad tier name, a cap that is not a whole number above zero, and caps alone', () => {
    expect(() => autoTierFromEnv({ ASKR_AUTO_TIER: 'Free' })).toThrow('ASKR_AUTO_TIER');
    expect(() => autoTierFromEnv({ ASKR_AUTO_TIER: 'free', ASKR_AUTO_TIER_PER_DAY: '0' })).toThrow(
      'ASKR_AUTO_TIER_PER_DAY',
    );
    expect(() =>
      autoTierFromEnv({ ASKR_AUTO_TIER: 'free', ASKR_AUTO_TIER_MAX_ACTIVE: '1.5' }),
    ).toThrow('ASKR_AUTO_TIER_MAX_ACTIVE');
    expect(() => autoTierFromEnv({ ASKR_AUTO_TIER_MAX_ACTIVE: '20' })).toThrow(
      'ASKR_AUTO_TIER_MAX_ACTIVE is an ASKR_AUTO_TIER setting',
    );
  });
});

describe('the auto tier at start (6.1)', () => {
  it('warns, without refusing, when the auto tier does not exist', async () => {
    const { directory } = await stateWith([]);
    const autoTier = { tier: 'free', ...CAPS };
    expect(await autoTierWarning(autoTier, directory)).toContain(
      'ASKR_AUTO_TIER names the tier free, which does not exist',
    );
    await directory.setTier(FREE);
    expect(await autoTierWarning(autoTier, directory)).toBeUndefined();
  });
});

describe('migration 0006_auto_activation', () => {
  it('applies on a database at 0005, leaving existing stores without an auto activation', async () => {
    const client = await PGlite.create();
    const db = pgliteDb(client);
    const upTo0005 = MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((entry) => entry.id === '0006_auto_activation'),
    );
    expect(upTo0005.map((entry) => entry.id).at(-1)).toBe('0005_cart_clicks');
    await db.script(
      'create table migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    for (const migration of upTo0005) {
      await db.script(migration.sql);
      await db.query('insert into migrations (id) values ($1)', [migration.id]);
    }
    await db.query(
      `insert into stores (owner, status, assistant, assistant_key, catalog_key, catalog_key_secret, created_at)
       values ($1, 'pending', $2, $3, $4, $5, $6)`,
      ['a'.repeat(64), 'b'.repeat(64), new Uint8Array(1), 'c'.repeat(64), new Uint8Array(1), NOW],
    );
    await migrate(db);
    const rows = await db.query<{ auto_activated_at: number | null }>(
      'select auto_activated_at from stores',
    );
    expect(rows).toEqual([{ auto_activated_at: null }]);
    const applied = await db.query<{ id: string }>('select id from migrations order by id');
    expect(applied.map((row) => row.id).at(-1)).toBe('0006_auto_activation');
    await client.close();
  });
});
