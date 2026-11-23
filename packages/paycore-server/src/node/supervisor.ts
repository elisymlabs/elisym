/**
 * The store supervisor (sub-plan step 10): runs one merchant-node store node
 * per leased store, each with its own control queue. Every start, stop and
 * admin change of a store runs on that queue, and every change it applies
 * opens a fresh ledger handle from the database (a node that halted on a
 * refused save may hold diverged memory; it is never reused).
 */
import type { QueryPool } from '@merchant-node/checks';
import { type LedgerState, upgradeLedger } from '@merchant-node/ledger';
import { listeningPool } from '@merchant-node/relay-pool';
import { type StoreNode, startStoreNode } from '@merchant-node/store-node';
import { ALERT_KINDS, clearAlert, raiseAlert } from '../alerts';
import type { ChainClients } from '../chain/clients';
import type { Eip3009Boot } from '../chain/eip3009-boot';
import type { NetworkTreasuries } from '../chain/treasuries';
import type { Db } from '../db/db';
import type { KeyVault } from '../db/keys';
import type { StorePools } from '../relay/pools';
import { type LeasedStore, type StoreStatus, releaseLeases } from '../state/leases';
import { type LedgerHandle, PgLedgerStore } from '../state/ledger-store';
import type { WebhookSlots } from '../webhook-fetch';
import {
  type OperatorRpcs,
  StartRefused,
  type StoreBundle,
  loadStoreBundle,
  readCommitted,
} from './load';
import {
  HealGate,
  type OfferVerdict,
  controlBackoffMs,
  judgeOffers,
  startChecks,
} from './start-checks';

/** Failed starts in a row before a store is marked `halted` (it is still retried). */
export const MAX_FAILED_STARTS = 3;
/**
 * A node that ran this long before it failed counts as a new streak: until
 * then a start that succeeded does not clear the count, so a node that keeps
 * stopping itself right after it starts is `halted` like one that never starts.
 */
export const STABLE_RUN_SECS = 30 * 60;
/** How often a running store's relays are read again for drift and offers (the pump's tick). */
export const DRIFT_CHECK_SECS = 15 * 60;

/** Something the store runs without (a rail, the webhook sender) or that the relays serve wrongly: `degraded`. */
export interface StoreNotice {
  kind: string;
  message: string;
}

/** The notice kinds a start decides afresh: each is raised when present and cleared when not. */
const NOTICE_KINDS: readonly string[] = [
  ALERT_KINDS.railUnavailable,
  ALERT_KINDS.webhookSecretMissing,
  ALERT_KINDS.drift,
];

export interface ControlOptions<Result> {
  /** Whether the node starts again after the task (default: always). False retires the run. */
  restart?: (result: Result) => boolean;
}

/** The statuses the supervisor moves a store between; it never touches the others. */
const RUN_STATUSES: readonly StoreStatus[] = ['active', 'degraded', 'halted'];

export interface SupervisorDeps {
  db: Db;
  vault: KeyVault;
  /** This process's lease holder id. */
  holder: string;
  pools: Pick<StorePools, 'open' | 'close'>;
  chains: Pick<ChainClients, 'solana' | 'tempo' | 'evm'>;
  treasuries: Pick<NetworkTreasuries, 'refreshFor'>;
  boot: Pick<Eip3009Boot, 'register'>;
  webhookSlots: Pick<WebhookSlots, 'forStore'>;
  rpcs: OperatorRpcs;
  /** `PAYCORE_INBOX_RELAYS` (P7). */
  inboxRelayAllowlist: readonly string[];
  /** The webhook requests' User-Agent. */
  userAgent: string;
  /**
   * The heal pass (a setup pass with the committed owner events), run as a
   * control task when the start checks find offers it can fix. The caller saves.
   */
  heal?: (owner: string, handle: LedgerHandle) => Promise<void>;
  /**
   * A new unauthenticated pool for one read of the public offer relays (at a
   * start and in each periodic check), destroyed right after it: a store's own
   * pool keeps sockets to its inbox relays only. Default: a fresh nostr-tools pool.
   */
  publicReads?: () => PublicReadPool;
  log?: (message: string) => void;
  /** Seconds. */
  now?: () => number;
}

/** A pool for one public read, destroyed after it. */
export type PublicReadPool = QueryPool & { destroy: () => void };

