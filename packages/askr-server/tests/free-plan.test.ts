import { PGlite } from '@electric-sql/pglite';
import { type SyncRelayClient, buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import {
  DEFAULT_FREE_MAX_ACTIVE,
  DEFAULT_FREE_PER_DAY,
  type FreeTier,
  freeTierFromEnv,
  freeTierWarning,
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

async function setup(
  options: {
    freeTier?: FreeTier;
    tier?: Tier | null;
    /** Runs between the route's read of the store and `activateFree`, as another request or the operator would. */
    beforeActivate?: (owner: string) => Promise<void>;
  } = {},
) {
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
  const { beforeActivate } = options;
  if (beforeActivate !== undefined) {
    const activateFree = seeded.directory.activateFree.bind(seeded.directory);
    seeded.directory.activateFree = async (owner, tierName, now, caps) => {
      await beforeActivate(owner);
      return activateFree(owner, tierName, now, caps);
    };
  }
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
    ...(options.freeTier === undefined ? {} : { freeTier: options.freeTier }),
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
  /** The merchant's explicit Free choice: the admin's Start on Free, or `askr plan free`. */
  const chooseFree = (owner: Owner) =>
    call(owner, 'POST', '/v1/admin/store/plan', { plan: 'free' });
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
    chooseFree,
    statusOf,
    api,
  };
}

const CAPS = { perDay: 50, maxActive: 500 };
const FREE_PLAN = { tier: 'free', ...CAPS };

describe('storing settings never activates a store (6.2)', () => {
  it('opening a store, saving its settings and opening it again leave it pending, with no activation field', async () => {
    const { open, save, call, statusOf, changed } = await setup({ freeTier: FREE_PLAN });
    const owner = newOwner();
    const created = await open(owner);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ status: 'pending', tier: null });
    expect(created.body).not.toHaveProperty('activation');
    const saved = await save(owner);
    expect(saved.status).toBe(200);
    expect(Object.keys(saved.body)).toEqual(['stored']);
    expect(changed).toEqual(['changed']);
    const again = await open(owner);
    expect(again.body).toMatchObject({ status: 'pending', tier: null });
    expect(again.body).not.toHaveProperty('activation');
    expect((await call(owner, 'GET', '/v1/admin/store')).body).not.toHaveProperty('activation');
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
  });
});

