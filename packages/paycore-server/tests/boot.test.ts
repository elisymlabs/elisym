import { EventEmitter } from 'node:events';
import type { ProtocolConfig } from '@elisym/pay-core';
import type { Eip3009Context, Eip3009StartCheck } from '@merchant-node/eip3009';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { chain } from '../../merchant-node/tests/fixtures';
import type { PaycoreConfig } from '../src/config';
import type { Db } from '../src/db/db';
import { type ServerDeps, type ServerHandle, startServer } from '../src/server';
import { submitRequest } from './helpers/node-requests';
import {
  BASE_RPC,
  MASTER_KEY,
  NOW,
  RELAY,
  SILENT_EVM,
  SOLANA_RPC,
  publishedStore,
  seedStore,
  vault,
  waitFor,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1zcqDFVGPZXAh';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const STOP_ORDER = [
  'stop:http',
  'stop:pump',
  'stop:holder',
  'stop:publisher',
  'stop:supervisor',
  'stop:pools',
  'stop:db',
];

const CONFIG: PaycoreConfig = {
  databaseUrl: 'postgres://unused',
  masterKeyHex: MASTER_KEY,
  publicBase: 'http://localhost',
  port: 0,
  trustProxy: false,
  inboxRelays: [RELAY],
  operator: 'paycore.test',
  rpcs: {
    mainnet: { evm: {} },
    devnet: { solana: SOLANA_RPC, evm: { base: BASE_RPC } },
  },
};

const handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
});

/** The database, its close only counted: the tests read it after the shutdown. */
function keptOpen(db: Db): { db: Db; closes: { count: number } } {
  const closes = { count: 0 };
  return {
    db: {
      ...db,
      close: async () => {
        closes.count += 1;
      },
    },
    closes,
  };
}

interface World {
  db: Db;
  closes: { count: number };
  relays: RelayWorld;
  signals: EventEmitter;
  trace: string[];
  genesis: { value: string };
  deps: ServerDeps;
  /** The pools opened before the boot (seeding): not the server's. */
  poolsBefore: number;
}

/** The relay pools the server opened. */
function serverPools(setup: World) {
  return setup.relays.pools.slice(setup.poolsBefore);
}

