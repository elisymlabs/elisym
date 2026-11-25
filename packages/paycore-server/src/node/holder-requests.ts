/**
 * The holder's side of the admin requests (sub-plan steps 12-15): each
 * pending request of a store this holder serves is applied on the store's
 * control queue, oldest first. Every request is applied once: one that
 * changes the ledger is marked `applied` in the same transaction as the
 * fenced save (`appliedRequest`); one that does not is marked after its
 * effect, and its effect is idempotent (a setup pass republishes the same
 * events, a restart restarts, a hand answer already saved is sent again as
 * stored).
 */
import { KIND_PAYTO, KIND_STORE_AUTH } from '@elisym/commerce';
import {
  type HandRequest,
  applyHandAnswer,
  buildHandAnswer,
  planHandAnswer,
} from '@merchant-node/hand';
import { handOutcome, publishHandAnswer } from '@merchant-node/hand-publish';
import { storeAuth } from '@merchant-node/store-node';
import { getPublicKey } from 'nostr-tools/pure';
import * as z from 'zod';
import {
  type AdminRequest,
  getRequest,
  markRequest,
  ownersWithRequests,
  pendingRequests,
  setRequestResult,
  unsentHandAnswers,
} from '../admin/requests';
import { ALERT_KINDS, clearAlert, raiseAlert } from '../alerts';
import type { Db } from '../db/db';
import { type LedgerHandle, RequestNotPending } from '../state/ledger-store';
import { activePayouts, allowedInboxRelays } from './load';
import {
  type SetupPassDeps,
  type SetupPassResult,
  newestCommitted,
  runStoreSetupPass,
} from './setup-pass';
import { controlBackoffMs } from './start-checks';
import { NotServed, type StoreSupervisor } from './supervisor';
import { Suspensions } from './suspension';

/** A setup-type request (setup, owner event) that failed this many times is marked failed. */
export const MAX_SETUP_ATTEMPTS = 5;

export interface HolderRequestsDeps {
  db: Db;
  supervisor: Pick<StoreSupervisor, 'applyControl' | 'leased' | 'recheckOffers'>;
  /** The setup pass's reads, pools and relays (the hand answers publish with the same). */
  setup: SetupPassDeps;
  log?: (message: string) => void;
}

const HandPayloadSchema = z.object({
  key: z.string().min(1).max(512),
  request: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('delivered') }),
    z.object({
      kind: z.literal('refunded'),
      tx: z.string(),
      amount: z.string(),
      asset: z.string().optional(),
    }),
  ]),
});

const RecordPayloadSchema = z.object({ eventId: z.string().min(1) });