interface RunningStore {
  node: StoreNode;
  storePubkey: string;
  /** The store's own pool: the periodic checks read the relays with it while the node runs. */
  pool: QueryPool;
  /** What the offers are judged against: the node's config, products and live ledger. */
  judged: Pick<StoreBundle, 'config' | 'products'> & { state: LedgerState };
  /** What the store runs without (rails, the webhook sender), as found at its start. */
  notices: StoreNotice[];
  /** When the relays were last read for this run (seconds). */
  checkedAt: number;
  /** A periodic check waits on the control queue: no second one is queued behind it. */
  recheckQueued: boolean;
  /** The store's webhook sends: aborted right after `node.stop()` (WebhookSlots' order). */
  webhookStop: AbortController;
  unregister: () => void;
  generation: number;
}

interface StoreRun {
  owner: string;
  epoch: number;
  status: StoreStatus;
  queue: Promise<void>;
  running?: RunningStore;
  startQueued: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  healTimer?: ReturnType<typeof setTimeout>;
  failedStarts: number;
  retryAttempt: number;
  /** When the running node started (seconds); undefined while none runs. */
  startedAt?: number;
  heals: HealGate;
  /** Counts starts: a stop reported by an older node is ignored. */
  generation: number;
  removed: boolean;
}

/** A control task for a store this holder does not serve (not leased here, or being removed). */
export class NotServed extends Error {
  constructor(readonly owner: string) {
    super(`store ${owner} is not run by this holder`);
    this.name = 'NotServed';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a started store runs without, or what the relays serve that the server never made. */
export function startNotices(
  bundle: Pick<StoreBundle, 'unavailableRails' | 'webhookSecretMissing'>,
  drift: readonly string[],
): StoreNotice[] {
  const notices: StoreNotice[] = [];
  if (bundle.unavailableRails.length > 0) {
    notices.push({
      kind: ALERT_KINDS.railUnavailable,
      message: `no operator RPC for ${bundle.unavailableRails.join(', ')}: payments there are not verified`,
    });
  }
  if (bundle.webhookSecretMissing) {
    notices.push({
      kind: ALERT_KINDS.webhookSecretMissing,
      message: 'the webhook URL has no secret: webhooks queue and are sent once one is set',
    });
  }
  if (drift.length > 0) {
    notices.push({ kind: ALERT_KINDS.drift, message: drift.join('; ') });
  }
  return notices;
}

export class StoreSupervisor {
  private readonly runs = new Map<string, StoreRun>();
  /** The queues of runs removed while still stopping: a new run of the store waits for them. */
  private readonly retired = new Map<string, Promise<void>>();
  private readonly ledgers: PgLedgerStore;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private closed = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = deps.log ?? ((message) => console.error(message));
    this.ledgers = new PgLedgerStore(deps.db, this.now);
  }

  /** The owners whose node runs now. */
  get running(): string[] {
    return [...this.runs.values()]
      .filter((run) => run.running !== undefined)
      .map((run) => run.owner);
  }

  /** The owners this holder serves now (running, halted or retrying). */
  get leased(): string[] {
    return [...this.runs.values()].filter((run) => !run.removed).map((run) => run.owner);
  }

  /** The running node of a store, if any. */
  nodeOf(owner: string): StoreNode | undefined {
    return this.runs.get(owner)?.running?.node;
  }

  /**
   * Apply the set of stores this holder leases now: start the new ones,
   * restart one whose lease epoch changed (with a fresh handle), stop the ones
   * no longer leased. A status change alone never stops a running store.
   */
  reconcile(leased: readonly LeasedStore[]): void {
    if (this.closed) {
      return;
    }
    const seen = new Set<string>();
    for (const lease of leased) {
      seen.add(lease.owner);
      const known = this.runs.get(lease.owner);
      if (known === undefined) {
        const run = this.newRun(lease);
        this.runs.set(lease.owner, run);
        this.queueStart(run);
        continue;
      }
      known.status = lease.status;
      if (known.epoch !== lease.epoch) {
        known.epoch = lease.epoch;
        this.clearTimers(known);
        known.failedStarts = 0;
        known.retryAttempt = 0;
        // One task: a start queued before this one may run first, and it is stopped and started again here.
        void this.enqueue(known, async () => {
          await this.stopRun(known);
          await this.startRun(known);
        });
      } else if (
        known.running === undefined &&
        !known.startQueued &&
        known.retryTimer === undefined
      ) {
        this.queueStart(known);
      }
    }
    for (const run of [...this.runs.values()]) {
      if (!seen.has(run.owner)) {
        this.remove(run);
      }
    }
  }

  /**
   * Run `task` on the store's control queue: stop its node, open a fresh
   * handle on its ledger from the database (upgraded in memory), run the task
   * (it saves through the handle), then start the node again from the
   * database. Resolves or rejects with the task.
   */
  applyControl<Result>(
    owner: string,
    task: (handle: LedgerHandle) => Promise<Result>,
    options: ControlOptions<Result> = {},
  ): Promise<Result> {
    const run = this.runs.get(owner);
    if (run === undefined || run.removed || this.closed) {
      return Promise.reject(new NotServed(owner));
    }
    return this.enqueue(run, async () => {
      this.clearRetry(run);
      await this.stopRun(run);
      let restart = true;
      try {
        const handle = await this.ledgers.open(owner, run.epoch, this.deps.holder);
        upgradeLedger(handle.state, `the ledger of ${owner}`);
        const result = await task(handle);
        restart = options.restart?.(result) ?? true;
        return result;
      } finally {
        if (!restart) {
          this.remove(run);
        } else if (!run.removed && !this.closed) {
          await this.startRun(run);
        }
      }
    });
  }

  /** Resolves once every store's queue has nothing left to run (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const queues = [...[...this.runs.values()].map((run) => run.queue), ...this.retired.values()];
      await Promise.all(queues);
      const after = [...[...this.runs.values()].map((run) => run.queue), ...this.retired.values()];
      if (
        after.length === queues.length &&
        after.every((queue, index) => queue === queues[index])
      ) {
        return;
      }
    }
  }

  /**
   * Stop every node (each `stop` awaits its task in progress), release this
   * holder's leases so another process takes the stores at once, and log the
   * copies for the admin that were never sent.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    let lostCopies = 0;
    const stops = [...this.runs.values()].map((run) => {
      this.clearTimers(run);
      return this.enqueue(run, async () => {
        lostCopies += await this.stopRun(run);
      });
    });
    await Promise.allSettled(stops);
    await this.idle();
    this.runs.clear();
    await releaseLeases(this.deps.db, this.deps.holder);
    this.log(
      `supervisor stopped${lostCopies > 0 ? `: ${lostCopies} copy(ies) for the admin lost (selfCopies.pending)` : ''}`,
    );
  }

  private newRun(lease: LeasedStore): StoreRun {
    return {
      owner: lease.owner,
      epoch: lease.epoch,
      status: lease.status,
      queue: this.retired.get(lease.owner) ?? Promise.resolve(),
      startQueued: false,
      failedStarts: 0,
      retryAttempt: 0,
      heals: new HealGate(),
      generation: 0,
      removed: false,
    };
  }

  private remove(run: StoreRun): void {
    run.removed = true;
    this.clearTimers(run);
    this.runs.delete(run.owner);
    void this.enqueue(run, () => this.stopRun(run).then(() => undefined));
    const queue = run.queue;
    this.retired.set(run.owner, queue);
    void queue.then(() => {
      if (this.retired.get(run.owner) === queue) {
        this.retired.delete(run.owner);
      }
    });
  }

  private enqueue<Result>(run: StoreRun, task: () => Promise<Result>): Promise<Result> {
    const result = run.queue.then(task);
    run.queue = result.then(
      () => undefined,
      (error: unknown) => {
        this.storeLog(run.owner)(`error: ${errorText(error)}`);
      },
    );
    return result;
  }

  private queueStart(run: StoreRun): void {
    if (run.startQueued || run.removed || this.closed) {
      return;
    }
    run.startQueued = true;
    void this.enqueue(run, () => this.startRun(run));
  }

  private clearRetry(run: StoreRun): void {
    if (run.retryTimer !== undefined) {
      clearTimeout(run.retryTimer);
      run.retryTimer = undefined;
    }
  }

  private clearTimers(run: StoreRun): void {
    this.clearRetry(run);
    if (run.healTimer !== undefined) {
      clearTimeout(run.healTimer);
      run.healTimer = undefined;
    }
  }

  private storeLog(owner: string): (message: string) => void {
    return (message) => this.log(`store ${owner.slice(0, 12)}: ${message}`);
  }

  /** Load, check and start the store's node; on the control queue only. */
  private async startRun(run: StoreRun): Promise<void> {
    run.startQueued = false;
    if (run.removed || this.closed || run.running !== undefined) {
      return;
    }
    this.clearRetry(run);
    run.generation += 1;
    const generation = run.generation;
    const { owner } = run;
    const log = this.storeLog(owner);
    const { deps } = this;
    let storePubkey: string | undefined;
    let unregister: (() => void) | undefined;
    let offers: OfferVerdict | undefined;
    const notices: StoreNotice[] = [];
    try {
      const bundle = await loadStoreBundle(deps.db, deps.vault, owner, {
        holder: deps.holder,
        epoch: run.epoch,
        rpcs: deps.rpcs,
        inboxRelayAllowlist: deps.inboxRelayAllowlist,
        now: this.now,
        ledgers: this.ledgers,
      });
      const pool = deps.pools.open(bundle.storePubkey);
      storePubkey = bundle.storePubkey;
      const publicPool = this.publicReads();
      let checked: Awaited<ReturnType<typeof startChecks>>;
      try {
        checked = await startChecks(bundle, {
          pool,
          publicPool,
          treasuries: deps.treasuries,
          boot: deps.boot,
          evmClientFor: (url) => deps.chains.evm(url),
          log,
          now: this.now,
        });
      } finally {
        publicPool.destroy();
      }
      if (checked.kind === 'refused') {
        throw new StartRefused(owner, checked.problem);
      }
      unregister = checked.unregister;
      offers = checked.offers;
      notices.push(...startNotices(bundle, checked.drift));
      const { config, handle, webhook } = bundle;
      const { state } = handle;
      const webhookStop = new AbortController();
      const node = await startStoreNode({
        pool,
        config,
        products: bundle.products,
        state,
        storePubkey: bundle.storePubkey,
        storeSecretKey: bundle.storeSecretKey,
        save: () => handle.save(state),
        ...(config.rpcUrl === undefined ? {} : { solanaRpc: deps.chains.solana(config.rpcUrl) }),
        ...(config.tempo?.rpcUrl === undefined
          ? {}
          : { tempoClient: deps.chains.tempo(config.tempo.rpcUrl) }),
        refreshTreasuries: () => deps.treasuries.refreshFor(config.network, state, this.now()),
        eip3009: checked.eip3009,
        ...(checked.outbox === undefined ? {} : { outbox: checked.outbox }),
        ...(webhook === undefined
          ? {}
          : {
              webhook: {
                target: webhook,
                userAgent: deps.userAgent,
                fetch: deps.webhookSlots.forStore(owner, { signal: webhookStop.signal }),
              },
            }),
        log,
        now: this.now,
        stop: (problem) => this.nodeStopped(run, generation, problem),
        haltOnSaveFailure: true,
      });
      run.running = {
        node,
        storePubkey: bundle.storePubkey,
        pool,
        judged: { config, products: bundle.products, state },
        notices: startNotices(bundle, []),
        checkedAt: this.now(),
        recheckQueued: false,
        webhookStop,
        unregister: checked.unregister,
        generation,
      };
    } catch (error) {
      unregister?.();
      if (storePubkey !== undefined) {
        deps.pools.close(storePubkey);
      }
      if (error instanceof StartRefused) {
        await this.refused(run, error.message);
      } else {
        await this.failed(run, `the start failed: ${errorText(error)}`);
      }
      return;
    }
    const problems = [
      ...notices.map((notice) => notice.message),
      ...(offers === undefined ? [] : offers.problems),
    ];
    log(problems.length === 0 ? 'started' : `started degraded: ${problems.join('; ')}`);
    await this.started(run, offers, notices);
  }

  /** Stop the store's node: on the control queue only. Returns its copies for the admin not sent. */
  private async stopRun(run: StoreRun): Promise<number> {
    const { running } = run;
    if (running === undefined) {
      return 0;
    }
    run.running = undefined;
    // `stop` halts the node in this same turn, before the abort: a webhook
    // refused or aborted now commits nothing, and its entry is sent again.
    const stopping = running.node.stop();
    running.webhookStop.abort();
    await stopping;
    this.deps.pools.close(running.storePubkey);
    running.unregister();
    const lost = running.node.selfCopies.pending;
    if (lost > 0) {
      this.storeLog(run.owner)(`${lost} copy(ies) for the admin lost: stopped before sending them`);
    }
    return lost;
  }

  /** A node's own `stop`: queued, so a stop reported while its start still runs is handled after it. */
  private nodeStopped(run: StoreRun, generation: number, problem: string): void {
    void this.enqueue(run, async () => {
      if (run.running?.generation !== generation) {
        return;
      }
      await this.stopRun(run);
      await this.failed(run, `the node stopped: ${problem}`, ALERT_KINDS.nodeStopped);
    });
  }

  /**
   * Read the relays again for every running store whose last read is
   * `DRIFT_CHECK_SECS` old (the pump's tick): drift and offers are judged as
   * at a start, alerts raised or cleared and the store moved between `active`
   * and `degraded`, with a heal under the same rule. Each check runs on its
   * store's control queue (so its pool stays open for the read) without
   * stopping the node; a store whose check still waits on its queue gets no
   * second one. Resolves once the checks queued here are done: a caller that
   * serves other stores does not await it (one store's long control task
   * would hold the others).
   */
  async recheckOffers(): Promise<void> {
    if (this.closed) {
      return;
    }
    const now = this.now();
    const checks: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      const { running } = run;
      if (
        run.removed ||
        running === undefined ||
        running.recheckQueued ||
        now - running.checkedAt < DRIFT_CHECK_SECS
      ) {
        continue;
      }
      running.checkedAt = now;
      running.recheckQueued = true;
      checks.push(
        this.enqueue(run, () => this.recheck(run, running))
          .catch((error: unknown) => {
            this.storeLog(run.owner)(`the offer check failed: ${errorText(error)}`);
          })
          .finally(() => {
            running.recheckQueued = false;
          }),
      );
    }
    await Promise.all(checks);
  }

