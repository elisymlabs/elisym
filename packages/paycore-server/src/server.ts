/**
 * The server's boot and shutdown (sub-plan step 19). Boot, each step awaited
 * before the next:
 *
 * 1. SIGTERM / SIGINT hooked (a signal during the boot unwinds what started).
 * 2. Migrations.
 * 3. `KeyVault` on the master key.
 * 4. The first fee config read of every network in use: a config RPC of
 *    another cluster stops the boot before any store starts.
 * 5. The EIP-3009 start check of every operator EVM chain of those networks
 *    (a wrong answer stops the boot; a transient one is retried in the background).
 * 6. The supervisor with the webhook slots, the stores' relay pools, the
 *    shared chain clients and the holder's requests (with the suspensions).
 * 7. LISTEN `paycore_stores` and the lease loop: leases taken or renewed
 *    every `LEASE_RENEW_MS` and on every notify, the supervisor reconciled
 *    with what this holder leases. The renewals also stand in for a poll of
 *    the stores (a notify missed while the listen connection was down).
 *    Self-fencing: when no renewal has succeeded for `LEASE_TTL_SECS` (the
 *    database down or hanging), the leases may already be another holder's,
 *    so the server stops its nodes itself (the supervisor reconciled with
 *    nothing leased) instead of waiting for a fenced save to fail; the next
 *    renewal that succeeds starts them again from the database.
 * 8. The owner event publisher.
 * 9. The request pump (LISTEN `paycore_requests`, the 60 s poll and tick).
 * 10. HTTP: the admin API and `/healthz`.
 *
 * Shutdown (`stop`, idempotent): HTTP stops accepting, the lease loop stops
 * (a round in progress is awaited, so no lease is taken after they are let
 * go), then `pump.stop()` -> `holder.idle()` -> `publisher.stop()` ->
 * `supervisor.shutdown()` (every node stopped, the leases released) -> the
 * webhook slots and relay pools closed -> the database closed. The pump and
 * the holder go before the supervisor: a drain or a tick still running after
 * it would find its stores gone (`NotServed`) halfway through a request.
 *
 * Networks in use: the network of every store that is not `pending`, plus
 * every network the operator configured an RPC for. Only those are read at
 * boot (a devnet-only operator never asks a mainnet endpoint), but every
 * network has a reader: a store activated later on a network no store used
 * reads its fee config at its start, like any later read. Any network with an
 * operator EVM RPC is in use, so every EVM chain a store can be given (only
 * the operator's) is checked at boot.
 */
// cspell:ignore healthz
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { KIND_PAYTO } from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import { EIP3009_SLUGS, type MerchantConfig } from '@merchant-node/config';
import type { startCheckEip3009 } from '@merchant-node/eip3009';
import { type TreasuryReader, feeConfigRpcUrl } from '@merchant-node/fee';
import { emptyLedger } from '@merchant-node/ledger';
import { listeningPool } from '@merchant-node/relay-pool';
import type { SimplePool } from 'nostr-tools/pool';
import { createAdminApi } from './admin/api';
import { ChainClients } from './chain/clients';
import { Eip3009Boot } from './chain/eip3009-boot';
import { NetworkTreasuries } from './chain/treasuries';
import type { PaycoreConfig } from './config';
import type { FetchGuardDeps } from './connectors/fetch-guard';
import { type Db, STORES_CHANNEL } from './db/db';
import { KeyVault } from './db/keys';
import { migrate } from './db/migrations';
import { createPgDb } from './db/pg';
import { type GatewayRequest, serveGateway } from './gateway/http';
import { HolderRequests, healPass } from './node/holder-requests';
import { RequestPump } from './node/request-pump';
import type { SetupPassDeps } from './node/setup-pass';
import { StoreSupervisor } from './node/supervisor';
import type { OwnerEventKind } from './owner-events';
import { OwnerEventPublisher } from './publisher';
import { newestOnRelays } from './relay/newest';
import { StorePools } from './relay/pools';
import { LEASE_RENEW_MS, LEASE_TTL_SECS, acquireLeases, newHolderId } from './state/leases';
import { StoreDirectory } from './state/stores';
import { WebhookSlots } from './webhook-fetch';

const NETWORKS: readonly Network[] = ['mainnet', 'devnet'];
/** How often the publisher retries recorded owner events no default relay took. */
export const PUBLISHER_INTERVAL_MS = 60_000;
export const HEALTH_PATH = '/healthz';

