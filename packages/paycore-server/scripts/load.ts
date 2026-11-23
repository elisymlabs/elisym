/**
 * Load test of the server (sub-plan step 20). Not run in CI.
 *
 *   bun scripts/load.ts [--stores 200] [--orders 10] [--minutes 3]
 *     [--webhook-latency-ms 200] [--stalled-stores 0] [--rps 10] [--abandoned-every 5]
 *     [--burst-orders 0]
 *
 * Boots the real server (`startServer`) on pglite (or `DATABASE_URL` when set:
 * use a scratch database, the script writes stores into it) with N published,
 * active stores, a fake relay (every store pool on one in-memory relay world),
 * a fake Solana RPC behind the same token buckets as `ChainClients` (per URL
 * for the stores, and one more per URL for the fee config), and
 * a local webhook sink behind the real `WebhookSlots` (the fetch guard's
 * resolver and transport replaced). Each store gets M orders, each with a paid
 * receipt, spread over the first half of the run in M rounds (within a round
 * each store's order at a random moment; `--burst-orders 1`: every store's at
 * once, a synthetic burst of receipts on the RPC); each paid order queues a
 * webhook. Every `--abandoned-every`-th order of a store (0: none) gets no
 * payment and no receipt: an abandoned checkout, open for the sweeps to scan
 * until it expires. `--stalled-stores K`: the first K stores' webhook endpoints never
 * answer (every request waits out its timeout).
 *
 * Prints: boot time, time to all stores running, RPC calls per minute by kind
 * and network against the bucket, the bucket wait (the fee config read's
 * deadline covers it), sockets per relay, ledger row size, saves per minute by
 * what they changed, webhook queue wait, sweep duration, shutdown time, RSS.
 *
 * Measured through the real code with the prototypes wrapped (save, open,
 * `MerchantRuntime.sweep`, forStore): nothing in `src` changes for it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_TOLERANCE_SECS } from '@elisym/commerce/webhook';
import type { Network, ProtocolConfig } from '@elisym/pay-core';
import type { LedgerState } from '@merchant-node/ledger';
import { MerchantRuntime, type RuntimeDeps } from '@merchant-node/runtime';
import { type Rpc, type SolanaRpcApi, getBase58Decoder } from '@solana/kit';
import { landedPayment, requestFor } from '../../merchant-node/tests/fixtures';
import { DEFAULT_RPC_RATE_LIMIT, TokenBucket } from '../src/chain/clients';
import type { PaycoreConfig } from '../src/config';
import type { Transport, TransportRequest, TransportResponse } from '../src/connectors/fetch-guard';
import type { Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { createPgDb } from '../src/db/pg';
import { type ServerHandle, feeRpcOf, startServer } from '../src/server';
import { LedgerHandle, PgLedgerStore } from '../src/state/ledger-store';
import { WebhookSlots } from '../src/webhook-fetch';
import {
  MASTER_KEY,
  RELAY,
  SILENT_EVM,
  SOLANA_RPC,
  WEBHOOK_SECRET,
  key,
  orderWraps,
  publishedStore,
  seedStore,
  vault,
} from '../tests/helpers/node-store';
import { RelayWorld } from '../tests/helpers/node-world';
import { pgliteDb } from '../tests/pglite-db';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1zcqDFVGPZXAh';
const TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const SINK_HOST = 'sink.example.com';
const SINK_ADDRESS = { address: '93.184.216.34', family: 4 as const };
const SAMPLE_MS = 5_000;
const ALL_RUNNING_TIMEOUT_MS = 10 * 60_000;
const USAGE = `Usage: bun scripts/load.ts [--stores 200] [--orders 10] [--minutes 3]
  [--webhook-latency-ms 200] [--stalled-stores 0] [--rps 10] [--abandoned-every 5] [--burst-orders 0]`;

interface Options {
  stores: number;
  orders: number;
  minutes: number;
  webhookLatencyMs: number;
  stalledStores: number;
  rps: number;
  abandonedEvery: number;
  burstOrders: number;
}

const DEFAULTS: Options = {
  stores: 200,
  orders: 10,
  minutes: 3,
  webhookLatencyMs: 200,
  stalledStores: 0,
  rps: DEFAULT_RPC_RATE_LIMIT.requestsPerSecond,
  abandonedEvery: 5,
  burstOrders: 0,
};

const FLAGS: Record<string, keyof Options> = {
  '--stores': 'stores',
  '--orders': 'orders',
  '--minutes': 'minutes',
  '--webhook-latency-ms': 'webhookLatencyMs',
  '--stalled-stores': 'stalledStores',
  '--rps': 'rps',
  '--abandoned-every': 'abandonedEvery',
  '--burst-orders': 'burstOrders',
};

function parseOptions(argv: readonly string[]): Options {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 2) {
    const name = FLAGS[argv[index] ?? ''];
    const value = Number(argv[index + 1]);
    if (name === undefined || !Number.isFinite(value) || value < 0) {
      throw new Error(USAGE);
    }
    options[name] = value;
  }
  if (options.stores < 1 || options.minutes <= 0) {
    throw new Error(USAGE);
  }
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function spread(values: readonly number[], unit: string, digits = 0): string {
  return `p50 ${percentile(values, 0.5).toFixed(digits)} / p95 ${percentile(values, 0.95).toFixed(digits)} / max ${percentile(values, 1).toFixed(digits)} ${unit} (n=${values.length})`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** What one save changed against the store's previous save (or the row read at open). */