  /** One periodic check, on the control queue: skipped when the run it was queued for is gone. */
  private async recheck(run: StoreRun, queuedFor: RunningStore): Promise<void> {
    const { running } = run;
    if (running === undefined || running.generation !== queuedFor.generation) {
      return;
    }
    const committed = await readCommitted(this.deps.db, run.owner);
    const publicPool = this.publicReads();
    let judged: Awaited<ReturnType<typeof judgeOffers>>;
    try {
      judged = await judgeOffers(
        { store: running.pool, publicPool },
        { owner: run.owner, storePubkey: running.storePubkey, committed, ...running.judged },
      );
    } finally {
      publicPool.destroy();
    }
    running.checkedAt = this.now();
    await this.assess(run, judged.offers, [
      ...running.notices,
      ...startNotices({ unavailableRails: [], webhookSecretMissing: false }, judged.drift),
    ]);
  }

  private async started(
    run: StoreRun,
    offers: OfferVerdict | undefined,
    notices: readonly StoreNotice[],
  ): Promise<void> {
    const { db } = this.deps;
    const now = this.now();
    // The failed-start count and the backoff carry on until the node proves stable (see `failed`);
    // a restart for a control task keeps the time the node first started.
    run.startedAt ??= now;
    for (const kind of [
      ALERT_KINDS.startRefused,
      ALERT_KINDS.startFailed,
      ALERT_KINDS.nodeStopped,
    ]) {
      await clearAlert(db, run.owner, kind, { now });
    }
    await this.assess(run, offers, notices);
  }

