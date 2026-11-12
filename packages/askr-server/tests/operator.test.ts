import { nip19 } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { CLI_USAGE, parseOwner, runCli } from '../src/cli';
import { STORES_CHANNEL } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { StoreEventPublisher } from '../src/publisher';
import type { ServerPool } from '../src/relay/pool';
import { MASTER_KEY, NOW, stateWith, storeRecord, syntheticStore } from './fixtures';

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
    ).rejects.toThrow('No such store, or no such tier');
    await expect(
      runCli(['store', 'activate', '9'.repeat(64), '--tier', 'test-0'], directory),
    ).rejects.toThrow('No such store, or no such tier');
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
    const publisher = new StoreEventPublisher({
      directory,
      pool,
      relayUrl: 'wss://relay.test',
      log: (message) => logs.push(message),
    });
    await publisher.run();
    expect(published.sort()).toEqual([config.id, auth.id].sort());
    expect(logs).toEqual([`relay refused store event ${auth.id}`]);
    refuseAuth = false;
    published.length = 0;
    await publisher.run();
    expect(published).toEqual([auth.id]);
    published.length = 0;
    await publisher.run();
    expect(published).toEqual([]);
  });
});
