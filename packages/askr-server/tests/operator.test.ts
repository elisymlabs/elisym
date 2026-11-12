import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { CLI_USAGE, parseOwner, runCli } from '../src/cli';
import { positiveUsd, publicBaseOf } from '../src/config';
import { STORES_CHANNEL } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { StoreEventPublisher } from '../src/publisher';
import type { ServerPool } from '../src/relay/pool';
import {
  MAX_PUBLISH_ATTEMPTS,
  MAX_STORED_EVENTS,
  MAX_UNPUBLISHED_EVENTS,
} from '../src/state/stores';
import { MASTER_KEY, NOW, ORIGIN, stateWith, storeRecord, syntheticStore } from './fixtures';

const TIER_ARGS = [
  '--messages',
  '30',
  '--daily',
  '2.5',
  '--monthly',
  '50',
  '--tickets',
  '60',
  '--products',
  '500',
  '--sync-minutes',
  '30',
  '--branding',
  'false',
];

describe('key vault (9)', () => {
  it('seals and opens a key for its owner and purpose only', () => {
    const vault = new KeyVault(MASTER_KEY);
    const secret = generateSecretKey();
    const owner = 'a'.repeat(64);
    const sealed = vault.seal(secret, owner, 'assistant');
    expect(vault.open(sealed, owner, 'assistant')).toEqual(secret);
    expect(() => vault.open(sealed, owner, 'catalog')).toThrow();
    expect(() => vault.open(sealed, 'b'.repeat(64), 'assistant')).toThrow();
    expect(() => new KeyVault('22'.repeat(32)).open(sealed, owner, 'assistant')).toThrow();
    const tampered = new Uint8Array(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => vault.open(tampered, owner, 'assistant')).toThrow();
    expect(() => vault.open(sealed.subarray(1), owner, 'assistant')).toThrow('Not a sealed key');
  });

  it('a sealed key does not contain the key in clear, and nonces differ', () => {
    const vault = new KeyVault(MASTER_KEY);
    const secret = generateSecretKey();
    const first = vault.seal(secret, 'a'.repeat(64), 'catalog');
    const second = vault.seal(secret, 'a'.repeat(64), 'catalog');
    expect(Buffer.from(first).includes(Buffer.from(secret))).toBe(false);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it('refuses a master key that is not 32 bytes of lowercase hex, and a key of another size', () => {
    expect(() => new KeyVault('11'.repeat(31))).toThrow();
    expect(() => new KeyVault('AA'.repeat(32))).toThrow();
    expect(() => new KeyVault(MASTER_KEY).seal(new Uint8Array(31), 'a', 'assistant')).toThrow();
  });
});

describe('operator CLI (7.3)', () => {
  it('reads an owner as npub or hex only', () => {
    const owner = getPublicKey(generateSecretKey());
    expect(parseOwner(owner)).toBe(owner);
    expect(parseOwner(nip19.npubEncode(owner))).toBe(owner);
    expect(parseOwner(nip19.nsecEncode(generateSecretKey()))).toBeUndefined();
    expect(parseOwner('nope')).toBeUndefined();
  });

  it('sets a tier, activates a pending store with it and notifies the server', async () => {
    const store = syntheticStore();
    const { db, directory, state } = await stateWith([
      { ...storeRecord(store), status: 'pending' },
    ]);
    const notified: string[] = [];
    await db.listen(STORES_CHANNEL, () => notified.push('stores'));
    expect(await runCli(['tier', 'set', 'starter', ...TIER_ARGS], directory)).toBe(
      'tier starter saved',
    );
    const npub = nip19.npubEncode(store.owner);
    expect(await runCli(['store', 'activate', npub, '--tier', 'starter'], directory)).toBe(
      `${npub} is active`,
    );
    const record = await state.store(store.owner);
    expect(record?.status).toBe('active');
    expect(record?.tier).toEqual({
      name: 'starter',
      messagesPerSessionPerDay: 30,
      dailyBudgetUsd: '2.500000000',
      monthlyBudgetUsd: '50.000000000',
      ticketsPerStorePerMinute: 60,
      maxProducts: 500,
      syncIntervalMinutes: 30,
      branding: false,
    });
    expect(await runCli(['store', 'list'], directory)).toBe(`${npub} active starter`);
    expect(await runCli(['store', 'suspend', store.owner], directory)).toBe(`${npub} is suspended`);
    expect((await state.store(store.owner))?.tier?.name).toBe('starter');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notified).toEqual(['stores', 'stores']);
  });

  it('refuses an unknown store or tier, and activation without a tier', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([{ ...storeRecord(store), status: 'pending' }]);
    await expect(
      runCli(['store', 'activate', store.owner, '--tier', 'missing'], directory),
    ).rejects.toThrow('No such tier: missing');
    await expect(
      runCli(['store', 'activate', '9'.repeat(64), '--tier', 'test-0'], directory),
    ).rejects.toThrow('No such store');
    await expect(runCli(['store', 'activate', store.owner], directory)).rejects.toThrow(
      'activate needs --tier',
    );
    await expect(runCli(['store', 'suspend', 'nope'], directory)).rejects.toThrow(
      'owner npub or hex',
    );
    await expect(runCli(['store', 'drop', store.owner], directory)).rejects.toThrow(CLI_USAGE);
  });

  it('a pending store with no tier cannot be activated without one', async () => {
    const owner = getPublicKey(generateSecretKey());
    const { directory } = await stateWith([]);
    await directory.createStore(owner, NOW);
    expect(await directory.setStatus(owner, 'active')).toBe(false);
    expect((await directory.store(owner))?.status).toBe('pending');
  });

  it('refuses bad tier numbers and amounts', async () => {
    const { directory } = await stateWith([]);
    const withFlag = (flag: string, value: string) => {
      const args = [...TIER_ARGS];
      args[args.indexOf(flag) + 1] = value;
      return runCli(['tier', 'set', 'bad', ...args], directory);
    };
    await expect(withFlag('--messages', '0')).rejects.toThrow('--messages');
    await expect(withFlag('--daily', '-1')).rejects.toThrow('--daily');
    await expect(withFlag('--monthly', '0')).rejects.toThrow('--monthly');
    await expect(withFlag('--branding', 'yes')).rejects.toThrow('--branding');
    await expect(runCli(['tier', 'set', 'bad', '--messages'], directory)).rejects.toThrow(
      'Bad arguments',
    );
  });
});