  /** Raise or clear the notices and the offer alert, set `active` / `degraded`, and plan a heal. */
  private async assess(
    run: StoreRun,
    offers: OfferVerdict | undefined,
    notices: readonly StoreNotice[],
  ): Promise<void> {
    const { db } = this.deps;
    const now = this.now();
    const log = this.storeLog(run.owner);
    for (const kind of NOTICE_KINDS) {
      const notice = notices.find((entry) => entry.kind === kind);
      if (notice === undefined) {
        await clearAlert(db, run.owner, kind, { now });
      } else {
        await raiseAlert(db, run.owner, kind, notice.message, { now, log });
      }
    }
    const reasons = notices.map((notice) => notice.message);
    if (offers === undefined) {
      run.heals.reset();
      await clearAlert(db, run.owner, ALERT_KINDS.offerMismatch, { now });
      if (reasons.length === 0) {
        await this.setStatus(run, 'active', undefined);
      } else {
        await this.setStatus(run, 'degraded', reasons.join('; '));
      }
      return;
    }
    const message = `the relays offer buyers what the ledger does not honour: ${offers.problems.join('; ')}`;
    await raiseAlert(db, run.owner, ALERT_KINDS.offerMismatch, message, { now, log });
    await this.setStatus(run, 'degraded', [...reasons, message].join('; '));
    const { heal } = this.deps;
    if (!offers.heal || heal === undefined) {
      return;
    }
    const delayMs = run.heals.plan(offers.key, now * 1000);
    if (delayMs === undefined) {
      return;
    }
    const runHeal = () => {
      run.healTimer = undefined;
      if (run.removed || this.closed) {
        return;
      }
      this.applyControl(run.owner, (handle) => heal(run.owner, handle)).catch((error: unknown) => {
        this.storeLog(run.owner)(`the heal pass failed: ${errorText(error)}`);
      });
    };
    if (run.healTimer !== undefined) {
      clearTimeout(run.healTimer);
      run.healTimer = undefined;
    }
    if (delayMs === 0) {
      runHeal();
    } else {
      run.healTimer = setTimeout(runHeal, delayMs);
    }
  }