async function world(overrides: Partial<ServerDeps> = {}): Promise<World> {
  const { db, closes } = keptOpen(await freshDb());
  const relays = new RelayWorld();
  const signals = new EventEmitter();
  const trace: string[] = [];
  const genesis = { value: DEVNET_GENESIS };
  const storesRpc = chain({}).rpc;
  // The fee config is read through `chains.fee` only: genesis reads are traced there.
  const feeRpc = {
    ...(chain({}).rpc as object),
    getGenesisHash: () => ({
      send: async () => {
        trace.push('genesis');
        return genesis.value;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  const deps: ServerDeps = {
    db,
    signals,
    log: () => undefined,
    now: () => NOW,
    makePool: relays.factory(),
    chains: {
      solana: () => storesRpc,
      fee: () => feeRpc,
      tempo: () => SILENT_EVM,
      evm: () => SILENT_EVM,
    },
    treasuryReadConfig: async () => {
      trace.push('fee-config');
      return {
        programId: TREASURY,
        feeBps: 300,
        treasury: TREASURY,
        admin: TREASURY,
        pendingAdmin: null,
        paused: false,
        version: 1,
        evmTreasury: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
        source: 'onchain',
      } as unknown as ProtocolConfig;
    },
    eip3009Check: async (context: Eip3009Context): Promise<Eip3009StartCheck> => {
      trace.push(`eip3009-check:${context.chain.caip2}`);
      return { kind: 'passed' };
    },
    port: 0,
    trace: (step) => trace.push(step),
    ...overrides,
  };
  return { db, closes, relays, signals, trace, genesis, deps, poolsBefore: 0 };
}

async function boot(setup: World): Promise<ServerHandle> {
  const handle = await startServer(CONFIG, setup.deps);
  handles.push(handle);
  return handle;
}

/** A published, active store with a `restart` request queued for it. */
async function activeStoreWithRequest(setup: World) {
  const keys = vault();
  const seeded = await publishedStore(setup.relays);
  const { owner } = await seedStore(setup.db, keys, { ...seeded, status: 'active' });
  const requestId = await submitRequest(setup.db, owner.pubkey, 'restart', {}, NOW);
  // Publishing the store opened a pool of its own: the server's are the ones after it.
  setup.poolsBefore = setup.relays.pools.length;
  return { owner: owner.pubkey, requestId };
}

async function requestState(db: Db, id: string): Promise<string | undefined> {
  const [row] = await db.query<{ state: string }>(
    'select state from admin_requests where id = $1',
    [id],
  );
  return row?.state;
}

describe('startServer', () => {
  it('boots in order: migrate, vault, fee config, EIP-3009, supervisor, leases, publisher, pump, HTTP', async () => {
    const setup = await world();
    await activeStoreWithRequest(setup);
    await boot(setup);
    const steps = setup.trace.filter(
      (step) => !step.startsWith('genesis') && step !== 'fee-config',
    );
    expect(steps.slice(0, 10)).toEqual([
      'migrate',
      'vault',
      'treasuries',
      'eip3009',
      'eip3009-check:eip155:84532',
      'supervisor',
      'leases',
      'publisher',
      'pump',
      'http',
    ]);
    // The boot read of the fee config ran between `treasuries` and `eip3009`, genesis first.
    const treasuriesAt = setup.trace.indexOf('treasuries');
    expect(setup.trace.slice(treasuriesAt + 1, treasuriesAt + 3)).toEqual([
      'genesis',
      'fee-config',
    ]);
    expect(setup.trace.indexOf('fee-config')).toBeLessThan(setup.trace.indexOf('eip3009'));
  });

  it('starts a leased active store and drains its requests', async () => {
    const setup = await world();
    const { owner, requestId } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    expect(handle.supervisor?.leased).toEqual([owner]);
    await waitFor(
      async () => (await requestState(setup.db, requestId)) === 'applied',
      'the restart request applied',
    );
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    const [lease] = await setup.db.query<{ holder: string; expires_at: number }>(
      'select holder, expires_at from leases where owner = $1',
      [owner],
    );
    expect(lease).toEqual({ holder: handle.holder, expires_at: NOW + 60 });
  });

  it('stops before any store starts when a fee config RPC serves another cluster', async () => {
    const setup = await world();
    await activeStoreWithRequest(setup);
    setup.genesis.value = MAINNET_GENESIS;
    await expect(startServer(CONFIG, setup.deps)).rejects.toThrow(/fee config of devnet/);
    expect(setup.trace).not.toContain('supervisor');
    expect(setup.trace).not.toContain('eip3009');
    expect(serverPools(setup)).toHaveLength(0);
    expect(await setup.db.query('select owner from leases')).toEqual([]);
    expect(setup.closes.count).toBe(1);
    expect(setup.signals.listenerCount('SIGTERM')).toBe(0);
    expect(setup.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('on SIGTERM stops in order, lets every lease go and closes the pools and the database', async () => {
    const setup = await world();
    const { owner, requestId } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(
      async () => (await requestState(setup.db, requestId)) === 'applied',
      'the restart request applied',
    );
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    setup.signals.emit('SIGTERM');
    await handle.stopped;
    expect(setup.trace.filter((step) => step.startsWith('stop:'))).toEqual(STOP_ORDER);
    expect(handle.supervisor?.running).toEqual([]);
    expect(
      await setup.db.query('select owner, expires_at from leases where holder = $1', [
        handle.holder,
      ]),
    ).toEqual([{ owner, expires_at: 0 }]);
    expect(serverPools(setup).length).toBeGreaterThan(0);
    expect(serverPools(setup).every((pool) => pool.destroyed)).toBe(true);
    expect(setup.relays.liveRelays()).toEqual([]);
    expect(setup.closes.count).toBe(1);
    expect(setup.signals.listenerCount('SIGTERM')).toBe(0);
    expect(setup.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('answers /healthz, 404 elsewhere, and nothing once stopped', async () => {
    const setup = await world();
    const handle = await boot(setup);
    const base = `http://127.0.0.1:${handle.port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    // An admin route is the admin API's: without NIP-98 it is refused, not a 404.
    expect((await fetch(`${base}/v1/admin/store`)).status).toBe(401);
    await handle.stop();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it('a second stop is a no-op', async () => {
    const setup = await world();
    const handle = await boot(setup);
    const first = handle.stop();
    const second = handle.stop();
    expect(second).toBe(first);
    await first;
    await handle.stop();
    setup.signals.emit('SIGINT');
    expect(setup.trace.filter((step) => step.startsWith('stop:'))).toEqual(STOP_ORDER);
    expect(setup.closes.count).toBe(1);
  });

  it('stops its nodes once no lease renewal succeeded for the lease TTL, and serves again on the next one', async () => {
    const clock = { value: NOW };
    const down = { value: false };
    const logs: string[] = [];
    const setup = await world({
      now: () => clock.value,
      leaseRenewMs: 20,
      log: (message) => logs.push(message),
    });
    // Lease rounds run in a transaction: refused while the database is "down".
    const { db } = setup;
    setup.deps.db = {
      ...db,
      transaction: (work) =>
        down.value ? Promise.reject(new Error('database down')) : db.transaction(work),
    };
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    const renewals = async () => {
      const [row] = await db.query<{ expires_at: number }>(
        'select expires_at from leases where owner = $1',
        [owner],
      );
      return row?.expires_at;
    };
    const failedRounds = () => logs.filter((line) => line.startsWith('lease round failed')).length;

    down.value = true;
    clock.value = NOW + 59;
    await waitFor(() => failedRounds() >= 3, 'lease rounds failing');
    // Inside the TTL of the last renewal: the store keeps running.
    expect(handle.supervisor?.running).toEqual([owner]);
    expect(await renewals()).toBe(NOW + 60);

    clock.value = NOW + 60;
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped');
    expect(handle.supervisor?.leased).toEqual([]);
    const fencedLines = logs.filter((line) => line.startsWith('no lease renewed'));
    expect(fencedLines).toEqual([
      'no lease renewed for 60 s: stopping every store until a renewal succeeds',
    ]);
    const failedAtFence = failedRounds();
    await waitFor(() => failedRounds() >= failedAtFence + 3, 'more failed rounds');
    // Logged once while fenced.
    expect(logs.filter((line) => line.startsWith('no lease renewed'))).toHaveLength(1);

    down.value = false;
    await waitFor(
      () => handle.supervisor?.running.includes(owner) === true,
      'the store running again',
    );
    expect(logs).toContain('leases renewed again: serving the leased stores');
    const [lease] = await db.query<{ holder: string; epoch: number }>(
      'select holder, epoch from leases where owner = $1',
      [owner],
    );
    // Taken again after its expiry: a new epoch.
    expect(lease).toEqual({ holder: handle.holder, epoch: 2 });
  });

  it('a lease round answered after its leases ran out serves nothing', async () => {
    const clock = { value: NOW };
    const slow = { value: false };
    const logs: string[] = [];
    const setup = await world({
      now: () => clock.value,
      leaseRenewMs: 20,
      log: (message) => logs.push(message),
    });
    const { db } = setup;
    setup.deps.db = {
      ...db,
      transaction: async (work) => {
        const result = await db.transaction(work);
        if (slow.value) {
          // The answer comes back once the TTL of the round's own leases has passed.
          clock.value += 60;
        }
        return result;
      },
    };
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    slow.value = true;
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped');
    expect(logs.some((line) => line.startsWith('no lease renewed'))).toBe(true);
    slow.value = false;
    await waitFor(
      () => handle.supervisor?.running.includes(owner) === true,
      'the store running again',
    );
  });

  it('a signal during the boot stops it before the supervisor and unwinds what started', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = await world();
    await activeStoreWithRequest(setup);
    const readConfig = setup.deps.treasuryReadConfig;
    setup.deps.treasuryReadConfig = async (...args) => {
      await held;
      if (readConfig === undefined) {
        throw new Error('no config reader');
      }
      return readConfig(...args);
    };
    const booting = startServer(CONFIG, setup.deps);
    await waitFor(() => setup.trace.includes('treasuries'), 'the fee config read');
    setup.signals.emit('SIGTERM');
    release();
    const handle = await booting;
    await handle.stopped;
    expect(setup.trace).not.toContain('supervisor');
    expect(handle.port).toBeUndefined();
    expect(serverPools(setup)).toHaveLength(0);
    expect(await setup.db.query('select owner from leases')).toEqual([]);
    expect(setup.closes.count).toBe(1);
  });
});