describe('store directory (7.3)', () => {
  it('creates a pending store with fresh A and server K once', async () => {
    const owner = getPublicKey(generateSecretKey());
    const { directory } = await stateWith([]);
    const created = await directory.createStore(owner, NOW);
    expect(created).toMatchObject({ owner, status: 'pending', tier: undefined });
    expect(getPublicKey(created.assistantSecretKey)).toBe(created.assistant);
    expect(getPublicKey(created.catalogSecretKey)).toBe(created.catalogKey);
    expect(await directory.createStore(owner, NOW + 5)).toEqual(created);
  });
});

function fakePool(accept: (event: NostrEvent) => boolean): {
  pool: Pick<ServerPool, 'publish'>;
  published: string[];
} {
  const published: string[] = [];
  const pool = {
    publish(_relays: string[], event: NostrEvent) {
      published.push(event.id);
      return [accept(event) ? Promise.resolve('ok') : Promise.reject(new Error('blocked'))];
    },
  };
  return { pool, published };
}

describe('publishing stored events on activation (7.3)', () => {
  it('publishes only active stores events, marks only accepted ones and retries the rest', async () => {
    const active = syntheticStore();
    const pending = syntheticStore();
    const { directory } = await stateWith([
      storeRecord(active),
      { ...storeRecord(pending), status: 'pending' },
    ]);
    const [config, auth] = active.events;
    if (!config || !auth) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(active.owner, [config, auth]);
    await directory.addEvents(active.owner, [config]);
    await directory.addEvents(pending.owner, pending.events.slice(0, 2));
    let refuseAuth = true;
    const { pool, published } = fakePool((event) => !(refuseAuth && event.id === auth.id));
    const logs: string[] = [];
    const clock = { now: NOW };
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: 'wss://relay.test',
      log: (message) => logs.push(message),
      now: () => clock.now,
    });
    await publisher.run();
    expect(published.sort()).toEqual([config.id, auth.id].sort());
    expect(logs).toEqual([`relay refused store event ${auth.id}`]);
    refuseAuth = false;
    published.length = 0;
    // Backed off: not retried before its time.
    await publisher.run();
    expect(published).toEqual([]);
    clock.now += 60;
    await publisher.run();
    expect(published).toEqual([auth.id]);
    published.length = 0;
    await publisher.run();
    expect(published).toEqual([]);
  });
});