type Signal = 'SIGTERM' | 'SIGINT';
const SIGNALS: readonly Signal[] = ['SIGTERM', 'SIGINT'];

/** Where the process signals come from (tests pass an emitter). */
export interface SignalSource {
  once(signal: Signal, listener: () => void): unknown;
  off(signal: Signal, listener: () => void): unknown;
}

/** What the boot is made of; every part has a production default (tests inject fakes). */
export interface ServerDeps {
  /** Default: a `pg` pool on `config.databaseUrl`. Closed at shutdown either way. */
  db?: Db;
  /** Default: the process. */
  signals?: SignalSource;
  log?: (message: string) => void;
  /** Seconds. */
  now?: () => number;
  /** This process's lease holder id (default: random). */
  holder?: string;
  /** Every relay pool the server opens: the stores', the public reads', the publisher's. */
  makePool?: () => SimplePool;
  /** `fee` reads the fee config (a bucket apart from the stores' `solana`). */
  chains?: Pick<ChainClients, 'solana' | 'fee' | 'tempo' | 'evm'>;
  /** What the fee config is read with (`TreasuryReader`'s, for tests). */
  treasuryReadConfig?: ConstructorParameters<typeof TreasuryReader>[2];
  eip3009Check?: typeof startCheckEip3009;
  eip3009Sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Each store's first-sweep delay (ms); default random over the sweep interval (the supervisor's). */
  firstSweepDelayMs?: () => number;
  /** How the webhook requests resolve and connect (the load script's local sink). */
  webhookFetchDeps?: FetchGuardDeps;
  leaseRenewMs?: number;
  requestPollMs?: number;
  publisherIntervalMs?: number;
  /** Default: `config.port`; 0 picks a free port (tests). */
  port?: number;
  /** Named boot and shutdown steps, in the order they run (tests). */
  trace?: (step: string) => void;
}

export interface ServerHandle {
  readonly holder: string;
  /** The HTTP port; undefined until HTTP serves (and when stopped during the boot). */
  readonly port: number | undefined;
  /** The supervisor; undefined before its boot step. */
  readonly supervisor: StoreSupervisor | undefined;
  /** Stop everything (idempotent): resolves once the shutdown is done. */
  stop(): Promise<void>;
  /** Resolves once a shutdown (by `stop` or a signal) is done. */
  readonly stopped: Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageVersion(): string {
  try {
    const manifest: unknown = createRequire(import.meta.url)('../package.json');
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      return String(manifest.version);
    }
  } catch {
    // Not found next to the bundle: the version is only informative.
  }
  return 'unknown';
}

/** The User-Agent of the webhook requests. */
export const USER_AGENT = `elisym-paycore-server/${packageVersion()}`;

/** Networks with any operator RPC configured. */
export function configuredNetworks(config: Pick<PaycoreConfig, 'rpcs'>): Network[] {
  return NETWORKS.filter((network) => {
    const rpcs = config.rpcs[network];
    return (
      rpcs.solana !== undefined ||
      rpcs.fee !== undefined ||
      rpcs.tempo !== undefined ||
      Object.values(rpcs.evm).some((url) => url !== undefined)
    );
  });
}

/** The networks in use: of every store that is not `pending`, and every network with an operator RPC. */
export async function networksInUse(
  db: Pick<Db, 'query'>,
  config: Pick<PaycoreConfig, 'rpcs'>,
): Promise<Network[]> {
  const rows = await db.query<{ network: Network }>(
    `select distinct c.network from stores s join store_config c on c.owner = s.owner
     where s.status <> 'pending'`,
  );
  const used = new Set<Network>([...rows.map((row) => row.network), ...configuredNetworks(config)]);
  return NETWORKS.filter((network) => used.has(network));
}

/** The fee config RPC of a network: the operator's fee RPC, else its Solana RPC, else the public endpoint. */
export function feeRpcOf(config: Pick<PaycoreConfig, 'rpcs'>, network: Network): string {
  const rpcs = config.rpcs[network];
  return feeConfigRpcUrl({
    network,
    ...(rpcs.solana === undefined ? {} : { rpcUrl: rpcs.solana }),
    ...(rpcs.fee === undefined ? {} : { feeConfigRpcUrl: rpcs.fee }),
  });
}