/** What a setup pass did, as the request's result. */
function passSummary(result: SetupPassResult): Record<string, unknown> {
  if (result.kind === 'no_payout_list') {
    return { setup: 'no_payout_list' };
  }
  return {
    setup: 'done',
    payoutListOut: result.payoutListOut,
    authorizationOut: result.authorizationOut ?? null,
    listings: result.outcomes.map((outcome) => ({ d: outcome.d, listing: outcome.listing })),
    missedDefaults: result.missedDefaults,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The heal pass the supervisor runs when a start finds offers the committed
 * owner events can fix, or a move still switching: a setup pass, saved
 * through the handle. Whether the switch went out is the supervisor's next
 * check (it heals again while it has not), never an error here.
 */
export function healPass(
  setup: SetupPassDeps,
): (owner: string, handle: LedgerHandle) => Promise<void> {
  return async (owner, handle) => {
    await runStoreSetupPass(setup, owner, handle);
  };
}

/** The request kinds that run a setup pass: one lane, applied in order. */
const SETUP_KINDS: readonly AdminRequest['kind'][] = ['setup', 'record_owner_event'];

/** The committed payout list did not reach a relay: its request stays pending, retried. */
export class PayoutListNotOut extends Error {
  constructor(readonly owner: string) {
    super('the committed payout list reached no relay: retried');
    this.name = 'PayoutListNotOut';
  }
}

/** The draft inbox relays' 10050 reached no default relay: the request stays pending, retried. */
export class InboxRelaysNotOut extends Error {
  constructor(readonly owner: string) {
    super('the inbox list naming the new inbox relays reached no default relay: retried');
    this.name = 'InboxRelaysNotOut';
  }
}

/**
 * The store's latest move did not switch: the profile naming the new owner
 * reached no default relay (its 10133 or 30490 did not). The request stays
 * pending, retried; whatever else went out is saved.
 */
export class MoveSwitchNotOut extends Error {
  constructor(readonly owner: string) {
    super('the profile naming the new owner key reached no default relay: retried');
    this.name = 'MoveSwitchNotOut';
  }
}

/** One store's kicked drains: one runs at a time, and a kick meanwhile runs one more after it. */
interface Kick {
  again: boolean;
  done: Promise<void>;
}

export class HolderRequests {
  readonly suspensions: Suspensions;
  /** Per store: one drain at a time (answers sent again and pending requests together). */
  private readonly drains = new Map<string, Promise<unknown>>();
  /** Per store: the drains the pump kicked, each store on its own (one never waits for another). */
  private readonly kicks = new Map<string, Kick>();
  /** The suspension rounds and offer checks ticks started and that still run (`idle` waits for all). */
  private readonly ticking = new Set<Promise<void>>();
  /** Failed attempts of setup-kind requests and when the next is due, by request id (this process only). */
  private readonly attempts = new Map<string, { count: number; nextAt: number }>();

  constructor(private readonly deps: HolderRequestsDeps) {
    this.suspensions = new Suspensions({
      db: deps.db,
      supervisor: deps.supervisor,
      setup: deps.setup,
      now: deps.setup.now,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  /**
   * The pump's periodic round, started and not awaited (a store whose control
   * task runs long holds only its own queue): the suspension clocks (one round
   * at a time), and the drift and offer checks of running stores, each queued
   * on its own store's control queue (each at most every `DRIFT_CHECK_SECS`).
   */
  tick(): Promise<void> {
    // Suspensions skips a store whose earlier round still runs, so a hung store
    // never holds another store's round.
    this.background('suspension round', this.suspensions.tick());
    this.background('offer checks', this.deps.supervisor.recheckOffers());
    return Promise.resolve();
  }

  /** Track `work` until it settles, its error logged: what a tick starts and does not await. */
  private background(what: string, work: Promise<unknown>): void {
    const tracked = work.then(
      () => undefined,
      (error: unknown) => {
        (this.deps.log ?? ((line: string) => console.error(line)))(
          `${what} failed: ${errorText(error)}`,
        );
      },
    );
    this.ticking.add(tracked);
    void tracked.then(() => {
      this.ticking.delete(tracked);
    });
  }

  /**
   * Start a drain of every store this holder serves that has work queued, each
   * on its own (`kick`); resolves once they are started, not done, so a store
   * whose control task runs long never holds another's requests. `drained`
   * settles once the drains started here are done (it never rejects).
   */
  async kickAll(): Promise<{ drained: Promise<void> }> {
    const kicks = await this.kickOwners();
    return { drained: Promise.all(kicks).then(() => undefined) };
  }

  /** Drain every store this holder serves that has work queued, and wait for them. Errors are logged per store. */
  async drainAll(): Promise<void> {
    await Promise.all(await this.kickOwners());
  }

  /**
   * Resolves once every kicked drain, suspension round and offer check in
   * progress is done, including any started while it waits (tests, shutdown).
   */
  async idle(): Promise<void> {
    for (;;) {
      const waits = [...[...this.kicks.values()].map((kick) => kick.done), ...this.ticking];
      if (waits.length === 0) {
        return;
      }
      await Promise.all(waits);
    }
  }

  /**
   * Drain `owner` now, or once more right after its drain in progress (kicks
   * meanwhile fold into that one). Never rejects: errors are logged.
   */
  kick(owner: string): Promise<void> {
    const known = this.kicks.get(owner);
    if (known !== undefined) {
      known.again = true;
      return known.done;
    }
    const kick: Kick = { again: true, done: Promise.resolve() };
    this.kicks.set(owner, kick);
    kick.done = this.runKicks(owner, kick);
    return kick.done;
  }

  private async kickOwners(): Promise<Promise<void>[]> {
    const owners = await ownersWithRequests(this.deps.db, this.deps.supervisor.leased);
    return owners.map((owner) => this.kick(owner));
  }

  private async runKicks(owner: string, kick: Kick): Promise<void> {
    try {
      while (kick.again) {
        kick.again = false;
        try {
          await this.drain(owner);
        } catch (error) {
          if (!(error instanceof NotServed)) {
            this.log(owner, `requests: ${errorText(error)}`);
          }
        }
      }
    } finally {
      this.kicks.delete(owner);
    }
  }

  /**
   * One store's queue: first the hand answers saved and never sent (sent
   * again as stored), then the pending requests oldest first, in two lanes:
   * the setup kinds (`setup`, `record_owner_event`) and the others. A
   * request that throws, or a setup-kind one waiting for its backoff, holds
   * the later requests of its own lane only (it stays pending, retried on a
   * later drain); a failing setup never blocks a hand answer, a restart or a
   * suspension. The first error is rethrown once the drain is done. Resolves
   * to the ids applied or sent.
   */
  drain(owner: string): Promise<string[]> {
    const previous = this.drains.get(owner) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const resent: string[] = [];
        for (const request of await unsentHandAnswers(this.deps.db, owner)) {
          if (await this.sendHandAgain(request)) {
            resent.push(request.id);
          }
        }
        const applied = await this.drainPending(owner);
        return [...resent, ...applied];
      });
    this.drains.set(owner, run);
    const cleanup = () => {
      if (this.drains.get(owner) === run) {
        this.drains.delete(owner);
      }
    };
    run.then(cleanup, cleanup);
    return run;
  }

  private async drainPending(owner: string): Promise<string[]> {
    const { db } = this.deps;
    const handed: string[] = [];
    const held = new Set<boolean>();
    let failure: { error: unknown } | undefined;
    for (const request of await pendingRequests(db, owner)) {
      const setupLane = SETUP_KINDS.includes(request.kind);
      if (held.has(setupLane)) {
        continue;
      }
      const current = await getRequest(db, owner, request.id);
      if (current?.state !== 'pending') {
        continue;
      }
      if (setupLane && (this.attempts.get(current.id)?.nextAt ?? 0) > this.now()) {
        held.add(setupLane);
        continue;
      }
      try {
        await this.apply(current);
        handed.push(current.id);
      } catch (error) {
        if (error instanceof NotServed) {
          throw error;
        }
        held.add(setupLane);
        failure ??= { error };
      }
    }
    if (failure !== undefined) {
      throw failure.error;
    }
    return handed;
  }

  private log(owner: string, message: string): void {
    (this.deps.log ?? ((line: string) => console.error(line)))(
      `store ${owner.slice(0, 12)}: ${message}`,
    );
  }

  private now(): number {
    return this.deps.setup.now();
  }

  private async apply(request: AdminRequest): Promise<void> {
    switch (request.kind) {
      case 'setup':
        return this.retried(request, () => this.applySetup(request));
      case 'record_owner_event':
        return this.retried(request, () => this.applyRecord(request));
      case 'restart':
        return this.applyRestart(request);
      case 'hand_answer':
        return this.applyHand(request);
      case 'suspend':
        return this.notPendingIsDone(() =>
          this.suspensions.applyRequest(request.owner, request.id),
        );
    }
  }

  /** A request another drain marked meanwhile was applied there: nothing to do here. */
  private async notPendingIsDone(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof RequestNotPending)) {
        throw error;
      }
    }
  }

  /**
   * Run a setup-kind request; a failure keeps it pending, retried after
   * `controlBackoffMs` (its lane waits meanwhile), until `MAX_SETUP_ATTEMPTS`,
   * then marks it failed with an alert. A store not served here is never counted.
   */
  private async retried(request: AdminRequest, work: () => Promise<void>): Promise<void> {
    try {
      await this.notPendingIsDone(work);
      this.attempts.delete(request.id);
    } catch (error) {
      if (error instanceof NotServed) {
        throw error;
      }
      const attempts = (this.attempts.get(request.id)?.count ?? 0) + 1;
      const problem = errorText(error);
      if (attempts < MAX_SETUP_ATTEMPTS) {
        const waitSecs = Math.ceil(controlBackoffMs(attempts - 1) / 1000);
        this.attempts.set(request.id, { count: attempts, nextAt: this.now() + waitSecs });
        throw error;
      }
      this.attempts.delete(request.id);
      const now = this.now();
      await markRequest(this.deps.db, request.owner, request.id, 'failed', now, { problem });
      await raiseAlert(
        this.deps.db,
        request.owner,
        ALERT_KINDS.setupFailed,
        `${request.kind} failed ${attempts} times: ${problem}${setupRemedy(problem)}`,
        { now, log: (line) => this.log(request.owner, line) },
      );
    }
  }

  /**
   * A setup pass for edits of a running store (config, products) or its
   * activation. Every other setup request pending before the pass read the
   * rows is covered by it and marked applied too.
   */
  private async applySetup(request: AdminRequest): Promise<void> {
    const { db } = this.deps;
    const covered = await db.query<{ id: string }>(
      `select id from admin_requests where owner = $1 and kind = 'setup' and state = 'pending'
         and id <> $2`,
      [request.owner, request.id],
    );
    await this.passFor(request);
    const now = this.now();
    for (const other of covered) {
      await markRequest(db, request.owner, other.id, 'applied', now, { coveredBy: request.id });
    }
  }

  /**
   * A setup pass marking `request` applied in its save; marked after when
   * nothing could be published. A committed payout list that is still not
   * out leaves the request pending (`PayoutListNotOut`, retried with backoff),
   * and so does a relay edit whose 10050 reached no default relay
   * (`InboxRelaysNotOut`) and a move whose new-owner profile did not go out
   * (`MoveSwitchNotOut`): whatever else went out is saved.
   */
  private async passFor(request: AdminRequest): Promise<SetupPassResult> {
    const { db } = this.deps;
    const result = await this.deps.supervisor.applyControl(request.owner, (handle) =>
      runStoreSetupPass(this.deps.setup, request.owner, handle, { appliedRequest: request.id }),
    );
    if (result.kind === 'done' && result.payoutListPending) {
      throw new PayoutListNotOut(request.owner);
    }
    if (result.kind === 'done' && result.inboxRelaysPending) {
      throw new InboxRelaysNotOut(request.owner);
    }
    if (result.kind === 'done' && result.moveSwitchPending) {
      throw new MoveSwitchNotOut(request.owner);
    }
    const now = this.now();
    if (result.kind === 'no_payout_list') {
      await markRequest(db, request.owner, request.id, 'applied', now, passSummary(result));
    } else {
      await setRequestResult(db, request.owner, request.id, passSummary(result));
    }
    await clearAlert(db, request.owner, ALERT_KINDS.setupFailed, { now });
    return result;
  }

  /**
   * Record and publish a committed owner event: a setup pass with the newest
   * committed events. An event already recorded, or replaced by a newer one
   * of its kind, needs no pass (the newer one's own request publishes it).
   */
  private async applyRecord(request: AdminRequest): Promise<void> {
    const { db } = this.deps;
    const now = this.now();
    const parsed = RecordPayloadSchema.safeParse(request.payload);
    const [row] = parsed.success
      ? await db.query<{ kind: number; recorded: boolean }>(
          'select kind, recorded from owner_events where id = $1 and owner = $2',
          [parsed.data.eventId, request.owner],
        )
      : [];
    if (!parsed.success || row === undefined) {
      await markRequest(db, request.owner, request.id, 'failed', now, {
        problem: 'no such owner event',
      });
      return;
    }
    if (row.recorded) {
      await markRequest(db, request.owner, request.id, 'applied', now, { recorded: true });
      return;
    }
    const kind = row.kind === KIND_PAYTO ? KIND_PAYTO : KIND_STORE_AUTH;
    const newest = await newestCommitted(db, request.owner, kind);
    if (newest !== undefined && newest.id !== parsed.data.eventId) {
      await markRequest(db, request.owner, request.id, 'applied', now, {
        recorded: false,
        replacedBy: newest.id,
      });
      return;
    }
    await this.passFor(request);
  }

  /** Restart the node (a new webhook secret, ...): the restart is the effect, marked after it. */
  private async applyRestart(request: AdminRequest): Promise<void> {
    await this.deps.supervisor.applyControl(request.owner, async () => undefined);
    await markRequest(this.deps.db, request.owner, request.id, 'applied', this.now(), {
      restarted: true,
    });
  }

  /**
   * A hand answer (step 14): judged on a fresh handle; a new one closes the
   * order and is saved (marking the request) before it is published; one
   * already answered is sent again as stored and marked after. The delivery
   * outcome is the request's result: a crash after the save leaves none, and
   * the next drain sends it again (`sendHandAgain`).
   */
  private async applyHand(request: AdminRequest): Promise<void> {
    const { db } = this.deps;
    const parsed = HandPayloadSchema.safeParse(request.payload);
    if (!parsed.success) {
      await markRequest(db, request.owner, request.id, 'failed', this.now(), {
        problem: 'not a hand answer',
      });
      return;
    }
    const { key } = parsed.data;
    await this.notPendingIsDone(() =>
      this.deps.supervisor.applyControl(request.owner, async (handle) => {
        const plan = planHandAnswer(handle.state, key, this.handRequest(handle, parsed.data));
        if (!plan.ok) {
          await markRequest(db, request.owner, request.id, 'failed', this.now(), {
            problem: plan.problem,
          });
          return;
        }
        if (!plan.rerun) {
          applyHandAnswer(handle.state, key, plan.answer);
          await handle.save(handle.state, { appliedRequest: request.id });
        }
        const outcome = await this.publishHand(request.owner, plan);
        if (plan.rerun) {
          await markRequest(db, request.owner, request.id, 'applied', this.now(), outcome);
        } else {
          await setRequestResult(db, request.owner, request.id, outcome);
        }
      }),
    );
  }

  /**
   * Send a saved hand answer whose outcome was never written, as stored; true
   * when it was sent. One send only: a send that throws writes
   * `{ done: false, problem }` (the admin offers to send it again), so it
   * neither holds the pending requests nor restarts the node on every drain.
   */
  private async sendHandAgain(request: AdminRequest): Promise<boolean> {
    const { db } = this.deps;
    const parsed = HandPayloadSchema.safeParse(request.payload);
    if (!parsed.success) {
      await setRequestResult(db, request.owner, request.id, { problem: 'not a hand answer' });
      return false;
    }
    try {
      await this.deps.supervisor.applyControl(request.owner, async (handle) => {
        const plan = planHandAnswer(
          handle.state,
          parsed.data.key,
          this.handRequest(handle, parsed.data),
        );
        const outcome = plan.ok
          ? await this.publishHand(request.owner, plan)
          : { done: false, problem: plan.problem };
        await setRequestResult(db, request.owner, request.id, outcome);
      });
      return true;
    } catch (error) {
      if (error instanceof NotServed) {
        throw error;
      }
      const problem = errorText(error);
      this.log(request.owner, `the hand answer ${request.id} was not sent again: ${problem}`);
      try {
        await setRequestResult(db, request.owner, request.id, { done: false, problem });
      } catch (writeError) {
        this.log(request.owner, `its outcome was not written: ${errorText(writeError)}`);
      }
      return false;
    }
  }

  private handRequest(
    handle: LedgerHandle,
    payload: z.infer<typeof HandPayloadSchema>,
  ): HandRequest {
    if (payload.request.kind === 'delivered') {
      return { kind: 'delivered' };
    }
    return {
      kind: 'refunded',
      tx: payload.request.tx,
      amount: payload.request.amount,
      ...(payload.request.asset === undefined ? {} : { asset: payload.request.asset }),
      payoutAssets: activePayouts(handle.state, handle.owner).map((payout) => payout.caip19),
    };
  }

  /** Publish a hand answer to the store's inbox relays; the outcome the admin shows. */
  private async publishHand(
    owner: string,
    plan: Extract<ReturnType<typeof planHandAnswer>, { ok: true }>,
  ): Promise<Record<string, unknown>> {
    const { setup } = this.deps;
    const store = await storeKeyAndRelays(setup, owner);
    const wrap = buildHandAnswer(plan, store.secretKey, setup.now());
    const pool = setup.pools.open(store.pubkey);
    try {
      const sent = await publishHandAnswer(
        pool,
        store.inboxRelays,
        wrap,
        storeAuth(store.secretKey),
        (line) => this.log(owner, line),
      );
      const outcome = handOutcome(sent, store.inboxRelays.length);
      return {
        done: outcome.done,
        rerun: plan.rerun,
        taken: sent.taken.length,
        copyTaken: sent.copyTaken.length,
        relays: store.inboxRelays.length,
      };
    } finally {
      setup.pools.close(store.pubkey);
    }
  }
}