  private async refused(run: StoreRun, problem: string): Promise<void> {
    const log = this.storeLog(run.owner);
    if (!(await this.holdsLease(run))) {
      log(`start refused (${problem}); the lease moved: not retried here`);
      return;
    }
    log(`start refused: ${problem}`);
    run.startedAt = undefined;
    await this.setStatus(run, 'halted', problem);
    await raiseAlert(this.deps.db, run.owner, ALERT_KINDS.startRefused, problem, {
      now: this.now(),
      log,
    });
    this.scheduleRetry(run);
  }

  private async failed(
    run: StoreRun,
    problem: string,
    kind: string = ALERT_KINDS.startFailed,
  ): Promise<void> {
    const log = this.storeLog(run.owner);
    if (!(await this.holdsLease(run))) {
      log(`${problem}; the lease moved: not retried here`);
      return;
    }
    const now = this.now();
    if (run.startedAt !== undefined && now - run.startedAt >= STABLE_RUN_SECS) {
      run.failedStarts = 0;
      run.retryAttempt = 0;
    }
    run.startedAt = undefined;
    run.failedStarts += 1;
    log(problem);
    if (kind !== ALERT_KINDS.startFailed) {
      await raiseAlert(this.deps.db, run.owner, kind, problem, { now, log });
    }
    if (run.failedStarts >= MAX_FAILED_STARTS) {
      const message = `${run.failedStarts} starts in a row failed; the last: ${problem}`;
      await this.setStatus(run, 'halted', message);
      await raiseAlert(this.deps.db, run.owner, ALERT_KINDS.startFailed, message, { now, log });
    }
    this.scheduleRetry(run);
  }