describe('server core review: operator CLI and amounts', () => {
  it('refuses a bad tier name, unknown and repeated flags, and a daily budget above the monthly one', async () => {
    const { directory } = await stateWith([]);
    const set = (name: string, args: readonly string[]) =>
      runCli(['tier', 'set', name, ...args], directory);
    await expect(set('Starter', TIER_ARGS)).rejects.toThrow('tier name');
    await expect(set('a'.repeat(33), TIER_ARGS)).rejects.toThrow('tier name');
    await expect(set('ok-1', [...TIER_ARGS, '--colour', 'red'])).rejects.toThrow(
      'Unknown flag --colour',
    );
    await expect(set('ok-1', [...TIER_ARGS, '--daily', '1'])).rejects.toThrow(
      '--daily is given twice',
    );
    const daily = [...TIER_ARGS];
    daily[daily.indexOf('--daily') + 1] = '60';
    await expect(set('ok-1', daily)).rejects.toThrow('--daily must not exceed --monthly');
    expect(await set('ok-1', TIER_ARGS)).toBe('tier ok-1 saved');
    const store = getPublicKey(generateSecretKey());
    await directory.createStore(store, NOW);
    await expect(
      runCli(['store', 'activate', store, '--tier', 'ok-1', '--tier', 'ok-1'], directory),
    ).rejects.toThrow('--tier is given twice');
    await expect(runCli(['store', 'suspend', store, '--tier', 'ok-1'], directory)).rejects.toThrow(
      'Unknown flag --tier',
    );
  });

  it('suspending a pending store with no tier is a clear refusal, not a database error', async () => {
    const owner = getPublicKey(generateSecretKey());
    const { directory } = await stateWith([]);
    await directory.createStore(owner, NOW);
    await expect(runCli(['store', 'suspend', owner], directory)).rejects.toThrow(
      'pending with no tier',
    );
    expect(await directory.setStatus(owner, 'suspended')).toBe(false);
    expect((await directory.store(owner))?.status).toBe('pending');
  });

  it('a USD amount has at most nine decimals, as the database keeps it', () => {
    expect(positiveUsd('X', '0.000000001')).toBe('0.000000001');
    expect(() => positiveUsd('X', '0.0000000001')).toThrow('X must be');
  });

  it('the public base is compared without a trailing slash', () => {
    expect(publicBaseOf('https://api.askr.elisym.network/')).toBe(
      'https://api.askr.elisym.network',
    );
    expect(publicBaseOf('https://api.askr.elisym.network')).toBe('https://api.askr.elisym.network');
  });
});

