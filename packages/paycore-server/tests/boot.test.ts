import { EventEmitter } from 'node:events';
import { KIND_STORE_AUTH } from '@elisym/commerce';
import type { ProtocolConfig } from '@elisym/pay-core';
import type { Eip3009Context, Eip3009StartCheck } from '@merchant-node/eip3009';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chain } from '../../merchant-node/tests/fixtures';
import { Eip3009Boot } from '../src/chain/eip3009-boot';
import type { PaycoreConfig } from '../src/config';
import { REQUESTS_CHANNEL, STORES_CHANNEL, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { HolderRequests } from '../src/node/holder-requests';
import { RequestPump } from '../src/node/request-pump';
import { StoreSupervisor } from '../src/node/supervisor';
import { OwnerEventPublisher } from '../src/publisher';
import { StorePools } from '../src/relay/pools';
import {
  FENCE_MARGIN_SECS,
  LEASE_RETRY_MS,
  type ServerDeps,
  type ServerHandle,
  fenceAfterSecs,
  feeRpcOf,
  networksInUse,
  startServer,
} from '../src/server';
import { WebhookSlots } from '../src/webhook-fetch';
import { submitRequest } from './helpers/node-requests';
import {
  BASE_RPC,
  MASTER_KEY,
  NOW,
  RELAY,
  SILENT_EVM,
  SOLANA_RPC,
  WEBHOOK_SECRET,
  ownerEvents,
  publishedStore,
  seedStore,
  settle,
  vault,
  waitFor,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';
import { authHeader } from './stores-fixtures';

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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Whether this database call is a lease round's (`acquireLeases`). */
function isLeaseRound(): boolean {
  return new Error().stack?.includes('acquireLeases') === true;
}

/** Lease rounds counted, and held at a gate while it is shut (other transactions pass). */
class LeaseGate {
  /** Lease rounds started (their transaction asked for). */
  rounds = 0;
  /** Rounds held at the gate now. */
  held = 0;
  private opened: Promise<void> | undefined;
  private release: () => void = () => undefined;

  shut(): void {
    this.opened = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.opened = undefined;
    this.release();
  }

  /** `db` with its lease rounds going through the gate. */
  wrap(db: Db): Db {
    return {
      ...db,
      transaction: async (work) => {
        if (isLeaseRound()) {
          this.rounds += 1;
          const opened = this.opened;
          if (opened !== undefined) {
            this.held += 1;
            await opened;
            this.held -= 1;
          }
        }
        return db.transaction(work);
      },
    };
  }
}

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
    // GET only: another method on the health path is no health answer.
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
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

  it('stops its nodes at the fence deadline once no lease renewal succeeded, and serves again on the next one', async () => {
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

    // The 60 s lease less the 5 s margin.
    const deadline = NOW + fenceAfterSecs(20);
    expect(deadline).toBe(NOW + 55);
    down.value = true;
    clock.value = deadline - 1;
    await waitFor(() => failedRounds() >= 3, 'lease rounds failing');
    // Before the deadline of the last renewal: the store keeps running.
    expect(handle.supervisor?.running).toEqual([owner]);
    expect(await renewals()).toBe(NOW + 60);

    clock.value = deadline;
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped');
    expect(handle.supervisor?.leased).toEqual([]);
    const fencedLines = logs.filter((line) => line.startsWith('no lease renewed'));
    expect(fencedLines).toEqual([
      'no lease renewed for 55 s: stopping every store until a renewal succeeds',
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
    // Renewed before it ran out (the fence came first): the same epoch, the nodes started afresh.
    expect(lease).toEqual({ holder: handle.holder, epoch: 1 });
  });

  it('a lease round answered after its leases ran out serves nothing', async () => {
    const clock = { value: NOW };
    const slow = { value: false };
    let leaseRounds = 0;
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
        if (isLeaseRound()) {
          leaseRounds += 1;
        }
        const result = await db.transaction(work);
        if (slow.value) {
          // The answer comes back at the fence deadline of the round's own leases.
          clock.value += fenceAfterSecs(20);
        }
        return result;
      },
    };
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    slow.value = true;
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped');
    const roundsAtFence = leaseRounds;
    await waitFor(() => leaseRounds >= roundsAtFence + 5, 'more late rounds');
    // Each late answer counts as failed: never served again, fenced (and logged) once.
    expect(handle.supervisor?.leased).toEqual([]);
    expect(logs).not.toContain('leases renewed again: serving the leased stores');
    expect(logs.filter((line) => line.startsWith('no lease renewed'))).toHaveLength(1);
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
    await settle();
    // The shutdown waits for the boot step in progress: nothing is torn down under it.
    expect(setup.trace.filter((step) => step.startsWith('stop:'))).toEqual([]);
    expect(setup.closes.count).toBe(0);
    release();
    const handle = await booting;
    await handle.stopped;
    expect(setup.trace).not.toContain('supervisor');
    expect(handle.port).toBeUndefined();
    expect(serverPools(setup)).toHaveLength(0);
    expect(await setup.db.query('select owner from leases')).toEqual([]);
    expect(setup.closes.count).toBe(1);
  });

  it('stops for real at each shutdown step: unlisten, pump, holder, publisher, EIP-3009, supervisor, slots, pools, database', async () => {
    const setup = await world();
    const unlistened: string[] = [];
    const { db } = setup;
    const close = vi.fn(async () => undefined);
    const unlistenCalls = new Map<string, ReturnType<typeof vi.fn>>();
    setup.deps.db = {
      ...db,
      listen: async (channel, onNotify) => {
        const unlisten = await db.listen(channel, onNotify);
        const recorded = vi.fn(async () => {
          unlistened.push(channel);
          await unlisten();
        });
        unlistenCalls.set(channel, recorded);
        return recorded;
      },
      close,
    };
    const keys = vault();
    const seeded = await publishedStore(setup.relays);
    const { owner } = await seedStore(db, keys, {
      ...seeded,
      status: 'active',
      webhookUrl: 'https://shop.example.com/hook',
      webhookSecret: WEBHOOK_SECRET,
    });
    setup.poolsBefore = setup.relays.pools.length;
    const steps = {
      pump: vi.spyOn(RequestPump.prototype, 'stop'),
      holder: vi.spyOn(HolderRequests.prototype, 'idle'),
      publisher: vi.spyOn(OwnerEventPublisher.prototype, 'stop'),
      eip3009: vi.spyOn(Eip3009Boot.prototype, 'stop'),
      supervisor: vi.spyOn(StoreSupervisor.prototype, 'shutdown'),
      pools: vi.spyOn(StorePools.prototype, 'closeAll'),
    };
    const forStore = vi.spyOn(WebhookSlots.prototype, 'forStore');
    const handle = await boot(setup);
    await waitFor(
      () => handle.supervisor?.running.includes(owner.pubkey) === true,
      'the store running',
    );
    const slots = forStore.mock.contexts[0] as WebhookSlots | undefined;
    if (slots === undefined) {
      throw new Error('the store took no webhook sender');
    }
    for (const spy of Object.values(steps)) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(unlistened).toEqual([]);

    await handle.stop();
    const storesUnlisten = unlistenCalls.get(STORES_CHANNEL);
    const requestsUnlisten = unlistenCalls.get(REQUESTS_CHANNEL);
    if (storesUnlisten === undefined || requestsUnlisten === undefined) {
      throw new Error('a channel was never listened to');
    }
    // Each step ran once, in the shutdown order.
    const order = [
      storesUnlisten,
      steps.pump,
      requestsUnlisten,
      steps.holder,
      steps.publisher,
      steps.eip3009,
      steps.supervisor,
      steps.pools,
      close,
    ];
    for (const step of order) {
      expect(step).toHaveBeenCalledTimes(1);
    }
    const called = order.map((step) => step.mock.invocationCallOrder[0] ?? 0);
    expect(called).toEqual([...called].sort((left, right) => left - right));
    // The webhook slots refuse every send once the server stopped.
    await expect(
      slots.forStore(owner.pubkey)('https://shop.example.com/hook', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('The server is shutting down');
    expect(serverPools(setup).every((pool) => pool.destroyed)).toBe(true);
  });

  it("dates owner events on the relays through the admin API: a store authorization at the owner's store", async () => {
    const setup = await world();
    const keys = vault();
    const seeded = await publishedStore(setup.relays);
    await seedStore(setup.db, keys, { ...seeded, status: 'active' });
    // A newer authorization than the server knows, on the offer relays.
    setup.relays.add(ownerEvents(seeded.owner, seeded.store, [], NOW + 100).authorization);
    const handle = await boot(setup);
    const path = '/v1/admin/owner-events/prepare';
    const body = JSON.stringify({ kind: KIND_STORE_AUTH });
    const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers: {
        authorization: authHeader({
          secret: seeded.owner.secretKey,
          method: 'POST',
          url: `${CONFIG.publicBase}${path}`,
          body,
          createdAt: NOW,
        }),
      },
      body,
    });
    expect(response.status).toBe(200);
    const prepared = (await response.json()) as { template: { created_at: number } };
    // Dated after the relays' newest.
    expect(prepared.template.created_at).toBe(NOW + 101);
  });

  it('a stop during the first lease round starts no store', async () => {
    const setup = await world();
    const gate = new LeaseGate();
    setup.deps.db = gate.wrap(setup.db);
    await activeStoreWithRequest(setup);
    gate.shut();
    const booting = startServer(CONFIG, setup.deps);
    await waitFor(() => gate.held === 1, 'the first lease round');
    setup.signals.emit('SIGTERM');
    gate.open();
    const handle = await booting;
    await handle.stopped;
    expect(serverPools(setup)).toHaveLength(0);
    expect(handle.supervisor?.leased).toEqual([]);
    expect(setup.trace).not.toContain('publisher');
  });

  it('a notify during a lease round makes exactly one more round', async () => {
    const setup = await world();
    const gate = new LeaseGate();
    let notify: () => void = () => undefined;
    const gated = gate.wrap(setup.db);
    setup.deps.db = {
      ...gated,
      listen: async (channel, onNotify) => {
        if (channel === STORES_CHANNEL) {
          notify = onNotify;
        }
        return gated.listen(channel, onNotify);
      },
    };
    await boot(setup);
    expect(gate.rounds).toBe(1);
    gate.shut();
    notify();
    await waitFor(() => gate.held === 1, 'a round held');
    notify();
    notify();
    notify();
    gate.open();
    await waitFor(() => gate.rounds === 3, 'one more round');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(gate.rounds).toBe(3);
  });

  it('dates the fence from the start of the round that renewed, not from its answer', async () => {
    const clock = { value: NOW };
    const setup = await world({ now: () => clock.value, leaseRenewMs: 20 });
    const { db } = setup;
    let leaseRounds = 0;
    setup.deps.db = {
      ...db,
      transaction: async (work) => {
        if (!isLeaseRound()) {
          return db.transaction(work);
        }
        leaseRounds += 1;
        if (leaseRounds > 1) {
          throw new Error('database down');
        }
        const result = await db.transaction(work);
        // The first round's answer comes back 10 s after it started.
        clock.value += 10;
        return result;
      },
    };
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    // The deadline of a round that started at NOW, whatever its answer's time.
    clock.value = NOW + fenceAfterSecs(20);
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped', 2_000);
  });

  it('fences at its deadline, the margin before the lease runs out, whatever the renewal interval', () => {
    expect(fenceAfterSecs(20_000)).toBe(60 - FENCE_MARGIN_SECS);
    expect(FENCE_MARGIN_SECS).toBeGreaterThan(0);
    expect(fenceAfterSecs(1)).toBe(60 - FENCE_MARGIN_SECS);
    expect(fenceAfterSecs(54_999)).toBe(55);
    expect(() => fenceAfterSecs(55_000)).toThrow(/no sooner than the 55 s fence/);
    expect(LEASE_RETRY_MS).toBe(5_000);
  });

  it('a stop awaits the lease round in progress: no lease is held after the shutdown', async () => {
    const setup = await world();
    const gate = new LeaseGate();
    let notify: () => void = () => undefined;
    const gated = gate.wrap(setup.db);
    setup.deps.db = {
      ...gated,
      listen: async (channel, onNotify) => {
        if (channel === STORES_CHANNEL) {
          notify = onNotify;
        }
        return gated.listen(channel, onNotify);
      },
    };
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    gate.shut();
    notify();
    await waitFor(() => gate.held === 1, 'a round held');
    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    // The shutdown waits for the round before the supervisor lets the leases go.
    expect(stopped).toBe(false);
    expect(setup.trace).not.toContain('stop:supervisor');
    gate.open();
    await stopping;
    await waitFor(() => gate.held === 0, 'the round answered');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(
      await setup.db.query('select owner, expires_at from leases where holder = $1', [
        handle.holder,
      ]),
    ).toEqual([{ owner, expires_at: 0 }]);
    expect(handle.supervisor?.leased).toEqual([]);
  });
});