  private scheduleRetry(run: StoreRun): void {
    if (run.removed || this.closed) {
      return;
    }
    this.clearRetry(run);
    const delayMs = controlBackoffMs(run.retryAttempt);
    run.retryAttempt += 1;
    run.retryTimer = setTimeout(() => {
      run.retryTimer = undefined;
      this.queueStart(run);
    }, delayMs);
  }

  private publicReads(): PublicReadPool {
    return (this.deps.publicReads ?? listeningPool)();
  }

  private async holdsLease(run: StoreRun): Promise<boolean> {
    const rows = await this.deps.db.query(
      `select 1 from leases where owner = $1 and holder = $2 and epoch = $3 and expires_at > $4`,
      [run.owner, this.deps.holder, run.epoch, this.now()],
    );
    return rows.length > 0;
  }

  /**
   * Move the store between `active`, `degraded` and `halted` while this holder
   * holds its lease; never out of another status (`suspending` stays). It
   * becomes `active` only with no open alert left: with one open (raised
   * elsewhere: a setup pass, the publisher) it is `degraded`, the open alerts
   * its reason.
   */
  private async setStatus(
    run: StoreRun,
    status: StoreStatus,
    reason: string | undefined,
  ): Promise<void> {
    await this.deps.db.query(
      `with open as (
         select string_agg(a.kind || ': ' || a.message, '; ' order by a.kind) as reasons
           from alerts a where a.owner = $1 and a.cleared_at is null
       )
       update stores set
         status = case when $2 = 'active' and (select reasons from open) is not null
                       then 'degraded' else $2 end,
         status_reason = case when $2 = 'active' then (select reasons from open) else $3 end
       where owner = $1 and status = any($4::text[])
         and exists (select 1 from leases l where l.owner = $1 and l.holder = $5 and l.epoch = $6)`,
      [run.owner, status, reason ?? null, RUN_STATUSES, this.deps.holder, run.epoch],
    );
  }
}
