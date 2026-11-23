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
  drainRequests,
  markRequest,
  ownersWithRequests,
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
import { NotServed, type StoreSupervisor } from './supervisor';
import { Suspensions } from './suspension';

/** A setup-type request (setup, owner event) that failed this many times is marked failed. */
export const MAX_SETUP_ATTEMPTS = 5;

export interface HolderRequestsDeps {
  db: Db;
  supervisor: Pick<StoreSupervisor, 'applyControl' | 'leased'>;
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
 * owner events can fix: a setup pass, saved through the handle.
 */
export function healPass(
  setup: SetupPassDeps,
): (owner: string, handle: LedgerHandle) => Promise<void> {
  return async (owner, handle) => {
    await runStoreSetupPass(setup, owner, handle);
  };
}

export class HolderRequests {
  readonly suspensions: Suspensions;
  /** Per store: one drain at a time (answers sent again and pending requests together). */
  private readonly drains = new Map<string, Promise<unknown>>();
  /** Failed attempts of setup-type requests, by request id (this process only). */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: HolderRequestsDeps) {
    this.suspensions = new Suspensions({
      db: deps.db,
      supervisor: deps.supervisor,
      setup: deps.setup,
      now: deps.setup.now,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  /** Drain every store this holder serves that has work queued. Errors are logged per store. */
  async drainAll(): Promise<void> {
    const owners = await ownersWithRequests(this.deps.db, this.deps.supervisor.leased);
    await Promise.all(
      owners.map((owner) =>
        this.drain(owner).catch((error: unknown) => {
          if (!(error instanceof NotServed)) {
            this.log(owner, `requests: ${errorText(error)}`);
          }
        }),
      ),
    );
  }

  /**
   * One store's queue: first the hand answers saved and never sent (sent
   * again as stored), then the pending requests oldest first. A request that
   * throws stops the drain there (it stays pending, retried on the next one).
   * Resolves to the ids applied or sent.
   */
  drain(owner: string): Promise<string[]> {
    const previous = this.drains.get(owner) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const resent: string[] = [];
        for (const request of await unsentHandAnswers(this.deps.db, owner)) {
          await this.sendHandAgain(request);
          resent.push(request.id);
        }
        const applied = await drainRequests(this.deps.db, owner, (request) => this.apply(request));
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

  /**
   * Run the setup pass of a store now (its activation, or by hand): on its
   * control queue, saved through a fresh handle.
   */
  activateStore(owner: string): Promise<SetupPassResult> {
    return this.deps.supervisor.applyControl(owner, (handle) =>
      runStoreSetupPass(this.deps.setup, owner, handle),
    );
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
   * Run a setup-type request; a failure keeps it pending (the drain stops,
   * the next one retries) until `MAX_SETUP_ATTEMPTS`, then marks it failed
   * with an alert. A store not served here is never counted.
   */
  private async retried(request: AdminRequest, work: () => Promise<void>): Promise<void> {
    try {
      await this.notPendingIsDone(work);
      this.attempts.delete(request.id);
    } catch (error) {
      if (error instanceof NotServed) {
        throw error;
      }
      const attempts = (this.attempts.get(request.id) ?? 0) + 1;
      this.attempts.set(request.id, attempts);
      const problem = errorText(error);
      if (attempts < MAX_SETUP_ATTEMPTS) {
        throw error;
      }
      this.attempts.delete(request.id);
      const now = this.now();
      await markRequest(this.deps.db, request.owner, request.id, 'failed', now, { problem });
      await raiseAlert(
        this.deps.db,
        request.owner,
        ALERT_KINDS.setupFailed,
        `${request.kind} failed ${attempts} times: ${problem}`,
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

  /** A setup pass marking `request` applied in its save; marked after when nothing could be published. */
  private async passFor(request: AdminRequest): Promise<SetupPassResult> {
    const { db } = this.deps;
    const result = await this.deps.supervisor.applyControl(request.owner, (handle) =>
      runStoreSetupPass(this.deps.setup, request.owner, handle, { appliedRequest: request.id }),
    );
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

  /** Send a saved hand answer whose outcome was never written, as stored. */
  private async sendHandAgain(request: AdminRequest): Promise<void> {
    const { db } = this.deps;
    const parsed = HandPayloadSchema.safeParse(request.payload);
    if (!parsed.success) {
      await setRequestResult(db, request.owner, request.id, { problem: 'not a hand answer' });
      return;
    }
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