describe('server core review: stored events', () => {
  it('an event the relay keeps refusing backs off, stops after the limit, shows in the admin view, and is retried once stored again', async () => {
    const store = syntheticStore();
    const { directory } = await stateWith([storeRecord(store)]);
    const [config] = store.events;
    if (!config) {
      throw new Error('fixture events missing');
    }
    await directory.addEvents(store.owner, [config]);
    const { pool, published } = fakePool(() => false);
    const logs: string[] = [];
    const clock = { now: NOW };
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: 'wss://relay.test',
      log: (message) => logs.push(message),
      now: () => clock.now,
    });
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS + 3; attempt += 1) {
      await publisher.run();
      clock.now += 2 * 60 * 60;
    }
    expect(published).toHaveLength(MAX_PUBLISH_ATTEMPTS);
    expect(logs.at(-1)).toBe(
      `relay refused store event ${config.id} ${MAX_PUBLISH_ATTEMPTS} times: no longer retried`,
    );
    expect(await directory.eventStatus(store.owner)).toEqual({
      pending: 1,
      failing: [{ id: config.id, kind: 30496, failures: MAX_PUBLISH_ATTEMPTS, stopped: true }],
    });
    expect(await directory.addEvents(store.owner, [config])).toEqual({ ok: true });
    await publisher.run();
    expect(published).toHaveLength(MAX_PUBLISH_ATTEMPTS + 1);
  });

  it('caps the unpublished events of a store, and published configs a newer one replaced do not count', async () => {
    const store = syntheticStore();
    const { directory, db } = await stateWith([storeRecord(store)]);
    const auth = (index: number) =>
      finalizeEvent(
        buildCatalogAuth({
          key: getPublicKey(generateSecretKey()),
          mode: 'self-host',
          createdAt: NOW - 1_000 + index,
        }),
        store.ownerSecret,
      );
    const first = Array.from({ length: MAX_UNPUBLISHED_EVENTS }, (_unused, index) => auth(index));
    expect(await directory.addEvents(store.owner, first)).toEqual({ ok: true });
    // Storing a known one again changes nothing and fits.
    expect(await directory.addEvents(store.owner, first.slice(0, 1))).toEqual({ ok: true });
    expect(await directory.addEvents(store.owner, [auth(900)])).toEqual({
      ok: false,
      reason: 'too_many_events',
    });
    await db.query('update store_events set published = true where owner = $1', [store.owner]);
    expect(await directory.addEvents(store.owner, [auth(901)])).toEqual({ ok: true });
    // The total cap: fill it with published configs that are not replaced (distinct d), then one more.
    await db.query(
      `insert into store_events (id, owner, event, published)
       select md5(n::text), $1, jsonb_build_object('kind', 30497, 'created_at', n,
         'tags', jsonb_build_array(jsonb_build_array('d', md5(n::text)))), true
       from generate_series(1, $2::int) n`,
      [store.owner, MAX_STORED_EVENTS - 51],
    );
    expect(await directory.addEvents(store.owner, [auth(902)])).toEqual({
      ok: false,
      reason: 'too_many_events',
    });
    // Published configs replaced by a newer published one are pruned and make room.
    await db.query(
      `update store_events set event = jsonb_set(event, '{tags}', '[["d", "same"]]')
       where owner = $1 and id in (select id from store_events where owner = $1 limit 10)`,
      [store.owner],
    );
    expect(await directory.addEvents(store.owner, [auth(903)])).toEqual({ ok: true });
  });

  it('a config not newer than the newest stored one is refused, and nothing of its batch is stored', async () => {
    const store = syntheticStore();
    const { directory, state } = await stateWith([storeRecord(store)]);
    const configAt = (createdAt: number, assistant: string = store.assistant) =>
      finalizeEvent(
        buildConfigEvent(
          {
            assistant,
            origins: [ORIGIN],
            name: 'Example Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: store.catalogKey,
            createdAt,
          },
          store.ownerSecret,
        ),
        store.ownerSecret,
      );
    const current = configAt(NOW);
    expect(await directory.addEvents(store.owner, [current])).toEqual({ ok: true });
    const next = await directory.beginRotation(store.owner);
    if (next === undefined) {
      throw new Error('no rotation');
    }
    const stale = configAt(NOW, next);
    const [authEvent] = store.events.slice(1, 2);
    if (!authEvent) {
      throw new Error('fixture events missing');
    }
    expect(await directory.addEvents(store.owner, [authEvent, stale])).toEqual({
      ok: false,
      reason: 'stale_config',
      id: stale.id,
    });
    expect((await state.store(store.owner))?.assistant).toBe(store.assistant);
    expect((await directory.eventStatus(store.owner)).pending).toBe(1);
    expect(await directory.addEvents(store.owner, [configAt(NOW + 1, next)])).toEqual({ ok: true });
    expect((await state.store(store.owner))?.assistant).toBe(next);
  });
});
