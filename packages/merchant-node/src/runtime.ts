import { MAX_FUTURE_SKEW_SECS, unwrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import {
  ASK_AGAIN_DELAYS_MS,
  MAX_LIVE_CHECKS_PER_MINUTE,
  MAX_REPEATS_IN_FLIGHT,
  RESEND_EVERY_SECS,
} from './constants';
import { type StoreIdentity, intake } from './intake';
import {
  type LedgerState,
  type MerchantOrder,
  pruneExpiredOrders,
  undeliveredOrders,
} from './ledger';
import { SeenWraps, readSince, resumePointAfterSweep } from './listener';
import { TEMPO_HASH_RE, orderKey } from './order-rules';
import { deliveryDone } from './reply';
import type { SelfCopies } from './self-copies';
import {
  type CatchUpResult,
  type PaymentCheck,
  type SolanaContext,
  catchUp,
  checkPayment,
} from './solana';
import {
  type TempoCheck,
  type TempoContext,
  catchUpTempo,
  checkTempoPayment,
  recordTempoCheck,
} from './tempo';

/** One attempt to send the completed status: the relays that took it now, and the store's own copy. */
export interface DeliveryAttempt {
  taken: string[];
  selfWrap: NostrEvent;
}

export interface RuntimeDeps {
  state: LedgerState;
  store: StoreIdentity;
  storeSecretKey: Uint8Array;
  context: SolanaContext;
  /** Write the ledger to disk. */
  save: () => void;
  /**
   * Publish the completed status of one paid order to the store's inbox relays, except
   * `skip` (they took it already); resolves to the relays that took it now and
   * the store's own copy of the reply (published separately, see `selfCopies`).
   */
  deliver: (order: MerchantOrder, skip: readonly string[]) => Promise<DeliveryAttempt>;
  /**
   * Where the store's copy of a completed status goes, once per order: on the
   * attempt that completes it. Without it no copy is published.
   */
  selfCopies?: SelfCopies;
  /** How many inbox relays the store has: a delivery wants two of them (see `deliveryDone`). */
  inboxRelayCount: number;
  log: (message: string) => void;
  now: () => number;
  /**
   * Run `task` on the merchant's queue after `ms`: a reported transaction the
   * RPC does not see yet is checked again soon. Without it, only sweeps do.
   */
  later?: (ms: number, task: () => Promise<void>) => void;
  /** Replaceable in tests. */
  checkPayment?: typeof checkPayment;
  catchUp?: (state: LedgerState, context: SolanaContext, now: number) => Promise<CatchUpResult>;
  /** Present when the store takes Tempo payouts (the `tempo` config block). */
  tempo?: TempoContext;
  checkTempoPayment?: typeof checkTempoPayment;
  catchUpTempo?: typeof catchUpTempo;
}

/** A reported transaction this order has already judged: never checked again. */
function settled(order: MerchantOrder, tx: string): boolean {
  return (
    order.refusedTxs?.includes(tx) === true ||
    order.noLegTxs?.includes(tx) === true ||
    order.blockedTx === tx
  );
}

/**
 * What the running merchant does with each wrap and on each sweep. The caller
 * runs every task on ONE queue, so ledger changes happen in order; every change
 * is saved before anything is sent.
 */
export class MerchantRuntime {
  readonly seenWraps = new SeenWraps();
  private readonly check: typeof checkPayment;
  /** Live checks in the current minute: `[minute, count]`. */
  private liveChecks: [number, number] = [0, 0];
  private readonly sweepCatchUp: NonNullable<RuntimeDeps['catchUp']>;
  /** When each delivered order's status was last sent again (this run only). */
  private readonly resentAt = new Map<string, number>();
  private repeatsInFlight = 0;

  constructor(private readonly deps: RuntimeDeps) {
    this.check = deps.checkPayment ?? checkPayment;
    this.sweepCatchUp = deps.catchUp ?? catchUp;
  }

  /**
   * Whether a wrap goes on the queue: not one dated further ahead than any
   * genuine wrap can be (NIP-59 only back-dates; nothing would ever prune it),
   * and not one already handed on (the live burst overlapping the backfill, a
   * reconnect re-reading its window).
   */
  admit(wrap: NostrEvent): boolean {
    if (wrap.created_at > this.deps.now() + MAX_FUTURE_SKEW_SECS) {
      return false;
    }
    return this.seenWraps.admit(wrap);
  }

  /** Take one wrap in: an order is recorded; a receipt's transaction is checked. */
  async handleWrap(wrap: NostrEvent): Promise<void> {
    const { state, store, storeSecretKey, save, log } = this.deps;
    const unwrapped = unwrapOrderMessage(wrap, storeSecretKey);
    if (unwrapped === undefined) {
      return;
    }
    const result = intake(state, unwrapped, store, this.deps.now());
    // Read again for an order already delivered: the buyer may never have got it.
    const { message } = unwrapped;
    const again =
      (result.kind === 'ignored' && result.reason === 'seen') || result.kind === 'receipt';
    if (again && (message.type === 'order' || message.type === 'receipt')) {
      const known = state.orders[orderKey(unwrapped.senderPubkey, message.orderId)];
      if (known?.deliveredAt !== undefined && message.storePubkey === store.storePubkey) {
        if (result.kind === 'receipt') {
          save();
        }
        this.resend(known);
        return;
      }
    }
    if (result.kind === 'ignored') {
      // A receipt that came before its order is read again when it is re-sent
      // or re-read, once the order is in.
      if (result.reason === 'unknown_order') {
        this.seenWraps.forget(wrap.id);
      }
      return;
    }
    save();
    if (result.kind === 'order') {
      log(`order ${result.order.key}`);
      return;
    }
    // Only a transaction the order reports for the first time is checked at once,
    // and only within a per-minute budget: orders and receipts are free to send,
    // so the rest wait for the sweep's bounded recheck.
    if (!result.isNew || settled(result.order, result.tx) || !this.takeLiveCheck()) {
      return;
    }
    await this.checkReported(result.order, result.tx, 0);
  }

  /** Check one reported transaction now; one the RPC does not see yet is tried again soon. */
  private async checkReported(order: MerchantOrder, tx: string, attempt: number): Promise<void> {
    const { state, context, save, log } = this.deps;
    let check: PaymentCheck | TempoCheck;
    // Dispatched by the transaction's format: a 0x hash is Tempo's.
    if (TEMPO_HASH_RE.test(tx)) {
      if (this.deps.tempo === undefined) {
        log(`receipt ${order.key} ${tx}: a Tempo payment, and this node has no tempo block`);
        return;
      }
      check = await (this.deps.checkTempoPayment ?? checkTempoPayment)(
        state,
        order,
        tx,
        this.deps.tempo,
      );
      recordTempoCheck(order, tx, check);
    } else {
      check = await this.check(state, order, tx, context);
      if (check.kind === 'refused') {
        order.refusedTxs = [...(order.refusedTxs ?? []), tx];
      }
    }
    log(`receipt ${order.key} ${tx}: ${check.kind}`);
    save();
    if (check.kind === 'paid') {
      await this.deliverPending();
    } else if (check.kind === 'ask_again') {
      this.askAgain(order.key, tx, attempt);
    }
  }

  private askAgain(key: string, tx: string, attempt: number): void {
    const delay = ASK_AGAIN_DELAYS_MS[attempt];
    if (delay === undefined || this.deps.later === undefined) {
      return;
    }
    this.deps.later(delay, async () => {
      // Still the same unpaid order (not pruned, not recreated), the transaction
      // not refused meanwhile, and within the live budget - else the sweep has it.
      const order = this.deps.state.orders[key];
      if (
        order === undefined ||
        order.paid !== undefined ||
        !order.reportedTxs.includes(tx) ||
        settled(order, tx) ||
        !this.takeLiveCheck()
      ) {
        return;
      }
      await this.checkReported(order, tx, attempt + 1);
    });
  }

  /**
   * Send a delivered order's status again, at most every `RESEND_EVERY_SECS`,
   * off the queue (it changes no ledger state) and a few at a time: one skipped
   * now is sent when the order is read again.
   */
  private resend(order: MerchantOrder): void {
    const now = this.deps.now();
    const last = this.resentAt.get(order.key);
    if (
      (last !== undefined && now - last < RESEND_EVERY_SECS) ||
      this.repeatsInFlight >= MAX_REPEATS_IN_FLIGHT
    ) {
      return;
    }
    this.resentAt.set(order.key, now);
    this.repeatsInFlight += 1;
    const { deliver, log } = this.deps;
    void deliver(order, [])
      .then(({ taken }) => {
        log(`completion for ${order.key} sent again: taken by ${taken.length}`);
      })
      .catch((error: unknown) => {
        log(`completion for ${order.key} not sent again: ${String(error)}`);
      })
      .finally(() => {
        this.repeatsInFlight -= 1;
      });
  }

  private takeLiveCheck(): boolean {
    const minute = Math.floor(this.deps.now() / 60);
    const [current, count] = this.liveChecks;
    const used = current === minute ? count : 0;
    if (used >= MAX_LIVE_CHECKS_PER_MINUTE) {
      return false;
    }
    this.liveChecks = [minute, used + 1];
    return true;
  }

  /** One catch-up sweep; `allLive` and `queuedAt` were taken when it was queued. */
  async sweep(allLive: boolean, queuedAt: number): Promise<void> {
    const { state, context, save, log, now } = this.deps;
    state.resumeAt = resumePointAfterSweep(allLive, queuedAt, state.resumeAt);
    pruneExpiredOrders(state, now());
    this.seenWraps.prune(readSince(now()));
    for (const [key, at] of this.resentAt) {
      if (now() - at >= RESEND_EVERY_SECS) {
        this.resentAt.delete(key);
      }
    }
    try {
      // Each rail on its own: one rail's RPC failing never stops the other's catch-up.
      const tempo = this.deps.tempo;
      const rails: { rail: string; run: () => Promise<CatchUpResult> }[] = [
        { rail: 'solana', run: () => this.sweepCatchUp(state, context, now()) },
      ];
      if (tempo !== undefined) {
        rails.push({
          rail: 'tempo',
          run: () => (this.deps.catchUpTempo ?? catchUpTempo)(state, tempo, now()),
        });
      }
      const results: CatchUpResult[] = [];
      for (const { rail, run } of rails) {
        try {
          results.push(await run());
        } catch (error) {
          log(
            `${rail} catch-up failed this time: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      for (const result of results) {
        if (result.paid.length > 0) {
          log(`catch-up found ${result.paid.length} payment(s)`);
        }
        for (const account of result.incomplete) {
          log(`warning: the history of ${account} was cut short; older payments may be missed`);
        }
      }
    } finally {
      // Saved before anything is sent, even when the chain could not be read this
      // time: a claim made before the error is on disk before its delivery.
      save();
      await this.deliverPending();
    }
  }

  /**
   * Deliver every paid order not yet delivered, all at once (a hung relay costs
   * one deadline, not one per order), each only to the relays that have not
   * taken it yet (the buyer gets no pile of copies while one relay is down).
   * An order counts as delivered per `deliveryDone`, and it is saved.
   */
  async deliverPending(): Promise<void> {
    const { state, save, log, now, deliver, inboxRelayCount } = this.deps;
    const pending = undeliveredOrders(state);
    if (pending.length === 0) {
      return;
    }
    const selfCopies = this.deps.selfCopies;
    // Copies wait while buyer deliveries go out: they share the relays' rate limits.
    selfCopies?.pause();
    let attempts: (DeliveryAttempt | undefined)[];
    try {
      attempts = await Promise.all(
        pending.map((order) => deliver(order, order.deliveredTo ?? []).catch(() => undefined)),
      );
    } finally {
      selfCopies?.resume();
    }
    const at = now();
    let changed = false;
    pending.forEach((order, index) => {
      const attempt = attempts[index];
      const fresh = (attempt?.taken ?? []).filter(
        (relay) => !(order.deliveredTo ?? []).includes(relay),
      );
      if (fresh.length > 0) {
        changed = true;
        order.deliveredTo = [...(order.deliveredTo ?? []), ...fresh];
      }
      const paidAge = at - (order.paid?.blockTime ?? at);
      if (deliveryDone(order.deliveredTo?.length ?? 0, inboxRelayCount, paidAge)) {
        changed = true;
        order.deliveredAt = at;
        log(`completed ${order.key} (${order.paid?.signature ?? ''})`);
        // One copy per order, of the attempt that made it delivered. Published
        // after the save below by the copy queue, which never blocks this one.
        if (attempt === undefined) {
          log(`copy for ${order.key} not made: the completed status could not be built`);
        } else {
          selfCopies?.add(attempt.selfWrap, order.key);
        }
      } else {
        log(`completion for ${order.key} taken by ${order.deliveredTo?.length ?? 0}; will retry`);
      }
    });
    if (changed) {
      save();
    }
  }
}
