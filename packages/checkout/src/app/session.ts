import type { OfferWarning } from '@elisym/commerce';
import { type LoadedOffer, type PricedPayout, isSnapshotStale } from '@elisym/commerce/buyer';
import {
  type OrderDeps,
  applyStatus,
  clockAgrees,
  compareOffers,
  deliveryLink,
  listenForStatus,
  placeOrder,
  resumeOrder,
} from '@elisym/commerce/buyer';
import { type OrderRecord, isTerminal, recordToShow } from '@elisym/commerce/buyer';
import type { OrderStore } from '@elisym/commerce/buyer';
import {
  type SolanaPayResult,
  type SolanaWallet,
  composeOrderPayment,
  endSolanaOrder,
  payWithSolana,
  retryWithSolana,
  watchSolanaPayment,
} from '@elisym/commerce/buyer';
import type { Asset, Network } from '@elisym/pay-core';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import type { CheckoutState } from '../embed/protocol';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

/** How often a live attempt is reconciled against the chain. */
export const WATCH_EVERY_MS = 5_000;
/** How often the signed order and receipt are published again while no status came. */
export const REPUBLISH_EVERY_MS = 3 * 60_000;
/** An attempt still unsure this long after it was made: say "contact the store". */
export const UNSURE_AFTER_SECS = 10 * 60;
/** At most this many of the product's ended orders keep listening for a late delivery. */
export const MAX_ENDED_LISTENERS = 5;

/** A wallet the page can offer: connecting it yields the account that signs. */
export interface WalletOption {
  name: string;
  icon?: string;
  connect(): Promise<SolanaWallet>;
}

export type Problem =
  | { reason: 'no_wallet' | 'clock_skew' | 'rpc_error' | 'self_payment' | 'too_late' }
  | { reason: 'order_not_acknowledged' | 'no_store_inbox' | 'failed' | 'bad_email' }
  | { reason: 'wallet_failed' | 'wallet_unsupported' }
  | { reason: 'offer_changed' | 'confirm_first' | 'offer_refused' }
  | { reason: 'insufficient_token' | 'insufficient_sol'; needed: bigint; available: bigint };

export type View =
  | {
      kind: 'offer';
      offer: ReadyOffer;
      payout: PricedPayout;
      /** Warnings the buyer must confirm before any payment. */
      confirm: OfferWarning[];
      confirmed: boolean;
      notices: OfferWarning[];
      wallets: WalletOption[];
      problem?: Problem;
      /** An earlier order of this product is still open (acknowledged, not paid). */
      continuing: boolean;
      /** The merchant asks for an email (optional for the buyer). */
      askEmail: boolean;
      email: string;
    }
  | { kind: 'working'; step: 'checking' | 'ordering' | 'signing' }
  | {
      kind: 'waiting_payment';
      /** The coin being paid, for amounts in a problem. */
      asset: Asset;
      explorer?: string;
      /** The attempt provably ended with no payment: a retry is safe. */
      canRetry: boolean;
      /** Wallets for the retry. */
      wallets: WalletOption[];
      /** Warnings a retry needs confirmed (after a reload the confirmation is asked again). */
      confirm: OfferWarning[];
      confirmed: boolean;
      /** Still unsure long after the attempt: the buyer should contact the store. */
      unsureLong: boolean;
      problem?: Problem;
    }
  | { kind: 'waiting_store'; explorer?: string; cancelled: boolean }
  /** The store cancelled an order that was not paid: a new one may start. */
  | { kind: 'cancelled' }
  | { kind: 'delivered'; text: string; link?: string }
  | { kind: 'refunded' }
  | { kind: 'refused'; message: string };

export interface SessionDeps {
  store: OrderStore;
  readClient: OrderDeps['readClient'];
  clientFor: OrderDeps['clientFor'];
  /** The widget's RPC for a network, or `undefined` when none is configured. */
  rpcFor(network: Network): Rpc<SolanaRpcApi> | undefined;
  /** Wallets that can pay on this network. */
  wallets(network: Network): WalletOption[];
  /** Verify the offer again (a snapshot older than two minutes is never paid against). */
  reloadOffer(): Promise<LoadedOffer>;
  /** Device clock, seconds. */
  now(): number;
  /** Chain time (seconds) from a finalized block a little behind the tip. */
  chainTime(rpc: Rpc<SolanaRpcApi>): Promise<number>;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  onView(view: View): void;
  onStatus(state: CheckoutState): void;
  /** The merchant set `collect-email`: the offer asks for one (optional). */
  collectEmail?: boolean;
  /**
   * The offer is refused now, but the product has an order to follow (paid,
   * paying, delivered, or ended and still heard): no new payment, this message
   * where the offer would be.
   */
  followOnly?: { message: string; orderId: string };
}

/** At most this long, and shaped like an address; anything else is not sent. */
const MAX_EMAIL_LENGTH = 254;

/** The email to send with the order, or `undefined` for none or a malformed one. */
export function usableEmail(value: string): string | undefined {
  const email = value.trim();
  return email.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : undefined;
}

function networkOf(payout: PricedPayout): Network {
  return payout.target.caip19.chain.network;
}