describe('POST /v1/admin/store/plan (6.1)', () => {
  it('activates a pending, never-tiered store with settings on Free, notifies and publishes its events', async () => {
    const {
      open,
      settingsOf,
      chooseFree,
      call,
      statusOf,
      changed,
      notified,
      db,
      directory,
      relay,
      logs,
    } = await setup({ freeTier: FREE_PLAN });
    const owner = newOwner();
    await open(owner);
    const { config, auth, events } = await settingsOf(owner);
    await call(owner, 'POST', '/v1/admin/store/events', { events });
    await expect.poll(() => notified.length).toBe(1);
    changed.length = 0;
    const chosen = await chooseFree(owner);
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({
      status: 'active',
      tier: { name: 'free', maxProducts: 100 },
      activation: 'activated',
    });
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
    expect(changed).toEqual(['changed']);
    await expect.poll(() => notified.length).toBe(2);
    expect(logs).toContain(`store ${owner.pubkey} activated on free: its owner chose Free`);
    const [row] = await db.query<{ auto_activated_at: number | null }>(
      'select auto_activated_at from stores where owner = $1',
      [owner.pubkey],
    );
    expect(row?.auto_activated_at).toBe(NOW);
    await new StoreEventPublisher({
      directory,
      pool: poolInto(relay),
      relayUrl: 'wss://relay.test',
      log: (message) => logs.push(message),
      now: () => NOW,
    }).run();
    expect(relay.events.map((event) => event.id).sort()).toEqual([config.id, auth.id].sort());
    expect((await call(owner, 'GET', '/v1/admin/store')).body.events).toEqual({
      pending: 0,
      failing: [],
    });
  });

  it('answers already_active for an active store, whatever its tier, and changes nothing', async () => {
    const { open, save, chooseFree, directory, statusOf } = await setup({ freeTier: FREE_PLAN });
    await directory.setTier({ ...FREE, name: 'pro', maxProducts: 1000 });
    const owner = newOwner();
    await open(owner);
    await save(owner);
    expect((await chooseFree(owner)).body.activation).toBe('activated');
    const again = await chooseFree(owner);
    expect(again).toMatchObject({
      status: 200,
      body: { status: 'active', tier: { name: 'free' }, activation: 'already_active' },
    });
    const paid = newOwner();
    await open(paid);
    await directory.setStatus(paid.pubkey, 'active', 'pro');
    expect((await chooseFree(paid)).body).toMatchObject({
      status: 'active',
      tier: { name: 'pro' },
      activation: 'already_active',
    });
    expect(await statusOf(paid)).toEqual({ status: 'active', tier: 'pro' });
  });

  it('refuses without settings that parse, for a suspended store and for one the operator manages', async () => {
    const { open, call, chooseFree, save, settingsOf, directory, statusOf } = await setup({
      freeTier: FREE_PLAN,
    });
    const owner = newOwner();
    await open(owner);
    expect(await chooseFree(owner)).toEqual({ status: 409, body: { error: 'no_settings' } });
    // An authorization alone is no settings a store can run on.
    const { auth } = await settingsOf(owner);
    await call(owner, 'POST', '/v1/admin/store/events', { events: [auth] });
    expect(await chooseFree(owner)).toEqual({ status: 409, body: { error: 'no_settings' } });
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });

    const suspended = newOwner();
    await open(suspended);
    await save(suspended);
    await directory.setStatus(suspended.pubkey, 'active', 'free');
    await directory.setStatus(suspended.pubkey, 'suspended');
    expect(await chooseFree(suspended)).toEqual({ status: 409, body: { error: 'not_pending' } });

    const managed = newOwner();
    await open(managed);
    await save(managed);
    await directory.setStatus(managed.pubkey, 'active', 'free');
    await directory.setStatus(managed.pubkey, 'pending');
    expect(await chooseFree(managed)).toEqual({ status: 409, body: { error: 'operator_managed' } });
    expect(await statusOf(managed)).toEqual({ status: 'pending', tier: 'free' });
  });

  it('answers operator_managed for a store with a tier before checking settings or the Free setting', async () => {
    const { open, chooseFree, directory, statusOf } = await setup({ freeTier: FREE_PLAN });
    const unsaved = newOwner();
    await open(unsaved);
    await directory.setStatus(unsaved.pubkey, 'active', 'free');
    await directory.setStatus(unsaved.pubkey, 'pending');
    // No settings were ever saved: still the operator's store, not no_settings.
    expect(await chooseFree(unsaved)).toEqual({ status: 409, body: { error: 'operator_managed' } });
    expect(await statusOf(unsaved)).toEqual({ status: 'pending', tier: 'free' });

    const off = await setup();
    const managed = newOwner();
    await off.open(managed);
    await off.save(managed);
    await off.directory.setStatus(managed.pubkey, 'active', 'free');
    await off.directory.setStatus(managed.pubkey, 'pending');
    // With ASKR_FREE_TIER unset: still the operator's store, not free_unavailable.
    expect(await off.chooseFree(managed)).toEqual({
      status: 409,
      body: { error: 'operator_managed' },
    });
  });

  it('answers free_unavailable with ASKR_FREE_TIER unset, and when its tier is missing (logged)', async () => {
    const off = await setup();
    const owner = newOwner();
    await off.open(owner);
    await off.save(owner);
    expect(await off.chooseFree(owner)).toEqual({
      status: 409,
      body: { error: 'free_unavailable' },
    });
    expect(await off.statusOf(owner)).toEqual({ status: 'pending', tier: null });

    const missing = await setup({ freeTier: FREE_PLAN, tier: null });
    await missing.open(owner);
    await missing.save(owner);
    expect(await missing.chooseFree(owner)).toEqual({
      status: 409,
      body: { error: 'free_unavailable' },
    });
    expect(missing.logs).toContain(
      `store ${owner.pubkey} not activated: the Free tier free does not exist`,
    );
    await missing.directory.setTier(FREE);
    expect((await missing.chooseFree(owner)).body.activation).toBe('activated');
  });

  it('refuses any plan but free and a body that is not one; NIP-98 is required and a replay refused', async () => {
    const { open, save, call, api, clock, statusOf } = await setup({ freeTier: FREE_PLAN });
    const owner = newOwner();
    await open(owner);
    await save(owner);
    const notPlans: unknown[] = [{ plan: 'starter' }, { plan: 'FREE' }, { plan: null }, {}, 'free'];
    for (const body of notPlans) {
      expect(await call(owner, 'POST', '/v1/admin/store/plan', body)).toEqual({
        status: 400,
        body: { error: 'bad_request' },
      });
    }
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    const path = '/v1/admin/store/plan';
    const text = JSON.stringify({ plan: 'free' });
    const post = async (authorization: string | undefined) => {
      const response = await api({
        request: new Request(`http://internal:8787${path}`, {
          method: 'POST',
          headers: authorization === undefined ? {} : { authorization },
          body: text,
        }),
        clientAddress: '203.0.113.9',
      });
      if (!response) {
        throw new Error('not an admin path');
      }
      return { status: response.status, body: await response.json() };
    };
    expect((await post(undefined)).status).toBe(401);
    // Signed for another body: the payload hash differs.
    const otherBody = JSON.stringify({ plan: 'pro' });
    expect((await post(authHeader(owner.secret, 'POST', path, otherBody, clock.now))).status).toBe(
      401,
    );
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    const header = authHeader(owner.secret, 'POST', path, text, clock.now);
    expect((await post(header)).body.activation).toBe('activated');
    expect(await post(header)).toEqual({
      status: 401,
      body: { error: 'unauthorized', reason: 'replay' },
    });
  });

  it('answers no_store for a key without a store, and moved for a key its store moved away from', async () => {
    const { open, save, chooseFree, directory } = await setup({ freeTier: FREE_PLAN });
    expect(await chooseFree(newOwner())).toEqual({ status: 404, body: { error: 'no_store' } });
    const from = newOwner();
    const to = newOwner();
    await open(from);
    await save(from);
    expect((await directory.moveStore(from.pubkey, to.pubkey, NOW, undefined)).ok).toBe(true);
    expect(await chooseFree(from)).toEqual({ status: 409, body: { error: 'moved' } });
  });
});