/** The operator EVM RPCs of `networks`, as the EIP-3009 boot check takes them. */
export function evmConfigs(
  config: Pick<PaycoreConfig, 'rpcs'>,
  networks: readonly Network[],
): Pick<MerchantConfig, 'network' | 'evm'>[] {
  const configs: Pick<MerchantConfig, 'network' | 'evm'>[] = [];
  for (const network of networks) {
    const evm: NonNullable<MerchantConfig['evm']> = {};
    for (const slug of EIP3009_SLUGS) {
      const rpcUrl = config.rpcs[network].evm[slug];
      if (rpcUrl !== undefined) {
        evm[slug] = { rpcUrl };
      }
    }
    if (Object.keys(evm).length > 0) {
      configs.push({ network, evm });
    }
  }
  return configs;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** The HTTP routes: `/healthz`, the admin API, else 404. */
function routes(
  admin: (input: GatewayRequest) => Promise<Response | undefined>,
): (input: GatewayRequest) => Promise<Response> {
  return async (input) => {
    const url = new URL(input.request.url);
    if (url.pathname === HEALTH_PATH && input.request.method === 'GET') {
      return jsonResponse({ status: 'ok' }, 200);
    }
    return (await admin(input)) ?? jsonResponse({ error: 'not_found' }, 404);
  };
}

function listening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

/** Thrown at a boot step reached after a stop was asked: the boot gives up there. */
class StopRequested extends Error {
  constructor() {
    super('stopped during the boot');
    this.name = 'StopRequested';
  }
}

class PaycoreServer implements ServerHandle {
  readonly holder: string;
  port: number | undefined;
  supervisor: StoreSupervisor | undefined;
  readonly stopped: Promise<void>;

  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly trace: (step: string) => void;
  private readonly signals: SignalSource;
  private readonly makePool: () => SimplePool;
  private db: Db | undefined;
  private eip3009: Eip3009Boot | undefined;
  private holderRequests: HolderRequests | undefined;
  private pump: RequestPump | undefined;
  private publisher: OwnerEventPublisher | undefined;
  private httpServer: Server | undefined;
  private pools: StorePools | undefined;
  private unlistenStores: (() => Promise<void>) | undefined;
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private leaseRound: Promise<void> | undefined;
  private leaseAgain = false;
  /** `now` of the last lease round that succeeded: the leases taken then run out `LEASE_TTL_SECS` after it. */
  private lastRenewedAt: number | undefined;
  /** Whether the nodes were stopped for want of a renewal (logged once until a renewal succeeds). */
  private fenced = false;
  private readonly slotsStop = new AbortController();
  private stopRequested = false;
  private stopping: Promise<void> | undefined;
  private booting: Promise<void> = Promise.resolve();
  private resolveStopped: () => void = () => undefined;
  private readonly onSignal = (): void => {
    this.log('shutting down');
    void this.stop();
  };

  constructor(
    private readonly config: PaycoreConfig,
    private readonly deps: ServerDeps,
  ) {
    this.log = deps.log ?? ((message: string) => console.error(message));
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.trace = deps.trace ?? (() => undefined);
    this.signals = deps.signals ?? process;
    this.holder = deps.holder ?? newHolderId();
    this.makePool = deps.makePool ?? listeningPool;
    this.stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  /** Hook the signals (before anything starts), then boot. */
  start(): Promise<void> {
    for (const signal of SIGNALS) {
      this.signals.once(signal, this.onSignal);
    }
    this.booting = this.boot();
    return this.booting;
  }

  stop(): Promise<void> {
    this.stopRequested = true;
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private checkpoint(): void {
    if (this.stopRequested) {
      throw new StopRequested();
    }
  }

  private requireDb(): Db {
    if (this.db === undefined) {
      throw new Error('the database is not open');
    }
    return this.db;
  }

  private async boot(): Promise<void> {
    const { config, deps, log, now, trace } = this;
    const db = deps.db ?? createPgDb(config.databaseUrl, log);
    this.db = db;
    trace('migrate');
    await migrate(db);
    this.checkpoint();

    trace('vault');
    const vault = new KeyVault(config.masterKeyHex);

    const chains = deps.chains ?? new ChainClients();
    const networks = await networksInUse(db, config);
    trace('treasuries');
    const treasuries = new NetworkTreasuries({
      rpcs: Object.fromEntries(
        NETWORKS.map((network) => [network, chains.fee(feeRpcOf(config, network))]),
      ),
      ...(deps.treasuryReadConfig === undefined ? {} : { readConfig: deps.treasuryReadConfig }),
    });
    for (const network of networks) {
      const refresh = await treasuries.refreshFor(network, emptyLedger(), now());
      if (refresh.kind === 'wrong_cluster') {
        throw new Error(`fee config of ${network}: ${refresh.problem}`);
      }
      if (refresh.kind === 'unreachable') {
        log(
          `warning: the fee config of ${network} could not be read now (${refresh.problem}); read again when a store asks`,
        );
      }
    }
    this.checkpoint();

    trace('eip3009');
    const eip3009 = new Eip3009Boot({
      configs: evmConfigs(config, networks),
      clientFor: (url) => chains.evm(url),
      log,
      now,
      ...(deps.eip3009Check === undefined ? {} : { check: deps.eip3009Check }),
      ...(deps.eip3009Sleep === undefined ? {} : { sleep: deps.eip3009Sleep }),
    });
    this.eip3009 = eip3009;
    await eip3009.start();
    this.checkpoint();

    trace('supervisor');
    const pools = new StorePools(this.makePool);
    this.pools = pools;
    const setup: SetupPassDeps = {
      db,
      vault,
      pools,
      treasuries,
      inboxRelayAllowlist: config.inboxRelays,
      log,
      now,
    };
    const supervisor = new StoreSupervisor({
      db,
      vault,
      holder: this.holder,
      pools,
      chains,
      treasuries,
      boot: eip3009,
      webhookSlots: new WebhookSlots({
        signal: this.slotsStop.signal,
        ...(deps.webhookFetchDeps === undefined ? {} : { deps: deps.webhookFetchDeps }),
      }),
      rpcs: config.rpcs,
      inboxRelayAllowlist: config.inboxRelays,
      userAgent: USER_AGENT,
      heal: healPass(setup),
      publicReads: this.makePool,
      ...(deps.firstSweepDelayMs === undefined
        ? {}
        : { firstSweepDelayMs: deps.firstSweepDelayMs }),
      log,
      now,
    });
    this.supervisor = supervisor;
    const holderRequests = new HolderRequests({ db, supervisor, setup, log });
    this.holderRequests = holderRequests;

    trace('leases');
    this.unlistenStores = await db.listen(STORES_CHANNEL, () => {
      void this.runLeaseRound();
    });
    this.checkpoint();
    await this.runLeaseRound();
    this.checkpoint();
    this.leaseTimer = setInterval(() => {
      // Checked on the timer too: a round hanging on the database never fails.
      this.fenceIfExpired();
      void this.runLeaseRound();
    }, deps.leaseRenewMs ?? LEASE_RENEW_MS);

    trace('publisher');
    const publisher = new OwnerEventPublisher({
      db,
      vault,
      makePool: this.makePool,
      inboxRelayAllowlist: config.inboxRelays,
      log,
      now,
    });
    this.publisher = publisher;
    publisher.start(deps.publisherIntervalMs ?? PUBLISHER_INTERVAL_MS);
    publisher.runOnce().catch((error: unknown) => {
      log(`publisher round failed: ${errorText(error)}`);
    });

    trace('pump');
    const pump = new RequestPump({
      db,
      holder: holderRequests,
      log,
      ...(deps.requestPollMs === undefined ? {} : { pollMs: deps.requestPollMs }),
    });
    this.pump = pump;
    await pump.start();
    this.checkpoint();

    trace('http');
    const directory = new StoreDirectory({
      db,
      vault,
      inboxRelays: config.inboxRelays,
      rpcs: config.rpcs,
      now,
    });
    const admin = createAdminApi({
      directory,
      db,
      publicBase: config.publicBase,
      operator: config.operator,
      now,
      newestOnRelays: (owner, kind) => this.newestDate(directory, owner, kind),
    });
    const httpServer = serveGateway(routes(admin), {
      port: deps.port ?? config.port,
      trustProxy: config.trustProxy,
    });
    this.httpServer = httpServer;
    await listening(httpServer);
    const address = httpServer.address();
    this.port = typeof address === 'object' && address !== null ? address.port : undefined;
    log(`paycore server listening on ${this.port ?? config.port} as holder ${this.holder}`);
  }

  /** `created_at` of O's newest owner event of `kind` on the offer relays (a 30490: of O's store). */
  private async newestDate(
    directory: StoreDirectory,
    owner: string,
    kind: OwnerEventKind,
  ): Promise<number | undefined> {
    if (kind === KIND_PAYTO) {
      return (await newestOnRelays(owner, kind, { makePool: this.makePool }))?.created_at;
    }
    const store = await directory.store(owner);
    if (store === undefined) {
      return undefined;
    }
    const event = await newestOnRelays(owner, kind, {
      d: store.storePubkey,
      makePool: this.makePool,
    });
    return event?.created_at;
  }

  /** Take or renew the leases and reconcile; rounds never overlap (one asked meanwhile runs after). */
  private runLeaseRound(): Promise<void> {
    if (this.leaseRound !== undefined) {
      this.leaseAgain = true;
      return this.leaseRound;
    }
    this.leaseRound = this.leaseRounds().finally(() => {
      this.leaseRound = undefined;
    });
    return this.leaseRound;
  }

  private async leaseRounds(): Promise<void> {
    do {
      this.leaseAgain = false;
      const { supervisor } = this;
      if (this.stopRequested || supervisor === undefined) {
        return;
      }
      const before = new Set(supervisor.leased);
      const at = this.now();
      try {
        const leased = await acquireLeases(this.requireDb(), this.holder, at);
        if (this.stopRequested) {
          return;
        }
        if (this.now() >= at + LEASE_TTL_SECS) {
          // Answered after the leases it took ran out: they may be another holder's by now.
          this.fenceIfExpired();
          continue;
        }
        this.lastRenewedAt = at;
        if (this.fenced) {
          this.fenced = false;
          this.log('leases renewed again: serving the leased stores');
        }
        supervisor.reconcile(leased);
        if (leased.some((lease) => !before.has(lease.owner))) {
          // A store new to this holder (an activation, a takeover): its queued requests now.
          void this.pump?.kick(false);
        }
      } catch (error) {
        this.log(`lease round failed: ${errorText(error)}`);
        this.fenceIfExpired();
      }
    } while (this.leaseAgain);
  }

  /**
   * Stop every node when the last successful renewal is `LEASE_TTL_SECS` old:
   * the leases may have moved to another holder, whose saves would fence ours
   * only once a node of ours tries one.
   */
  private fenceIfExpired(): void {
    const { supervisor, lastRenewedAt } = this;
    if (
      this.stopRequested ||
      supervisor === undefined ||
      lastRenewedAt === undefined ||
      this.now() < lastRenewedAt + LEASE_TTL_SECS
    ) {
      return;
    }
    if (!this.fenced) {
      this.fenced = true;
      this.log(
        `no lease renewed for ${this.now() - lastRenewedAt} s: stopping every store until a renewal succeeds`,
      );
    }
    if (supervisor.leased.length > 0) {
      supervisor.reconcile([]);
    }
  }

  private async shutdown(): Promise<void> {
    // A boot in progress first reaches its next step and gives up there.
    await this.booting.catch(() => undefined);
    try {
      await this.teardown();
    } catch (error) {
      this.log(`shutdown: ${errorText(error)}`);
    }
    for (const signal of SIGNALS) {
      this.signals.off(signal, this.onSignal);
    }
    this.log('paycore server stopped');
    this.resolveStopped();
  }

  private async teardown(): Promise<void> {
    const { trace } = this;
    trace('stop:http');
    const httpClosed =
      this.httpServer === undefined ? Promise.resolve() : closeServer(this.httpServer);
    clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    await this.unlistenStores?.().catch(() => undefined);
    // A round in progress would take leases again after the supervisor let them go.
    await this.leaseRound;
    trace('stop:pump');
    await this.pump?.stop();
    trace('stop:holder');
    await this.holderRequests?.idle();
    trace('stop:publisher');
    await this.publisher?.stop();
    this.eip3009?.stop();
    trace('stop:supervisor');
    await this.supervisor?.shutdown();
    this.slotsStop.abort();
    trace('stop:pools');
    this.pools?.closeAll();
    await httpClosed;
    trace('stop:db');
    await this.db?.close();
  }
}

/**
 * Boot the server (order above). Resolves with its handle once HTTP serves,
 * or once a signal during the boot stopped it (`stopped` then resolves when
 * the shutdown is done); rejects, after undoing what started, when a boot
 * step fails, such as a fee config RPC of another cluster.
 */
export async function startServer(
  config: PaycoreConfig,
  deps: ServerDeps = {},
): Promise<ServerHandle> {
  const server = new PaycoreServer(config, deps);
  try {
    await server.start();
  } catch (error) {
    if (error instanceof StopRequested) {
      return server;
    }
    (deps.log ?? ((message: string) => console.error(message)))(`boot failed: ${errorText(error)}`);
    await server.stop();
    throw error;
  }
  return server;
}