/**
 * The payout target an order was placed to, from the order's own snapshot: a
 * store that lists another network first later must never move the order's
 * chain work (watching, ending, retrying) to that network.
 */
function recordTarget(record: OrderRecord): PricedPayout['target'] | undefined {
  return record.offer.payouts.find(
    (payout) =>
      payout.caip19.id === record.payout.caip19 && payout.address === record.payout.address,
  );
}

const NO_NETWORK = 'This network is not available here yet.';

/** The block explorer page of a Solana transaction. */
export function explorerLink(signature: string, network: Network): string {
  const cluster = network === 'mainnet' ? '' : `?cluster=${network}`;
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

/** The page-facing state of a record, or none (created: nothing to tell yet). */
function stateOf(record: OrderRecord): CheckoutState | undefined {
  switch (record.state) {
    case 'ordered':
      return 'ordered';
    case 'paying':
      return 'paying';
    case 'paid':
      return 'paid';
    case 'completed':
      return 'completed';
    case 'refunded':
      return 'refunded';
    case 'ended-unpaid':
      return 'ended';
    default:
      return undefined;
  }
}

/** The store cancelled an order no payment is known for (the attempt, if any, is over). */
function cancelledUnpaid(record: OrderRecord): boolean {
  return (
    record.status?.status === 'cancelled' &&
    record.paidTx === undefined &&
    (record.state === 'created' || record.state === 'ordered')
  );
}

/** Ended with no payment found (in this tab or another): no longer this product's purchase. */
function gone(record: OrderRecord): boolean {
  return record.state === 'ended-unpaid' && record.paidTx === undefined;
}

/**
 * One product's purchase in the widget: it resumes whatever record of the
 * product is open, and drives a new one from the offer to the delivery. Every
 * money rule lives in the core (order flow, Solana pay); this only sequences
 * it, re-reads the record before acting, and renders plain states. Everything
 * a record starts (the watch, the listener, the republishing) is bound to that
 * record and a generation: a result for an older one is dropped.
 */
export class CheckoutSession {
  private offer: ReadyOffer;
  private payout: PricedPayout;
  private confirmed: boolean;
  private record: OrderRecord | undefined;
  /** The relays the store is heard on for the current record (its inbox and past acknowledgers). */
  private relays: string[] = [];
  private wallet: SolanaWallet | undefined;
  private busy = false;
  private disposed = false;
  /** Bumped whenever the current record or its attempt changes: late results for older ones drop. */
  private generation = 0;
  private watchTimer: unknown;
  private watching = false;
  private republishTimer: unknown;
  private listening: { orderId: string; closer: { close(): void } } | undefined;
  /** Why the live attempt may not have gone out (the wallet failed): kept until it ends. */
  private attemptProblem: Problem | undefined;
  private email = '';
  private lastStatus: CheckoutState | undefined;
  /** The current attempt provably ended with no payment (a retry is offered). */
  private attemptOver = false;
  /** The widget refused (no RPC, the offer refused): nothing redraws an offer over it. */
  private refused = false;
  /** The generation the running watch timer belongs to. */
  private watchGeneration = -1;
  /** Never pays, only follows this order (the offer was refused, or its network is not served). */
  private followOnly: { message: string; orderId?: string } | undefined;
  /** The problem last shown on the offer, kept across a redraw. */
  private offerProblem: Problem | undefined;
  /** Listeners on the product's orders that ended unpaid: a delivery for one still shows. */
  private readonly background = new Map<string, { close(): void }>();
  /** When each background-heard order was placed (the cap keeps the newest). */
  private readonly backgroundCreated = new Map<string, number>();
  /** Deliveries or refunds heard for ended orders, shown once nothing live is on screen. */
  private readonly pendingAnswers = new Map<string, OrderRecord>();

  constructor(
    offer: ReadyOffer,
    private readonly deps: SessionDeps,
  ) {
    this.followOnly = deps.followOnly;
    this.offer = offer;
    const payout = offer.payouts[0];
    if (payout === undefined) {
      throw new Error('an offer without a payout');
    }
    this.payout = payout;
    this.confirmed = offer.confirm.length === 0;
  }

  /** Resume the product's open record (published again, the store's inbox read again), or show the offer. */
  async start(): Promise<void> {
    const records = await this.deps.store.forProduct(this.offer.productAddress);
    if (this.followOnly === undefined && this.deps.rpcFor(networkOf(this.payout)) === undefined) {
      // No new payment on this network. An order paid or paying on a served one is
      // still followed, and orders that ended unpaid are still heard.
      const stillFollowed = recordToShow(
        records.filter(
          (record) =>
            record.state !== 'created' &&
            record.state !== 'ordered' &&
            !gone(record) &&
            (isTerminal(record) || this.rpcOfRecord(record) !== undefined),
        ),
      );
      this.followOnly = {
        message: NO_NETWORK,
        ...(stillFollowed === undefined ? {} : { orderId: stillFollowed.orderId }),
      };
    }
    this.listenToEnded(records);
    // Follow-only: exactly the order the snapshot was built from, never another.
    const followed = this.followOnly;
    const shown =
      followed === undefined
        ? recordToShow(records)
        : records.find((record) => record.orderId === followed.orderId);
    if (shown === undefined || shown.state === 'ended-unpaid') {
      this.showOffer();
      return;
    }
    if (isTerminal(shown)) {
      await this.follow(shown);
      return;
    }
    const resumed = await resumeOrder(shown, this.orderDeps(), this.deps.now());
    await this.follow(resumed.record, resumed.relays);
  }

  /** The buyer ticked "I understand" for the offer's warnings. */
  confirm(checked: boolean): void {
    this.confirmed = checked || this.offer.confirm.length === 0;
    if (this.record?.state === 'paying') {
      this.render();
    } else {
      this.showOffer();
    }
  }

  /** What the buyer typed as email (sent with a new order only when it is one). */
  setEmail(value: string): void {
    this.email = value;
  }

  /** Pay with the wallet named `walletName`. */
  async pay(walletName: string): Promise<void> {
    if (this.busy || this.followOnly !== undefined) {
      return;
    }
    if (await this.deliveryFirst()) {
      return;
    }
    if (!this.confirmed) {
      this.showOffer({ reason: 'confirm_first' });
      return;
    }
    if (
      this.deps.collectEmail === true &&
      this.email.trim() !== '' &&
      usableEmail(this.email) === undefined
    ) {
      this.showOffer({ reason: 'bad_email' });
      return;
    }
    await this.guard(async () => {
      this.deps.onView({ kind: 'working', step: 'checking' });
      if (!(await this.connect(walletName, networkOf(this.payout)))) {
        this.showOffer({ reason: 'no_wallet' });
        return;
      }
      const ready = await this.freshOffer();
      const rpc = this.deps.rpcFor(networkOf(this.payout));
      if (ready === undefined) {
        return;
      }
      if (rpc === undefined) {
        this.showOffer({ reason: 'rpc_error' });
        return;
      }
      const chainTime = await this.readChainTime(rpc);
      if (chainTime === undefined) {
        this.showOffer({ reason: 'rpc_error' });
        return;
      }
      if (!clockAgrees(chainTime, this.deps.now())) {
        this.showOffer({ reason: 'clock_skew' });
        return;
      }
      const record = await this.orderFor(chainTime);
      if (record === undefined || this.wallet === undefined) {
        return;
      }
      this.deps.onView({ kind: 'working', step: 'signing' });
      this.stopWatching();
      this.generation += 1;
      const result = await payWithSolana(
        record,
        this.wallet,
        { fresh: ready, chainTime },
        this.payDeps(rpc),
      );
      await this.afterPay(result, rpc);
    });
  }

  /** A new attempt for the same order, once the last one provably ended. */
  async retry(walletName: string): Promise<void> {
    const record = this.record;
    if (this.busy || record === undefined || this.followOnly !== undefined) {
      return;
    }
    if (!this.confirmed) {
      this.render({ problem: { reason: 'confirm_first' } });
      return;
    }
    if (await this.deliveryFirst()) {
      return;
    }
    const network = this.networkOfRecord(record);
    if (network === undefined) {
      return;
    }
    await this.guard(async () => {
      if (!(await this.connect(walletName, network))) {
        this.render({ problem: { reason: 'no_wallet' } });
        return;
      }
      const ready = await this.freshOffer();
      const rpc = this.deps.rpcFor(network);
      if (ready === undefined || rpc === undefined || this.wallet === undefined) {
        return;
      }
      const chainTime = await this.readChainTime(rpc);
      if (chainTime === undefined) {
        this.render({ problem: { reason: 'rpc_error' } });
        return;
      }
      const current = (await this.deps.store.get(record.orderId)) ?? record;
      if (current.status?.status === 'cancelled') {
        // The store cancelled it: never another attempt (the store refuses one too).
        await this.follow(current);
        return;
      }
      this.deps.onView({ kind: 'working', step: 'signing' });
      this.stopWatching();
      this.generation += 1;
      const result = await retryWithSolana(
        current,
        this.wallet,
        { fresh: ready, chainTime },
        this.payDeps(rpc),
      );
      await this.afterPay(result, rpc);
    });
  }

  /** Leave an order that will not be paid (only once nothing can still land). */
  async startOver(): Promise<void> {
    const record = this.record;
    if (this.busy || record === undefined) {
      return;
    }
    await this.guard(async () => {
      const current = (await this.deps.store.get(record.orderId)) ?? record;
      // Finished (delivered or refunded): nothing to end, a new order may start.
      if (isTerminal(current)) {
        this.setRecord(undefined);
        this.showOffer();
        return;
      }
      const ended = await this.endOrder(current);
      if (ended.ended) {
        const relays = this.relays;
        this.setRecord(undefined);
        this.listenToEnded([ended.record], relays);
        this.status('ended');
        this.showOffer();
      } else {
        await this.follow(ended.record);
      }
    });
  }

  /** Draw the current screen again (a wallet registered, say); never during an action. */
  refresh(): void {
    if (this.busy || this.disposed) {
      return;
    }
    const record = this.record;
    const offerShown =
      record === undefined || record.state === 'created' || record.state === 'ordered';
    this.render(
      offerShown && this.offerProblem !== undefined ? { problem: this.offerProblem } : {},
    );
  }

  dispose(): void {
    this.disposed = true;
    this.setRecord(undefined);
    for (const closer of this.background.values()) {
      closer.close();
    }
    this.background.clear();
    this.backgroundCreated.clear();
  }

  // ---- internals -----------------------------------------------------------

  private async guard(run: () => Promise<void>): Promise<void> {
    // One action at a time: a caller that awaited before this point may find one running.
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await run();
    } catch {
      // Show what is stored, never a screen the record does not back.
      const stored =
        this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
      if (stored === undefined) {
        this.setRecord(undefined);
        this.showOffer({ reason: 'failed' });
      } else {
        this.attemptProblem ??= { reason: 'failed' };
        await this.follow(stored, undefined, { reason: 'failed' });
      }
    } finally {
      this.busy = false;
      // The store answered the current order during the action: that answer shows.
      if (this.record !== undefined && isTerminal(this.record) && !this.refused) {
        this.render();
      }
      void this.showPendingAnswer();
    }
  }

  /** End an order that holds nothing yet, or whose attempt provably ended on its own network. */
  private async endOrder(record: OrderRecord): Promise<{ ended: boolean; record: OrderRecord }> {
    if (record.state === 'created') {
      // Never acknowledged: nothing was requested for it and it holds nothing.
      return { ended: true, record };
    }
    const rpc = this.rpcOfRecord(record);
    if (rpc !== undefined) {
      return await endSolanaOrder(record, this.payDeps(rpc));
    }
    if (record.state === 'ordered' && record.marker === undefined) {
      // No attempt was ever made: ending it needs only the store, never the chain.
      const written = await this.deps.store.update(record.orderId, record.version, {
        state: 'ended-unpaid',
      });
      return written.ok ? { ended: true, record: written.record } : { ended: false, record };
    }
    // An attempt may still land on a network this build cannot read: it stays followed.
    return { ended: false, record };
  }

  /** The network an order's chain work runs on: the order's own, never the offer's. */
  private networkOfRecord(record: OrderRecord): Network | undefined {
    return recordTarget(record)?.caip19.chain.network;
  }

  private rpcOfRecord(record: OrderRecord): Rpc<SolanaRpcApi> | undefined {
    const network = this.networkOfRecord(record);
    return network === undefined ? undefined : this.deps.rpcFor(network);
  }

  private async connect(walletName: string, network: Network): Promise<boolean> {
    const option = this.deps.wallets(network).find((wallet) => wallet.name === walletName);
    if (option === undefined) {
      return false;
    }
    try {
      this.wallet = await option.connect();
      return true;
    } catch {
      return false;
    }
  }

  private async readChainTime(rpc: Rpc<SolanaRpcApi>): Promise<number | undefined> {
    try {
      return await this.deps.chainTime(rpc);
    } catch {
      return undefined;
    }
  }

  private payDeps(rpc: Rpc<SolanaRpcApi>) {
    return {
      store: this.deps.store,
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
      rpc,
      now: this.deps.now,
    };
  }

  private orderDeps(): OrderDeps {
    return {
      store: this.deps.store,
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
    };
  }

  private refuse(message: string): void {
    this.refused = true;
    this.deps.onView({ kind: 'refused', message });
    this.status('refused');
  }

  private status(state: CheckoutState): void {
    if (this.refused && state !== 'refused') {
      return;
    }
    if (state !== this.lastStatus) {
      this.lastStatus = state;
      this.deps.onStatus(state);
    }
  }

  /**
   * The offer to pay against: verified again when the snapshot is older than
   * two minutes. A changed price or payout, or a new warning to confirm, sends
   * the buyer back to the offer; a refusal ends the attempt.
   */
  private async freshOffer(): Promise<ReadyOffer | undefined> {
    if (!isSnapshotStale(this.offer.snapshotAt, this.deps.now())) {
      return this.offer;
    }
    const reloaded = await this.deps.reloadOffer();
    if (!reloaded.ok) {
      const live = this.record;
      if (live !== undefined && live.state !== 'created' && live.state !== 'ordered') {
        // No new payment, but the order that is paying or paid is still followed.
        this.render({ problem: { reason: 'offer_refused' } });
        return undefined;
      }
      this.setRecord(undefined);
      this.refuse(reloaded.message);
      return undefined;
    }
    const verdict = compareOffers(this.payout, this.offer.confirm, reloaded);
    this.offer = reloaded;
    if (verdict === 'same') {
      return reloaded;
    }
    const kept = reloaded.payouts.find(
      (payout) =>
        payout.target.caip19.id === this.payout.target.caip19.id &&
        payout.target.address === this.payout.target.address,
    );
    const payout = kept ?? reloaded.payouts[0];
    if (payout !== undefined) {
      this.payout = payout;
    }
    this.confirmed = reloaded.confirm.length === 0;
    const live = this.record;
    if (live !== undefined && live.state !== 'created' && live.state !== 'ordered') {
      // The attempt on screen stays followed: the change shows where it is retried.
      this.render({ problem: { reason: 'offer_changed' } });
    } else {
      this.showOffer({ reason: 'offer_changed' });
    }
    return undefined;
  }

  /**
   * The order to pay: the open acknowledged one when it is still for this
   * payout and price, else a new one. An order the store cancelled, or one on
   * old terms, ends first - and a new one starts only if it provably ended.
   * Acknowledged means the store's inbox holds it; the wallet never opens before.
   */
  private async orderFor(chainTime: number): Promise<OrderRecord | undefined> {
    let record =
      this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
    if (record !== undefined && gone(record)) {
      this.setRecord(undefined);
      record = undefined;
    }
    const stale =
      record !== undefined &&
      (cancelledUnpaid(record) ||
        record.payout.caip19 !== this.payout.target.caip19.id ||
        record.payout.address !== this.payout.target.address ||
        record.amount !== this.payout.amount.toString());
    if (record !== undefined && stale) {
      const ended = await this.endOrder(record);
      if (!ended.ended) {
        // Its attempt may still land: follow it, never a second order beside it.
        await this.follow(ended.record);
        return undefined;
      }
      this.setRecord(undefined);
      record = undefined;
    }
    if (record?.state === 'created') {
      this.deps.onView({ kind: 'working', step: 'ordering' });
      const resumed = await resumeOrder(record, this.orderDeps(), this.deps.now());
      record = resumed.record;
      this.relays = resumed.relays;
    }
    if (record === undefined) {
      this.deps.onView({ kind: 'working', step: 'ordering' });
      const email = this.deps.collectEmail === true ? usableEmail(this.email) : undefined;
      const placed = await placeOrder(
        {
          offer: this.offer,
          payout: this.payout,
          chainTime,
          deviceTime: this.deps.now(),
          ...(email === undefined ? {} : { email }),
        },
        this.orderDeps(),
      );
      if (placed.record !== undefined) {
        this.setRecord(placed.record);
        this.relays = placed.record.inboxRelays;
      }
      if (!placed.ok) {
        const problems: Record<typeof placed.reason, Problem> = {
          stale_offer: { reason: 'offer_changed' },
          not_acknowledged: { reason: 'order_not_acknowledged' },
          clock_skew: { reason: 'clock_skew' },
          no_store_inbox: { reason: 'no_store_inbox' },
        };
        this.showOffer(problems[placed.reason]);
        return undefined;
      }
      record = placed.record;
    }
    this.setRecord(record);
    if (record.state !== 'ordered') {
      if (record.state === 'created') {
        this.showOffer({ reason: 'order_not_acknowledged' });
      } else {
        await this.follow(record);
      }
      return undefined;
    }
    this.status('ordered');
    const composed = await composeOrderPayment(record, this.deps.store);
    if (!composed.ok) {
      this.showOffer({ reason: 'failed' });
      return undefined;
    }
    this.record = composed.record;
    this.listen(composed.record);
    return composed.record;
  }

  private async afterPay(result: SolanaPayResult, rpc: Rpc<SolanaRpcApi>): Promise<void> {
    if (result.record !== undefined) {
      // The store may have answered meanwhile: what is stored wins over the core's copy.
      const stored = await this.deps.store.get(result.record.orderId);
      this.setRecord(stored !== undefined && isTerminal(stored) ? stored : result.record);
      if (stored !== undefined && isTerminal(stored)) {
        await this.follow(stored);
        return;
      }
    }
    if (result.ok) {
      this.attemptProblem = undefined;
      this.attemptOver = false;
      await this.follow(result.record);
      return;
    }
    switch (result.reason) {
      case 'insufficient_token':
      case 'insufficient_sol':
        this.showOrWait({
          reason: result.reason,
          needed: result.needed ?? 0n,
          available: result.available ?? 0n,
        });
        return;
      case 'offer_changed':
      case 'too_late': {
        // Nothing was requested for this attempt: the order ends only if it provably did.
        const current = this.record;
        const ended =
          current === undefined ? undefined : await endSolanaOrder(current, this.payDeps(rpc));
        if (ended !== undefined && !ended.ended) {
          await this.follow(ended.record);
          return;
        }
        this.setRecord(undefined);
        this.showOffer({ reason: result.reason });
        return;
      }
      case 'wallet_failed':
      case 'wallet_unsupported':
        // No Solana error proves nothing was signed: the attempt waits for expiry.
        this.attemptProblem = { reason: result.reason };
        this.attemptOver = false;
        if (this.record !== undefined) {
          await this.follow(this.record);
        }
        return;
      case 'self_payment':
      case 'rpc_error':
        this.showOrWait({ reason: result.reason });
        return;
      case 'exclusion': {
        // Another order of this product holds a live attempt: that one is what to follow.
        const holder =
          result.holder === undefined ? undefined : await this.deps.store.get(result.holder);
        if (holder !== undefined) {
          await this.follow(holder);
          return;
        }
        this.showOffer({ reason: 'failed' });
        return;
      }
      default: {
        if (result.reason === 'still_waiting' || result.reason === 'already_paid') {
          this.attemptOver = false;
        }
        const current =
          this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
        if (current !== undefined) {
          await this.follow(current);
        } else {
          this.showOffer({ reason: 'failed' });
        }
      }
    }
  }

  /** A problem before any request: on the offer while none is live, else on the wait. */
  private showOrWait(problem: Problem): void {
    if (this.record?.state === 'paying') {
      this.render({ problem });
    } else {
      this.showOffer(problem);
    }
  }

  /** Make `record` the current one; a different order stops what the previous one started. */
  private setRecord(record: OrderRecord | undefined): void {
    if (record?.orderId !== this.record?.orderId) {
      this.stop();
      this.attemptProblem = undefined;
      this.attemptOver = false;
    }
    this.record = record;
  }

  /** Follow a record to its screen, starting the watch, the listener and the republishing it needs. */
  private async follow(record: OrderRecord, relays?: string[], problem?: Problem): Promise<void> {
    // Ended in another tab with nothing found: the product is free again.
    if (gone(record)) {
      const relays = this.relays;
      this.setRecord(undefined);
      this.listenToEnded([record], relays);
      this.showOffer(problem);
      void this.showPendingAnswer();
      return;
    }
    this.setRecord(record);
    if (relays !== undefined) {
      this.relays = relays;
    } else if (this.relays.length === 0) {
      this.relays = record.inboxRelays;
    }
    const state = stateOf(record);
    if (state !== undefined && state !== 'ended') {
      this.status(state);
    }
    if (isTerminal(record)) {
      this.stop();
      this.render();
      return;
    }
    this.listen(record);
    if (cancelledUnpaid(record)) {
      this.deps.onView({ kind: 'cancelled' });
      return;
    }
    if (record.state === 'created' || record.state === 'ordered') {
      this.showOffer(problem);
      return;
    }
    this.republishEvery();
    // A live attempt is reconciled; a found payment whose receipt was lost gets it sent.
    if (
      record.state === 'paying' ||
      record.state === 'ended-unpaid' ||
      record.receiptWrap === undefined
    ) {
      this.watch();
    }
    this.render();
  }

  private render(extra: { problem?: Problem } = {}): void {
    if (this.refused) {
      return;
    }
    const record = this.record;
    if (record !== undefined && gone(record)) {
      const relays = this.relays;
      this.setRecord(undefined);
      this.listenToEnded([record], relays);
      this.showOffer(extra.problem);
      void this.showPendingAnswer();
      return;
    }
    if (record === undefined || record.state === 'created' || record.state === 'ordered') {
      if (record !== undefined && cancelledUnpaid(record)) {
        this.deps.onView({ kind: 'cancelled' });
        return;
      }
      this.showOffer(extra.problem);
      return;
    }
    const target = recordTarget(record);
    const network = target?.caip19.chain.network ?? networkOf(this.payout);
    const status = record.status;
    if (record.state === 'completed') {
      const text = status?.delivery ?? '';
      const link = deliveryLink(text);
      this.deps.onView({ kind: 'delivered', text, ...(link === undefined ? {} : { link }) });
      return;
    }
    if (record.state === 'refunded') {
      this.deps.onView({ kind: 'refunded' });
      return;
    }
    if (record.state === 'paid' || record.paidTx !== undefined) {
      this.deps.onView({
        kind: 'waiting_store',
        cancelled: status?.status === 'cancelled',
        ...(record.paidTx === undefined ? {} : { explorer: explorerLink(record.paidTx, network) }),
      });
      return;
    }
    // The store cancelled and the attempt is over: only a new order is left.
    if (this.attemptOver && status?.status === 'cancelled') {
      this.deps.onView({ kind: 'cancelled' });
      return;
    }
    const marker = record.marker;
    const signature = marker?.rail === 'solana' ? marker.signature : undefined;
    const problem = extra.problem ?? this.attemptProblem;
    this.deps.onView({
      kind: 'waiting_payment',
      asset: target?.caip19.asset ?? this.payout.target.caip19.asset,
      // Follow-only never pays: no retry is offered (start over is).
      canRetry: this.attemptOver,
      wallets:
        this.attemptOver && this.followOnly === undefined && target !== undefined
          ? this.deps.wallets(network)
          : [],
      confirm: this.attemptOver && this.followOnly === undefined ? this.offer.confirm : [],
      confirmed: this.confirmed,
      unsureLong:
        !this.attemptOver &&
        marker !== undefined &&
        this.deps.now() - marker.setAt > UNSURE_AFTER_SECS,
      ...(signature === undefined ? {} : { explorer: explorerLink(signature, network) }),
      ...(problem === undefined ? {} : { problem }),
    });
  }

  private showOffer(problem?: Problem): void {
    if (this.followOnly !== undefined) {
      this.deps.onView({ kind: 'refused', message: this.followOnly.message });
      this.status('refused');
      return;
    }
    this.offerProblem = problem;
    this.deps.onView({
      kind: 'offer',
      offer: this.offer,
      payout: this.payout,
      confirm: this.offer.confirm,
      confirmed: this.confirmed,
      notices: this.offer.notices,
      wallets: this.deps.wallets(networkOf(this.payout)),
      continuing: this.record !== undefined && this.record.state === 'ordered',
      askEmail: this.deps.collectEmail === true,
      email: this.email,
      ...(problem === undefined ? {} : { problem }),
    });
    if (this.record === undefined) {
      this.status('ready');
    }
  }

  /** Reconcile the live attempt until it is found, ends, or the store answers. */
  private watch(): void {
    if (this.disposed) {
      return;
    }
    if (this.watchTimer !== undefined) {
      if (this.watchGeneration === this.generation) {
        return;
      }
      this.stopWatching();
    }
    const generation = this.generation;
    this.watchGeneration = generation;
    const tick = async () => {
      const record = this.record;
      const rpc = record === undefined ? undefined : this.rpcOfRecord(record);
      // One tick at a time, never during an action, never for an older record or attempt.
      if (this.watching || this.busy || record === undefined || rpc === undefined) {
        return;
      }
      if (generation !== this.generation) {
        if (this.watchGeneration === generation) {
          this.stopWatching();
        }
        return;
      }
      this.watching = true;
      try {
        const current = await this.deps.store.get(record.orderId);
        if (current === undefined) {
          return;
        }
        const watched = await watchSolanaPayment(current, this.payDeps(rpc));
        if (
          this.busy ||
          generation !== this.generation ||
          this.disposed ||
          (this.record !== undefined && isTerminal(this.record))
        ) {
          return;
        }
        // The listener may have stored a newer version (a status) during the pass.
        const stored = await this.deps.store.get(watched.record.orderId);
        if (this.busy || generation !== this.generation || this.disposed) {
          return;
        }
        this.record =
          stored !== undefined && stored.version > watched.record.version ? stored : watched.record;
        // Another tab replaced the attempt during the pass: its verdict is not this one's.
        if (this.record.marker?.attemptId !== watched.record.marker?.attemptId) {
          this.attemptOver = false;
          this.render();
          void this.showPendingAnswer();
          return;
        }
        if (watched.record.state === 'created' || watched.record.state === 'ordered') {
          // The attempt was cleared (nothing was requested): back to the offer.
          this.stopWatching();
          this.attemptOver = false;
          this.render();
          void this.showPendingAnswer();
          return;
        }
        if (watched.state === 'paid') {
          this.stopWatching();
          this.status('paid');
          this.render();
        } else if (watched.state === 'closed') {
          this.stopWatching();
          this.render();
        } else if (watched.state === 'over') {
          this.stopWatching();
          this.attemptProblem = undefined;
          this.attemptOver = true;
          this.render();
          // The attempt provably ended: a delivery already heard now shows.
          void this.showPendingAnswer();
        } else {
          // Waiting: whatever was over, a new attempt (another tab's) is live now.
          this.attemptOver = false;
          this.render();
        }
      } finally {
        this.watching = false;
      }
    };
    this.watchTimer = this.deps.setInterval(
      () => void tick().catch(() => undefined),
      WATCH_EVERY_MS,
    );
    void tick().catch(() => undefined);
  }

  private stopWatching(): void {
    if (this.watchTimer !== undefined) {
      this.deps.clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  /**
   * The product's orders that ended unpaid still hear the store (the plan: a
   * delivery that arrives for any record of the product is shown). When one is
   * delivered or refunded and nothing live is on screen, it is shown.
   */
  private listenToEnded(records: readonly OrderRecord[], relays: readonly string[] = []): void {
    const ended = records
      .filter((record) => gone(record) && !this.background.has(record.orderId))
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const record of ended) {
      if (this.disposed) {
        return;
      }
      if (this.background.size >= MAX_ENDED_LISTENERS) {
        // Full: the newest ended orders matter most - drop the oldest heard one if older.
        const oldest = [...this.backgroundCreated.entries()].sort(
          (left, right) => left[1] - right[1],
        )[0];
        if (oldest === undefined || oldest[1] >= record.createdAt) {
          continue;
        }
        this.background.get(oldest[0])?.close();
        this.background.delete(oldest[0]);
        this.backgroundCreated.delete(oldest[0]);
      }
      const heardOn = [...new Set([...record.inboxRelays, ...relays])];
      const closer = listenForStatus(record, heardOn, this.orderDeps(), (message) => {
        void applyStatus(this.deps.store, record.orderId, message, this.deps.now()).then(
          (updated) => {
            if (updated === undefined || this.disposed || !isTerminal(updated)) {
              return;
            }
            this.background.get(record.orderId)?.close();
            this.background.delete(record.orderId);
            this.backgroundCreated.delete(record.orderId);
            this.pendingAnswers.set(updated.orderId, updated);
            void this.showPendingAnswer();
          },
        );
      });
      this.background.set(record.orderId, closer);
      this.backgroundCreated.set(record.orderId, record.createdAt);
    }
  }

  /**
   * Show an ended order's delivery or refund once nothing live is on screen:
   * never during an action, and never over an order that is (per the store)
   * paying or paid - in this tab or another.
   */
  private async showPendingAnswer(
    onlyDeliveries = false,
  ): Promise<'shown' | 'held' | 'failed' | 'none'> {
    // A delivery first (the buyer has something to open), else the newest refund.
    const pending = [...this.pendingAnswers.values()]
      .filter((answer) => !onlyDeliveries || answer.state === 'completed')
      .sort(
        (left, right) =>
          Number(right.state === 'completed') - Number(left.state === 'completed') ||
          right.createdAt - left.createdAt,
      )[0];
    if (pending === undefined) {
      return 'none';
    }
    if (this.busy || this.disposed || this.refused) {
      return 'held';
    }
    try {
      const current = this.record;
      const live = current === undefined ? undefined : await this.deps.store.get(current.orderId);
      // A live order holds the answer back - unless its attempt provably ended
      // (the one the watch judged over is still the stored one).
      const attemptEnded =
        this.attemptOver &&
        live?.marker !== undefined &&
        live.marker.attemptId === current?.marker?.attemptId &&
        live.paidTx === undefined &&
        live.state === 'paying';
      if (
        live !== undefined &&
        !gone(live) &&
        !attemptEnded &&
        (live.state === 'paying' || live.state === 'paid' || live.paidTx !== undefined)
      ) {
        return 'held';
      }
      if (!this.pendingAnswers.has(pending.orderId)) {
        // Another call showed it meanwhile.
        return 'shown';
      }
      if (this.busy) {
        return 'held';
      }
      // The order on screen is replaced: an acknowledged one, or one whose attempt
      // provably ended, is ended first - never left open (or holding the product).
      // A refund never replaces an order the buyer is about to pay: it waits.
      if ((live?.state === 'ordered' || attemptEnded) && pending.state !== 'completed') {
        return 'held';
      }
      if (live !== undefined && (live.state === 'ordered' || attemptEnded)) {
        const rpc = this.rpcOfRecord(live);
        const ended = rpc === undefined ? undefined : await endSolanaOrder(live, this.payDeps(rpc));
        if (!this.pendingAnswers.has(pending.orderId)) {
          return 'shown';
        }
        if (ended === undefined || !ended.ended || this.busy) {
          return 'held';
        }
        this.listenToEnded([ended.record], this.relays);
      }
      await this.follow(pending);
      this.pendingAnswers.delete(pending.orderId);
      return 'shown';
    } catch {
      // Storage failed: the answer stays pending, shown on the next occasion.
      return 'failed';
    }
  }

  /**
   * Before any wallet opens: a delivery already heard for an earlier order is
   * shown instead (the buyer has it). `false` means go on.
   */
  private async deliveryFirst(): Promise<boolean> {
    const outcome = await this.showPendingAnswer(true);
    if (outcome === 'failed') {
      this.render({ problem: { reason: 'failed' } });
      return true;
    }
    return outcome === 'shown';
  }

  /** Hear the store's status for the current record, on the relays it is known to use. */
  private listen(record: OrderRecord): void {
    if (this.listening?.orderId === record.orderId || this.disposed || isTerminal(record)) {
      return;
    }
    this.listening?.closer.close();
    const orderId = record.orderId;
    const relays = this.relays.length === 0 ? record.inboxRelays : this.relays;
    const closer = listenForStatus(record, relays, this.orderDeps(), (message) => {
      void applyStatus(this.deps.store, orderId, message, this.deps.now()).then((updated) => {
        // Only the current record's answer counts; an abandoned order's is kept, not shown.
        if (updated === undefined || this.disposed || this.record?.orderId !== orderId) {
          return;
        }
        this.record = updated;
        const state = stateOf(updated);
        if (isTerminal(updated)) {
          this.stop();
          if (state !== undefined) {
            this.status(state);
          }
        }
        // An action in progress draws its own screen; the stored status shows after it.
        if (!this.busy) {
          this.render();
        }
      });
    });
    this.listening = { orderId, closer };
  }

  /** While no status came, publish the signed order and receipt again every few minutes. */
  private republishEvery(): void {
    if (this.republishTimer !== undefined || this.disposed) {
      return;
    }
    this.republishTimer = this.deps.setInterval(() => {
      const current = this.record;
      if (current === undefined || isTerminal(current)) {
        return;
      }
      const generation = this.generation;
      void this.deps.store
        .get(current.orderId)
        .then(async (fresh) => {
          if (fresh === undefined || isTerminal(fresh)) {
            return;
          }
          const resumed = await resumeOrder(fresh, this.orderDeps(), this.deps.now());
          // Stopped, switched or answered meanwhile: nothing to reopen.
          if (
            generation !== this.generation ||
            this.record?.orderId !== fresh.orderId ||
            isTerminal(this.record)
          ) {
            return;
          }
          const moved =
            resumed.relays.length !== this.relays.length ||
            resumed.relays.some((relay) => !this.relays.includes(relay));
          this.relays = resumed.relays;
          // The store reads elsewhere now: hear it there.
          if (moved) {
            this.listening?.closer.close();
            this.listening = undefined;
            this.listen(resumed.record);
          }
        })
        .catch(() => undefined);
    }, REPUBLISH_EVERY_MS);
  }

  private stop(): void {
    // Anything still running for what is stopped drops its result.
    this.generation += 1;
    this.stopWatching();
    if (this.republishTimer !== undefined) {
      this.deps.clearInterval(this.republishTimer);
      this.republishTimer = undefined;
    }
    this.listening?.closer.close();
    this.listening = undefined;
    this.relays = [];
  }
}