type SaveKind = 'resume_only' | 'resume_and_treasury_seen' | 'other' | 'unchanged';

/** The paths (dot-joined) where `before` and `after` differ. */
function changedPaths(before: unknown, after: unknown, path: string, into: string[]): void {
  if (Object.is(before, after)) {
    return;
  }
  if (
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    before === null ||
    after === null ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    into.push(path);
    return;
  }
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
  for (const name of keys) {
    changedPaths(
      beforeRecord[name],
      afterRecord[name],
      path === '' ? name : `${path}.${name}`,
      into,
    );
  }
}

const TREASURY_SEEN_RE = /^treasuries\.[^.]+\.(solana|evm)\.[^.]+$/;

function saveKind(before: string | undefined, after: string): SaveKind {
  if (before === undefined) {
    return 'other';
  }
  if (before === after) {
    return 'unchanged';
  }
  const paths: string[] = [];
  changedPaths(JSON.parse(before), JSON.parse(after), '', paths);
  if (paths.every((path) => path === 'resumeAt')) {
    return 'resume_only';
  }
  if (paths.every((path) => path === 'resumeAt' || TREASURY_SEEN_RE.test(path))) {
    return 'resume_and_treasury_seen';
  }
  return 'other';
}

interface SaveRecord {
  at: number;
  owner: string;
  bytes: number;
  kind: SaveKind;
  /** Saved while a sweep held the store's queue (its own save, or a delivery's after it). */
  sweep: boolean;
}

interface Measurements {
  saves: SaveRecord[];
  sweepMs: number[];
  /** Sweeps that saved nothing (a quiet sweep's save skipped, nothing delivered). */
  sweepsWithoutSave: number;
  /** Per RPC URL and method: calls and their bucket waits (ms). */
  rpc: Map<string, { calls: number; waitsMs: number[] }>;
  feeReadWaitsMs: number[];
  webhookWaitsMs: number[];
  /** Wait as the receiver sees it: its arrival against the signed timestamp (seconds). */
  webhookAgeSecs: number[];
  webhookRequests: number;
  rssSamples: number[];
}

const measured: Measurements = {
  saves: [],
  sweepMs: [],
  sweepsWithoutSave: 0,
  rpc: new Map(),
  feeReadWaitsMs: [],
  webhookWaitsMs: [],
  webhookAgeSecs: [],
  webhookRequests: 0,
  rssSamples: [],
};