describe('a Free choice racing another change (6.1)', () => {
  it('two concurrent choices: one activated, the other already_active, one slot counted', async () => {
    const { open, save, chooseFree, db } = await setup({
      freeTier: { tier: 'free', perDay: 2, maxActive: 2 },
    });
    const owner = newOwner();
    await open(owner);
    await save(owner);
    const answers = await Promise.all([chooseFree(owner), chooseFree(owner)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers.map((answer) => answer.body.activation).sort()).toEqual([
      'activated',
      'already_active',
    ]);
    const [counts] = await db.query<{ today: number }>(
      'select count(*)::int8 as today from stores where auto_activated_at is not null',
    );
    expect(Number(counts?.today)).toBe(1);
  });

  it('answers by the store as it is now when the operator acted between the read and the activation', async () => {
    const operatorAction: { run: (owner: string) => Promise<void> } = {
      run: async () => undefined,
    };
    const { open, save, chooseFree, directory, statusOf, db } = await setup({
      freeTier: FREE_PLAN,
      beforeActivate: (owner) => operatorAction.run(owner),
    });
    await directory.setTier({ ...FREE, name: 'starter', maxProducts: 500 });

    const activated = newOwner();
    await open(activated);
    await save(activated);
    operatorAction.run = async (owner) => {
      await directory.setStatus(owner, 'active', 'starter');
    };
    expect((await chooseFree(activated)).body).toMatchObject({
      status: 'active',
      tier: { name: 'starter' },
      activation: 'already_active',
    });

    const suspended = newOwner();
    await open(suspended);
    await save(suspended);
    // A never-tiered store cannot be suspended: the operator activates it, then suspends it.
    operatorAction.run = async (owner) => {
      await directory.setStatus(owner, 'active', 'starter');
      await directory.setStatus(owner, 'suspended');
    };
    expect(await chooseFree(suspended)).toEqual({ status: 409, body: { error: 'not_pending' } });

    const managed = newOwner();
    await open(managed);
    await save(managed);
    operatorAction.run = async (owner) => {
      await directory.setStatus(owner, 'active', 'starter');
      await directory.setStatus(owner, 'pending');
    };
    expect(await chooseFree(managed)).toEqual({ status: 409, body: { error: 'operator_managed' } });
    expect(await statusOf(managed)).toEqual({ status: 'pending', tier: 'starter' });

    const [counts] = await db.query<{ activated: number }>(
      'select count(*)::int8 as activated from stores where auto_activated_at is not null',
    );
    expect(Number(counts?.activated)).toBe(0);
  });

  it('answers moved, or no_store, when a key replacement moved the store meanwhile, with no view built', async () => {
    const replacement: { to?: Owner } = {};
    const { open, save, chooseFree, directory } = await setup({
      freeTier: FREE_PLAN,
      beforeActivate: async (owner) => {
        if (replacement.to !== undefined) {
          await directory.moveStore(owner, replacement.to.pubkey, NOW, undefined);
        }
      },
    });
    const from = newOwner();
    await open(from);
    await save(from);
    replacement.to = newOwner();
    expect(await chooseFree(from)).toEqual({ status: 409, body: { error: 'moved' } });
  });

  it('answers read_failed, logged, should a still-qualifying store be refused', async () => {
    const { open, save, chooseFree, directory, logs } = await setup({ freeTier: FREE_PLAN });
    const owner = newOwner();
    await open(owner);
    await save(owner);
    directory.activateFree = async () => null;
    expect(await chooseFree(owner)).toEqual({ status: 503, body: { error: 'read_failed' } });
    expect(logs).toContain(
      `store ${owner.pubkey} is pending without a tier, yet its Free activation was refused`,
    );
  });
});

describe('the Free caps (6.3)', () => {
  it('stops at the per-day cap, and a slot comes back 24 hours later', async () => {
    const { open, save, chooseFree, clock, statusOf, logs } = await setup({
      freeTier: { tier: 'free', perDay: 1, maxActive: 10 },
    });
    const first = newOwner();
    const second = newOwner();
    await open(first);
    await open(second);
    await save(first);
    await save(second);
    expect((await chooseFree(first)).body.activation).toBe('activated');
    expect(await chooseFree(second)).toEqual({ status: 409, body: { error: 'capacity_reached' } });
    expect(await statusOf(second)).toEqual({ status: 'pending', tier: null });
    expect(logs).toContain(`store ${second.pubkey} not activated on free: a cap is reached`);
    // A second short of 24 hours later the first activation still counts; at 24 hours it does not.
    clock.now += DAY_SECS - 1;
    expect((await chooseFree(second)).body.error).toBe('capacity_reached');
    clock.now += 1;
    expect((await chooseFree(second)).body).toMatchObject({
      status: 'active',
      tier: { name: 'free' },
      activation: 'activated',
    });
  });

  it('stops at the active cap; a suspended store or one moved to a paid tier frees its place', async () => {
    const { open, save, chooseFree, directory, statusOf } = await setup({
      freeTier: { tier: 'free', perDay: 10, maxActive: 1 },
    });
    await directory.setTier({ ...FREE, name: 'pro', maxProducts: 1000 });
    const [first, second, third] = [newOwner(), newOwner(), newOwner()];
    for (const owner of [first, second, third]) {
      await open(owner);
      await save(owner);
    }
    expect((await chooseFree(first)).body.activation).toBe('activated');
    expect((await chooseFree(second)).body.error).toBe('capacity_reached');
    expect(await directory.setStatus(first.pubkey, 'suspended')).toBe(true);
    expect((await chooseFree(second)).body.activation).toBe('activated');
    expect((await chooseFree(third)).body.error).toBe('capacity_reached');
    expect(await directory.setStatus(second.pubkey, 'active', 'pro')).toBe(true);
    expect((await chooseFree(third)).body.activation).toBe('activated');
    expect(await statusOf(second)).toEqual({ status: 'active', tier: 'pro' });
  });

  it('counts only self-serve stores toward the active cap, not ones the operator activated', async () => {
    const { open, save, chooseFree, directory } = await setup({
      freeTier: { tier: 'free', perDay: 10, maxActive: 1 },
    });
    const byOperator = newOwner();
    await open(byOperator);
    expect(await directory.setStatus(byOperator.pubkey, 'active', 'free')).toBe(true);
    const owner = newOwner();
    await open(owner);
    await save(owner);
    expect((await chooseFree(owner)).body.activation).toBe('activated');
  });

  it('activateFree itself leaves alone a store that is active, suspended or pending with a tier', async () => {
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
      expect(await directory.activateFree(owner.pubkey, 'free', NOW, CAPS)).toBeNull();
    }
    expect(await statusOf(active)).toEqual({ status: 'active', tier: 'free' });
    expect(await statusOf(suspended)).toEqual({ status: 'suspended', tier: 'free' });
    expect(await statusOf(tiered)).toEqual({ status: 'pending', tier: 'free' });
    // Give a stray notify time to arrive: none does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notified).toHaveLength(5);
  });

  it('a Free choice never counts toward new stores per client address', async () => {
    const { open, save, chooseFree } = await setup({
      freeTier: { tier: 'free', perDay: 1, maxActive: 10 },
    });
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
    await chooseFree(first);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await chooseFree(second)).body.error).toBe('capacity_reached');
    }
    expect((await open(newOwner())).status).toBe(429);
  });

  it('catalog and policy writes right after a Free activation succeed once the publisher ran', async () => {
    const { open, call, save, chooseFree, directory, relay, logs } = await setup({
      freeTier: FREE_PLAN,
    });
    const owner = newOwner();
    await open(owner);
    await save(owner);
    expect((await chooseFree(owner)).body.activation).toBe('activated');
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

describe('the Free settings (6.2)', () => {
  it('is off unless ASKR_FREE_TIER is set, with the caps defaulted', () => {
    expect(freeTierFromEnv({})).toBeUndefined();
    expect(freeTierFromEnv({ ASKR_FREE_TIER: '' })).toBeUndefined();
    expect(freeTierFromEnv({ ASKR_FREE_TIER: 'free' })).toEqual({
      tier: 'free',
      perDay: DEFAULT_FREE_PER_DAY,
      maxActive: DEFAULT_FREE_MAX_ACTIVE,
    });
    expect([DEFAULT_FREE_PER_DAY, DEFAULT_FREE_MAX_ACTIVE]).toEqual([50, 500]);
    expect(
      freeTierFromEnv({
        ASKR_FREE_TIER: 'free',
        ASKR_FREE_PER_DAY: '5',
        ASKR_FREE_MAX_ACTIVE: '20',
      }),
    ).toEqual({ tier: 'free', perDay: 5, maxActive: 20 });
  });

  it('refuses a bad tier name, a cap that is not a whole number above zero, and caps alone', () => {
    expect(() => freeTierFromEnv({ ASKR_FREE_TIER: 'Free' })).toThrow('ASKR_FREE_TIER');
    expect(() => freeTierFromEnv({ ASKR_FREE_TIER: 'free', ASKR_FREE_PER_DAY: '0' })).toThrow(
      'ASKR_FREE_PER_DAY',
    );
    expect(() => freeTierFromEnv({ ASKR_FREE_TIER: 'free', ASKR_FREE_MAX_ACTIVE: '1.5' })).toThrow(
      'ASKR_FREE_MAX_ACTIVE',
    );
    expect(() => freeTierFromEnv({ ASKR_FREE_PER_DAY: '5' })).toThrow(
      'ASKR_FREE_PER_DAY is an ASKR_FREE_TIER setting',
    );
    expect(() => freeTierFromEnv({ ASKR_FREE_MAX_ACTIVE: '20' })).toThrow(
      'ASKR_FREE_MAX_ACTIVE is an ASKR_FREE_TIER setting',
    );
  });

  it('refuses to start on any old ASKR_AUTO_TIER* name, naming its new name; an empty one counts as unset', () => {
    const renamed = [
      ['ASKR_AUTO_TIER', 'free', 'ASKR_FREE_TIER'],
      ['ASKR_AUTO_TIER_PER_DAY', '50', 'ASKR_FREE_PER_DAY'],
      ['ASKR_AUTO_TIER_MAX_ACTIVE', '500', 'ASKR_FREE_MAX_ACTIVE'],
    ] as const;
    for (const [oldName, value, newName] of renamed) {
      const message = `${oldName} was renamed to ASKR_FREE_*: set ${newName} instead`;
      expect(() => freeTierFromEnv({ [oldName]: value })).toThrow(message);
      // Even beside a correct new setting: the stale one must go.
      expect(() => freeTierFromEnv({ ASKR_FREE_TIER: 'free', [oldName]: value })).toThrow(message);
      expect(freeTierFromEnv({ [oldName]: '' })).toBeUndefined();
      expect(freeTierFromEnv({ ASKR_FREE_TIER: 'free', [oldName]: '' })).toMatchObject({
        tier: 'free',
      });
    }
  });
});

describe('the Free tier at start (6.2)', () => {
  it('warns, without refusing, when the Free tier does not exist', async () => {
    const { directory } = await stateWith([]);
    const freeTier = { tier: 'free', ...CAPS };
    expect(await freeTierWarning(freeTier, directory)).toContain(
      'ASKR_FREE_TIER names the tier free, which does not exist: Free is unavailable',
    );
    await directory.setTier(FREE);
    expect(await freeTierWarning(freeTier, directory)).toBeUndefined();
  });
});

describe('migration 0007_auto_activation', () => {
  it('applies on a database at 0006, leaving existing stores without an auto activation', async () => {
    const client = await PGlite.create();
    const db = pgliteDb(client);
    const upTo0006 = MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((entry) => entry.id === '0007_auto_activation'),
    );
    expect(upTo0006.map((entry) => entry.id).at(-1)).toBe('0006_contact_activity');
    await db.script(
      'create table migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    for (const migration of upTo0006) {
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
    expect(applied.map((row) => row.id).at(-1)).toBe('0007_auto_activation');
    await client.close();
  });
});
