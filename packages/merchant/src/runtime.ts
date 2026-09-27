import { MAX_FUTURE_SKEW_SECS, unwrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { MAX_LIVE_CHECKS_PER_MINUTE } from './constants';
import { type StoreIdentity, intake } from './intake';
import {
  type LedgerState,
  type MerchantOrder,
  pruneExpiredOrders,
  undeliveredOrders,
} from './ledger';
import { SeenWraps, readSince, resumePointAfterSweep } from './listener';
import {
  type CatchUpResult,
  type PaymentCheck,
  type SolanaContext,
  catchUp,
  checkPayment,
} from './solana';

export interface RuntimeDeps {
  state: LedgerState;
  store: StoreIdentity;
  storeSecretKey: Uint8Array;
  context: SolanaContext;
  /** Write the ledger to disk. */
  save: () => void;
  /** Publish the delivery of one paid order; true when a relay took it. */
  deliver: (order: MerchantOrder) => Promise<boolean>;
  log: (message: string) => void;
  now: () => number;
  /** Replaceable in tests. */
  checkPayment?: typeof checkPayment;
  catchUp?: (state: LedgerState, context: SolanaContext, now: number) => Promise<CatchUpResult>;
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
    const { state, store, storeSecretKey, context, save, log } = this.deps;
    const unwrapped = unwrapOrderMessage(wrap, storeSecretKey);
    if (unwrapped === undefined) {
      return;
    }
    const result = intake(state, unwrapped, store, this.deps.now());
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
    if (
      !result.isNew ||
      result.order.refusedTxs?.includes(result.tx) === true ||
      !this.takeLiveCheck()
    ) {
      return;
    }
    const check: PaymentCheck = await this.check(state, result.order, result.tx, context);
    log(`receipt ${result.order.key} ${result.tx}: ${check.kind}`);
    if (check.kind === 'refused') {
      result.order.refusedTxs = [...(result.order.refusedTxs ?? []), result.tx];
    }
    save();
    if (check.kind === 'paid') {
      await this.deliverPending();
    }
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
    try {
      const result = await this.sweepCatchUp(state, context, now());
      if (result.paid.length > 0) {
        log(`catch-up found ${result.paid.length} payment(s)`);
      }
      for (const account of result.incomplete) {
        log(`warning: the history of ${account} was cut short; older payments may be missed`);
      }
    } finally {
      // Saved before anything is sent, even when the chain could not be read this
      // time: a claim made before the error is on disk before its delivery.
      save();
      await this.deliverPending();
    }
  }

  /** Deliver every paid order not yet delivered; each is marked and saved once a relay took it. */
  async deliverPending(): Promise<void> {
    const { state, save, log, now } = this.deps;
    for (const order of undeliveredOrders(state)) {
      if (!(await this.deps.deliver(order))) {
        log(`delivery for ${order.key} not accepted by any relay; will retry`);
        continue;
      }
      order.deliveredAt = now();
      save();
      log(`delivered ${order.key} (${order.paid?.signature ?? ''})`);
    }
  }
}