/**
 * What the operator alert adds to a setup failure it can name the remedy of:
 * a committed payout list the relays would not serve (a newer or same-second
 * one is out there, R1 drift) is fixed only by the owner signing a new one.
 */
function setupRemedy(problem: string): string {
  return problem.includes('the signed payout list')
    ? '. Remedy: the owner re-signs the payout list in the admin (prepare, sign and commit a new one, dated after the one the relays serve)'
    : '';
}

/** The store key, opened, and the allowlisted inbox relays: what a hand answer is published with. */
async function storeKeyAndRelays(
  setup: Pick<SetupPassDeps, 'db' | 'vault' | 'inboxRelayAllowlist'>,
  owner: string,
): Promise<{ secretKey: Uint8Array; pubkey: string; inboxRelays: string[] }> {
  const [row] = await setup.db.query<{
    store_pubkey: string;
    store_key: Uint8Array | null;
    inbox_relays: string[] | null;
  }>(
    `select s.store_pubkey, k.store_key, c.inbox_relays from stores s
     left join store_keys k on k.owner = s.owner left join store_config c on c.owner = s.owner
     where s.owner = $1`,
    [owner],
  );
  if (row === undefined || row.store_key === null || row.inbox_relays === null) {
    throw new Error(`the store ${owner} has no key or no inbox relays`);
  }
  const secretKey = setup.vault.open(row.store_key, owner, 'store');
  if (getPublicKey(secretKey) !== row.store_pubkey) {
    throw new Error('the sealed store key is not the store pubkey');
  }
  return {
    secretKey,
    pubkey: row.store_pubkey,
    inboxRelays: allowedInboxRelays(owner, row.inbox_relays, setup.inboxRelayAllowlist),
  };
}