describe('a lease round that never answers (fake timers)', () => {
  /** A booted server whose lease rounds hang once `hang()` is called; timers faked, advancing with real time. */
  async function hangingRounds() {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      shouldAdvanceTime: true,
    });
    const clock = { value: NOW };
    const logs: string[] = [];
    const setup = await world({
      now: () => clock.value,
      log: (message) => logs.push(message),
      // No sweep in these tests.
      firstSweepDelayMs: () => 3_600_000,
    });
    const gate = new LeaseGate();
    setup.deps.db = gate.wrap(setup.db);
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    const hang = () => gate.shut();
    const stop = async () => {
      gate.open();
      await handle.stop();
    };
    return { clock, logs, handle, owner, hang, stop, gate };
  }

  it('stops the nodes on the fence timer at the deadline, before the next lease tick', async () => {
    const { clock, handle, owner, hang, stop, gate } = await hangingRounds();
    hang();
    // Default renewals every 20 s: the deadline is 55 s after the last renewal.
    const fenceAfter = fenceAfterSecs(20_000);
    expect(fenceAfter).toBe(55);
    clock.value = NOW + fenceAfter - 1;
    await vi.advanceTimersByTimeAsync((fenceAfter - 1) * 1000);
    // The 20 s tick's round hangs; inside the deadline the store runs on.
    expect(gate.held).toBe(1);
    expect(handle.supervisor?.running).toEqual([owner]);
    clock.value = NOW + fenceAfter;
    // Past the timer at 55 s, before the tick at 60 s.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(handle.supervisor?.running).toEqual([]);
    expect(handle.supervisor?.leased).toEqual([]);
    await stop();
  });

  it('a fence timer that fires before the clock reaches the deadline waits for it again', async () => {
    const { clock, handle, owner, hang, stop } = await hangingRounds();
    hang();
    const fenceAfter = fenceAfterSecs(20_000);
    // The clock runs behind the timers: at the timer the deadline is a second away.
    clock.value = NOW + fenceAfter - 1;
    await vi.advanceTimersByTimeAsync(fenceAfter * 1000 + 500);
    expect(handle.supervisor?.running).toEqual([owner]);
    clock.value = NOW + fenceAfter;
    // Before the tick at 60 s.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(handle.supervisor?.running).toEqual([]);
    await stop();
  });

  it('a lease tick after a clock jump past the deadline stops the nodes, though the round hangs', async () => {
    const { clock, handle, owner, hang, stop, logs } = await hangingRounds();
    hang();
    // The wall clock jumps; the fence timer (55 s of the timers' time) is far off.
    clock.value = NOW + 56;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handle.supervisor?.running).toEqual([owner]);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(handle.supervisor?.running).toEqual([]);
    expect(logs.filter((line) => line.startsWith('no lease renewed'))).toEqual([
      'no lease renewed for 56 s: stopping every store until a renewal succeeds',
    ]);
    await stop();
  });
});