/** Wrap the prototypes the measurements read; the server code itself is unchanged. */
function instrument(): void {
  const lastSaved = new Map<string, string>();
  /** The ledgers whose store is sweeping now, and whether that sweep saved. */
  const sweeping = new WeakMap<LedgerState, { saved: boolean }>();

  const open = PgLedgerStore.prototype.open;
  PgLedgerStore.prototype.open = async function openMeasured(owner, epoch, holder) {
    const handle = await open.call(this, owner, epoch, holder);
    lastSaved.set(owner, JSON.stringify(handle.state));
    return handle;
  };

  const save = LedgerHandle.prototype.save;
  LedgerHandle.prototype.save = async function saveMeasured(state, options) {
    const text = JSON.stringify(state);
    await save.call(this, state, options);
    // A sweep holds its store's queue: every save while it runs is its own.
    const sweep = sweeping.get(state);
    if (sweep !== undefined) {
      sweep.saved = true;
    }
    measured.saves.push({
      at: performance.now(),
      owner: this.owner,
      bytes: Buffer.byteLength(text),
      kind: saveKind(lastSaved.get(this.owner), text),
      sweep: sweep !== undefined,
    });
    lastSaved.set(this.owner, text);
  };

  const runSweep = MerchantRuntime.prototype.sweep;
  MerchantRuntime.prototype.sweep = async function sweepMeasured(allLive, queuedAt) {
    // `deps` is private: the script reads the ledger it sweeps.
    const { state } = (this as unknown as { deps: Pick<RuntimeDeps, 'state'> }).deps;
    const sweep = { saved: false };
    sweeping.set(state, sweep);
    const startedAt = performance.now();
    try {
      await runSweep.call(this, allLive, queuedAt);
    } finally {
      sweeping.delete(state);
      measured.sweepMs.push(performance.now() - startedAt);
      if (!sweep.saved) {
        measured.sweepsWithoutSave += 1;
      }
    }
  };

  const forStore = WebhookSlots.prototype.forStore;
  WebhookSlots.prototype.forStore = function forStoreMeasured(owner, options) {
    const inner = forStore.call(this, owner, options);
    return async (input, init) => {
      if (typeof init.body === 'string') {
        webhookCalledAt.set(init.body, performance.now());
      }
      return inner(input, init);
    };
  };
}

/** When each webhook body was handed to the slots (keyed by the body: one event each). */
const webhookCalledAt = new Map<string, number>();

/** The paid transactions the fake chain knows, by signature. */
const LANDED = new Map<string, Record<string, unknown>>();

/** A Solana RPC answering from `LANDED`, nothing listed, every call behind `bucket` (as `ChainClients`). */
function fakeSolanaRpc(url: string, bucket: TokenBucket): Rpc<SolanaRpcApi> {
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'getTransaction':
        return LANDED.get(String(params[0])) ?? null;
      case 'getSignaturesForAddress':
        return [];
      case 'getGenesisHash':
        return DEVNET_GENESIS;
      default:
        return null;
    }
  };
  const target = {};
  return new Proxy(target, {
    get(_target, method) {
      return (...params: unknown[]) => ({
        send: async () => {
          const name = `${url} ${String(method)}`;
          const entry = measured.rpc.get(name) ?? { calls: 0, waitsMs: [] };
          measured.rpc.set(name, entry);
          entry.calls += 1;
          const queuedAt = performance.now();
          await bucket.take();
          const waited = performance.now() - queuedAt;
          entry.waitsMs.push(waited);
          if (method === 'getGenesisHash' || method === 'getAccountInfo') {
            measured.feeReadWaitsMs.push(waited);
          }
          return answer(String(method), params);
        },
      });
    },
  }) as unknown as Rpc<SolanaRpcApi>;
}

async function* emptyBody(): AsyncIterable<Uint8Array> {}

function headerOf(request: TransportRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [header, value] of Object.entries(request.headers)) {
    if (header.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/** The webhook endpoints: store `index` answers after `latencyMs`, or never when it is stalled. */
function sinkTransport(options: Options): Transport {
  return async (request: TransportRequest): Promise<TransportResponse> => {
    measured.webhookRequests += 1;
    const body = request.body === undefined ? '' : Buffer.from(request.body).toString('utf8');
    const calledAt = webhookCalledAt.get(body);
    if (calledAt !== undefined) {
      webhookCalledAt.delete(body);
      measured.webhookWaitsMs.push(performance.now() - calledAt);
    }
    const signedAt = Number(headerOf(request, WEBHOOK_TIMESTAMP_HEADER));
    if (Number.isFinite(signedAt)) {
      measured.webhookAgeSecs.push(Date.now() / 1000 - signedAt);
    }
    const index = Number(request.url.pathname.split('/').at(-1));
    const stalled = index < options.stalledStores;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('aborted'));
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (!stalled) {
        setTimeout(() => {
          request.signal.removeEventListener('abort', onAbort);
          resolve();
        }, options.webhookLatencyMs);
      }
    });
    return { status: 200, headers: {}, body: emptyBody(), discard: () => undefined };
  };
}

async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url !== undefined && url !== '') {
    return createPgDb(url, (message) => console.error(message));
  }
  return pgliteDb(await PGlite.create());
}