describe('lease rounds that fail (fake timers and clock)', () => {
  /**
   * A booted server on the default 20 s renewals whose lease rounds fail while
   * `fail.always` is set, or `fail.next` more times; with `fail.jumpNext` set,
   * the wall clock jumps that many seconds while the next round runs. The
   * injected clock follows the faked one from the first lease round (plus the
   * jumps); round starts are kept in seconds since, jumps left out.
   */
  async function failingRounds() {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      shouldAdvanceTime: true,
    });
    let start: number | undefined;
    const elapsedSecs = () => (start === undefined ? 0 : Math.floor((Date.now() - start) / 1000));
    const logs: string[] = [];
    const fail: {
      always: boolean;
      next: number;
      jumpNext: number;
      /** A failing round waits for this before it fails. */
      held?: Promise<void>;
    } = { always: false, next: 0, jumpNext: 0 };
    let jumped = 0;
    const starts: number[] = [];
    const failed: number[] = [];
    const setup = await world({
      now: () => NOW + elapsedSecs() + jumped,
      log: (message) => logs.push(message),
      // No sweep in these tests.
      firstSweepDelayMs: () => 3_600_000,
    });
    const { db } = setup;
    setup.deps.db = {
      ...db,
      transaction: async (work) => {
        if (isLeaseRound()) {
          start ??= Date.now();
          starts.push(elapsedSecs());
          if (fail.always || fail.next > 0) {
            fail.next = Math.max(0, fail.next - 1);
            failed.push(elapsedSecs());
            await fail.held;
            throw new Error('database down');
          }
          jumped += fail.jumpNext;
          fail.jumpNext = 0;
        }
        return db.transaction(work);
      },
    };
    const { owner } = await activeStoreWithRequest(setup);
    const handle = await boot(setup);
    await waitFor(() => handle.supervisor?.running.includes(owner) === true, 'the store running');
    /** Advance the timers to `secs` (and a half) after the first lease round. */
    const advanceTo = async (secs: number) => {
      if (start === undefined) {
        throw new Error('no lease round yet');
      }
      await vi.advanceTimersByTimeAsync(Math.max(0, start + secs * 1000 + 500 - Date.now()));
    };
    const expiresAt = async () => {
      const [row] = await db.query<{ expires_at: number }>(
        'select expires_at from leases where owner = $1',
        [owner],
      );
      return row?.expires_at;
    };
    return { logs, fail, starts, failed, handle, owner, advanceTo, expiresAt };
  }

  it('one failed round between successes stops nothing: it is tried again 5 s later', async () => {
    const { fail, starts, failed, handle, owner, advanceTo, expiresAt } = await failingRounds();
    fail.next = 1;
    await advanceTo(24);
    expect(starts).toEqual([0, 20]);
    expect(failed).toEqual([20]);
    await advanceTo(25);
    // The retry, before the next tick at 40 s.
    expect(starts).toEqual([0, 20, 25]);
    await waitFor(async () => (await expiresAt()) === NOW + 25 + 60, 'the retry renewed');
    await advanceTo(60);
    expect(starts).toEqual([0, 20, 25, 40, 60]);
    expect(failed).toEqual([20]);
    expect(handle.supervisor?.running).toEqual([owner]);
  });

  it('a round answered past its deadline (a clock jump) is tried again 5 s later', async () => {
    const { logs, fail, starts, handle, owner, advanceTo } = await failingRounds();
    fail.jumpNext = 60;
    await advanceTo(20);
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped');
    expect(logs.filter((line) => line.startsWith('no lease renewed'))).toEqual([
      'no lease renewed for 80 s: stopping every store until a renewal succeeds',
    ]);
    await advanceTo(25);
    // The retry, before the next tick at 40 s: serving again.
    expect(starts).toEqual([0, 20, 25]);
    await waitFor(
      () => handle.supervisor?.running.includes(owner) === true,
      'the store running again',
    );
  });

  it('a stop drops the pending retry of a failed round', async () => {
    const { fail, failed, handle, advanceTo } = await failingRounds();
    fail.always = true;
    await advanceTo(20);
    expect(failed).toEqual([20]);
    await handle.stop();
    // A retry left behind would fire within 5 s (the timers left are PGlite's, far off).
    const timersLeft = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS + 1_000);
    expect(vi.getTimerCount()).toBe(timersLeft);
  });

  it('a round that fails during the stop schedules no retry', async () => {
    const { fail, failed, handle, advanceTo } = await failingRounds();
    let release: () => void = () => undefined;
    fail.always = true;
    fail.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await advanceTo(20);
    expect(failed).toEqual([20]);
    const stopping = handle.stop();
    release();
    await stopping;
    const timersLeft = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS + 1_000);
    expect(vi.getTimerCount()).toBe(timersLeft);
  });

  it('keeps serving while rounds fail inside the deadline, retried every 5 s; fences at 55 s; serves on the next success', async () => {
    const { logs, fail, failed, handle, owner, advanceTo } = await failingRounds();
    fail.always = true;
    await advanceTo(54);
    // Failed at the ticks and on every retry since 20 s (at 40 s the tick, then
    // the retry due then; one retry pending at a time): inside the 55 s deadline.
    expect(failed).toEqual([20, 25, 30, 35, 40, 40, 45, 50]);
    expect(handle.supervisor?.running).toEqual([owner]);
    expect(logs.filter((line) => line.startsWith('no lease renewed'))).toEqual([]);
    await advanceTo(55);
    await waitFor(() => handle.supervisor?.running.length === 0, 'the nodes stopped');
    expect(handle.supervisor?.leased).toEqual([]);
    expect(logs.filter((line) => line.startsWith('no lease renewed'))).toEqual([
      'no lease renewed for 55 s: stopping every store until a renewal succeeds',
    ]);
    fail.always = false;
    await advanceTo(60);
    await waitFor(
      () => handle.supervisor?.running.includes(owner) === true,
      'the store running again',
    );
    expect(logs).toContain('leases renewed again: serving the leased stores');
  });
});