interface Store {
  index: number;
  owner: string;
  store: ReturnType<typeof key>;
}

async function seedStores(db: Db, world: RelayWorld, count: number): Promise<Store[]> {
  const keys = vault();
  const stores: Store[] = [];
  for (let index = 0; index < count; index += 1) {
    const seeded = await publishedStore(world);
    const { owner, store } = await seedStore(db, keys, {
      ...seeded,
      status: 'active',
      webhookUrl: `https://${SINK_HOST}/hook/${index}`,
      webhookSecret: WEBHOOK_SECRET,
    });
    stores.push({ index, owner: owner.pubkey, store });
  }
  return stores;
}

/** One buyer's order to `store` and, unless `abandoned`, its paid receipt (the payment landed on the fake chain). */
async function placeOrder(world: RelayWorld, store: Store, abandoned: boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tx = getBase58Decoder().decode(randomBytes(64));
  const wraps = orderWraps(store.store, key(), randomUUID(), tx, now - 5);
  world.deliver(wraps.order);
  if (abandoned) {
    return;
  }
  LANDED.set(tx, await landedPayment(requestFor(wraps.reference), { blockTime: now - 2 }));
  await sleep(50);
  world.deliver(wraps.receipt);
}

/** The orders in rounds over `windowMs`; within a round at random moments, or all at once (`burstOrders`). */
async function driveOrders(
  world: RelayWorld,
  stores: readonly Store[],
  options: Options,
  windowMs: number,
): Promise<number> {
  let placed = 0;
  const pauseMs = options.orders === 0 ? 0 : windowMs / options.orders;
  for (let round = 0; round < options.orders; round += 1) {
    const roundStart = performance.now();
    const abandoned = options.abandonedEvery > 0 && (round + 1) % options.abandonedEvery === 0;
    await Promise.all(
      stores.map(async (store) => {
        if (options.burstOrders === 0) {
          await sleep(Math.random() * pauseMs);
        }
        await placeOrder(world, store, abandoned);
      }),
    );
    placed += stores.length;
    await sleep(Math.max(0, pauseMs - (performance.now() - roundStart)));
  }
  return placed;
}

/** Per relay: the pools (one socket each in nostr-tools) with a live subscription there. */
function socketsPerRelay(world: RelayWorld): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pool of world.pools) {
    if (pool.destroyed) {
      continue;
    }
    const relays = new Set(
      pool.live
        .filter((subscription) => !subscription.closed)
        .flatMap((subscription) => subscription.relays),
    );
    for (const relay of relays) {
      counts.set(relay, (counts.get(relay) ?? 0) + 1);
    }
  }
  return counts;
}

function networkOf(config: PaycoreConfig, url: string): string {
  const networks: Network[] = ['mainnet', 'devnet'];
  const matching = networks.filter(
    (network) => config.rpcs[network].solana === url || feeRpcOf(config, network) === url,
  );
  return matching.join('+') || 'unknown';
}