describe('boot helpers', () => {
  it('reads the networks of stores that are not pending, plus the configured ones', async () => {
    const db = await freshDb();
    await migrate(db);
    const keys = vault();
    const active = await seedStore(db, keys, { status: 'active' });
    const pending = await seedStore(db, keys, { status: 'pending' });
    await db.query("update store_config set network = 'devnet' where owner = $1", [
      active.owner.pubkey,
    ]);
    await db.query("update store_config set network = 'mainnet' where owner = $1", [
      pending.owner.pubkey,
    ]);
    const none = { rpcs: { mainnet: { evm: {} }, devnet: { evm: {} } } };
    expect(await networksInUse(db, none)).toEqual(['devnet']);
    const mainnetFee = {
      rpcs: { mainnet: { fee: 'https://fee.example', evm: {} }, devnet: { evm: {} } },
    };
    expect(await networksInUse(db, mainnetFee)).toEqual(['mainnet', 'devnet']);
  });

  it('reads the fee config from the fee RPC, else the Solana RPC, else the public endpoint', () => {
    const both = {
      rpcs: {
        mainnet: { solana: 'https://solana.example', fee: 'https://fee.example', evm: {} },
        devnet: { solana: 'https://solana-devnet.example', evm: {} },
      },
    };
    expect(feeRpcOf(both, 'mainnet')).toBe('https://fee.example');
    expect(feeRpcOf(both, 'devnet')).toBe('https://solana-devnet.example');
    const none = { rpcs: { mainnet: { evm: {} }, devnet: { evm: {} } } };
    expect(feeRpcOf(none, 'devnet')).toMatch(/^https:\/\/api\.devnet\.solana\.com/);
    expect(feeRpcOf(none, 'mainnet')).not.toBe(feeRpcOf(none, 'devnet'));
  });
});