async function waitUntil(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

async function ledgerSizes(db: Db): Promise<number[]> {
  const rows = await db.query<{ bytes: number }>(
    'select octet_length(state)::int as bytes from ledgers',
  );
  return rows.map((row) => row.bytes);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  instrument();
  const db = await openDb();
  await migrate(db);
  const baselineRss = process.memoryUsage().rss;
  const world = new RelayWorld();
  const config: PaycoreConfig = {
    databaseUrl: 'postgres://unused',
    masterKeyHex: MASTER_KEY,
    publicBase: 'http://localhost',
    port: 0,
    trustProxy: false,
    inboxRelays: [RELAY],
    operator: 'paycore.test',
    rpcs: { mainnet: { evm: {} }, devnet: { solana: SOLANA_RPC, evm: {} } },
  };
  console.log(
    `load: ${options.stores} stores, ${options.orders} orders each${options.burstOrders === 0 ? '' : ' (in bursts)'}, ${options.minutes} min, webhook latency ${options.webhookLatencyMs} ms, ${options.stalledStores} stalled endpoint(s), RPC bucket ${options.rps}/s, ${process.env.DATABASE_URL ? 'postgres' : 'pglite'}`,
  );

  const seedStart = performance.now();
  const stores = await seedStores(db, world, options.stores);
  console.log(`seeded in ${((performance.now() - seedStart) / 1000).toFixed(1)} s`);

  // As `ChainClients`: one bucket per URL for the stores, one more per URL for the fee config.
  const buckets = new Map<string, TokenBucket>();
  const clients = new Map<string, Rpc<SolanaRpcApi>>();
  const clientFor = (lane: 'rpc' | 'fee', url: string): Rpc<SolanaRpcApi> => {
    const name = `${lane}:${url}`;
    const known = clients.get(name);
    if (known !== undefined) {
      return known;
    }
    const bucket = new TokenBucket({ requestsPerSecond: options.rps });
    buckets.set(name, bucket);
    const client = fakeSolanaRpc(name, bucket);
    clients.set(name, client);
    return client;
  };
  const logs: string[] = [];
  const signals = new EventEmitter();
  const bootStart = performance.now();
  const handle: ServerHandle = await startServer(config, {
    db,
    signals,
    log: (message) => logs.push(message),
    makePool: world.factory(),
    chains: {
      solana: (url) => clientFor('rpc', url),
      fee: (url) => clientFor('fee', url),
      tempo: () => SILENT_EVM,
      evm: () => SILENT_EVM,
    },
    treasuryReadConfig: async (rpc) => {
      // The config account read, through the same bucket as every other call.
      await (rpc as unknown as Rpc<SolanaRpcApi>)
        .getAccountInfo(TREASURY as Parameters<Rpc<SolanaRpcApi>['getAccountInfo']>[0])
        .send();
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
    webhookFetchDeps: { resolve: async () => [SINK_ADDRESS], transport: sinkTransport(options) },
    port: 0,
  });
  const bootMs = performance.now() - bootStart;
  const rssTimer = setInterval(() => {
    measured.rssSamples.push(process.memoryUsage().rss);
  }, SAMPLE_MS);
  await waitUntil(
    () => handle.supervisor?.running.length === options.stores,
    ALL_RUNNING_TIMEOUT_MS,
    'every store running',
  );
  const runningMs = performance.now() - bootStart;
  const steadyFrom = performance.now();
  const runMs = options.minutes * 60_000;

  const placed = await driveOrders(world, stores, options, runMs / 2);
  await sleep(Math.max(0, runMs - (performance.now() - steadyFrom)));
  const steadyMinutes = (performance.now() - steadyFrom) / 60_000;
  const sockets = socketsPerRelay(world);
  const sizes = await ledgerSizes(db);
  const delivered = await db.query<{ paid: number; sent: number; pending: number }>(
    `select
       coalesce(sum((select count(*) from jsonb_each(state::jsonb -> 'orders') o where o.value ? 'paid')), 0)::int as paid,
       coalesce(sum((select count(*) from jsonb_each(state::jsonb -> 'orders') o where o.value -> 'webhook' ->> 'state' = 'sent')), 0)::int as sent,
       coalesce(sum((select count(*) from jsonb_each(state::jsonb -> 'orders') o where o.value -> 'webhook' ->> 'state' = 'pending')), 0)::int as pending
     from ledgers`,
  );
  measured.rssSamples.push(process.memoryUsage().rss);

  const stopStart = performance.now();
  await handle.stop();
  const stopMs = performance.now() - stopStart;
  clearInterval(rssTimer);

  const steadySaves = measured.saves.filter((save) => save.at >= steadyFrom);
  const byKind = new Map<SaveKind, number>();
  for (const save of steadySaves) {
    byKind.set(save.kind, (byKind.get(save.kind) ?? 0) + 1);
  }
  const lines: string[] = [];
  lines.push(
    `boot: ${bootMs.toFixed(0)} ms; all ${options.stores} stores running after ${runningMs.toFixed(0)} ms`,
  );
  lines.push(
    `orders placed: ${placed}; paid ${delivered[0]?.paid ?? 0}; webhooks sent ${delivered[0]?.sent ?? 0}, pending ${delivered[0]?.pending ?? 0}`,
  );
  lines.push(`steady window: ${steadyMinutes.toFixed(2)} min`);
  lines.push(
    'RPC calls per minute (steady window, by bucket - rpc: the stores, fee: the fee config - network and method):',
  );
  const laneOf = (name: string) => {
    const [lane = '', url = ''] = name.split(/:(.*)/s);
    return { lane, url };
  };
  for (const [name, entry] of [...measured.rpc.entries()].sort()) {
    const [bucketName = '', method = ''] = name.split(' ');
    const { lane, url } = laneOf(bucketName);
    lines.push(
      `  ${lane} ${networkOf(config, url)} ${method}: ${entry.calls} calls, ${(entry.calls / steadyMinutes).toFixed(1)}/min; bucket wait ${spread(entry.waitsMs, 'ms')}`,
    );
  }
  for (const [bucketName] of buckets) {
    const { lane, url } = laneOf(bucketName);
    const entries = [...measured.rpc.entries()].filter(([name]) =>
      name.startsWith(`${bucketName} `),
    );
    const total = entries.reduce((sum, [, entry]) => sum + entry.calls, 0);
    const waits = entries.flatMap(([, entry]) => entry.waitsMs);
    lines.push(
      `  ${lane} ${networkOf(config, url)} total ${(total / steadyMinutes).toFixed(1)}/min of a ${options.rps * 60}/min bucket (${((100 * total) / steadyMinutes / (options.rps * 60)).toFixed(1)}%); wait ${spread(waits, 'ms')}`,
    );
  }
  lines.push(
    `fee config read bucket wait (genesis + config, vs the ${10_000} ms deadline): ${spread(measured.feeReadWaitsMs, 'ms')}`,
  );
  lines.push('sockets per relay (live store pools at the end):');
  for (const [relay, count] of sockets) {
    lines.push(`  ${relay}: ${count} (${(count / options.stores).toFixed(2)} per store)`);
  }
  lines.push(`ledger row size after ${options.orders} orders/store: ${spread(sizes, 'bytes')}`);
  lines.push(
    `saves (steady window): ${steadySaves.length}, ${(steadySaves.length / steadyMinutes).toFixed(1)}/min, ${(steadySaves.length / steadyMinutes / options.stores).toFixed(2)}/min per store`,
  );
  for (const kind of ['resume_only', 'resume_and_treasury_seen', 'unchanged', 'other'] as const) {
    const count = byKind.get(kind) ?? 0;
    lines.push(
      `  ${kind}: ${count} (${steadySaves.length === 0 ? 0 : ((100 * count) / steadySaves.length).toFixed(1)}%)`,
    );
  }
  const sweepSaves = steadySaves.filter((save) => save.sweep);
  const housekeeping = sweepSaves.filter(
    (save) => save.kind === 'resume_only' || save.kind === 'resume_and_treasury_seen',
  );
  const orderSaves = steadySaves.length - sweepSaves.length;
  lines.push(
    `  sweeps: ${measured.sweepMs.length} (whole run), ${measured.sweepsWithoutSave} of them saved nothing (quiet, save skipped)`,
  );
  lines.push(
    `  during a sweep: ${sweepSaves.length} (${(sweepSaves.length / steadyMinutes / options.stores).toFixed(2)}/min per store), of which only resumeAt / treasury last-seen moved: ${housekeeping.length}`,
  );
  lines.push(
    `  the rest (orders, deliveries, webhooks, starts): ${orderSaves}, ${placed === 0 ? '-' : (orderSaves / placed).toFixed(1)} per order placed`,
  );
  const savedBytes = steadySaves.reduce((sum, save) => sum + save.bytes, 0);
  lines.push(`  bytes written: ${(savedBytes / steadyMinutes / 1024).toFixed(0)} KiB/min`);
  lines.push(
    `webhook requests: ${measured.webhookRequests}; queue wait in the slots ${spread(measured.webhookWaitsMs, 'ms')}`,
  );
  lines.push(
    `webhook age at the receiver (vs ${WEBHOOK_TOLERANCE_SECS} s tolerance): ${spread(measured.webhookAgeSecs, 's', 1)}`,
  );
  lines.push(`sweep duration: ${spread(measured.sweepMs, 'ms')}`);
  lines.push(`shutdown: ${stopMs.toFixed(0)} ms`);
  lines.push(
    `RSS: max ${megabytes(Math.max(...measured.rssSamples))}, end ${megabytes(measured.rssSamples.at(-1) ?? 0)}, before the stores ${megabytes(baselineRss)} (the database in process, when pglite)`,
  );
  const warnings = logs.filter((line) => /warning|error|failed|refused/i.test(line));
  lines.push(`server log: ${logs.length} lines, ${warnings.length} warnings/errors`);
  for (const line of [...new Set(warnings)].slice(0, 10)) {
    lines.push(`  ${line.slice(0, 200)}`);
  }
  console.log(lines.join('\n'));
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
