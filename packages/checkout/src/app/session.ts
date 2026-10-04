import type { Product, TrustLevel } from '@elisym/commerce';
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
import {
  type OrderRecord,
  cancelledUnpaid,
  endOrder,
  gone,
  isTerminal,
  onOtherTerms,
  recordToShow,
} from '@elisym/commerce/buyer';
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
import {
  type TempoPayDeps,
  type TempoPayResult,
  type TempoWallet,
  endTempoOrder,
  mayStillBePaid,
  payWithTempo,
  MERCHANT_CATCH_UP_SECS,
  readTempoChainTime,
  storedTempoRequest,
  tempoLateDeadline,
  watchTempoPayment,
} from '@elisym/commerce/buyer';
import type { Asset, Network } from '@elisym/pay-core';
import { type Eip1193Client, readQuantity, withAbort } from '@elisym/pay-core/evm';
import { type Rpc, type SolanaRpcApi, isSignature } from '@solana/kit';
import type { CheckoutState } from '../embed/protocol';
import { type TempoWalletOption, TempoChainUnsupported, walletErrorKind } from './evm-wallets';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

/** How often a live attempt is reconciled against the chain. */
export const WATCH_EVERY_MS = 5_000;
/** How often the signed order and receipt are published again while no status came. */
export const REPUBLISH_EVERY_MS = 3 * 60_000;
/** An attempt still unsure this long after it was made: say "contact the store". */
export const UNSURE_AFTER_SECS = 10 * 60;
/** At most this many of the product's ended orders keep listening for a late delivery. */
export const MAX_ENDED_LISTENERS = 5;
/** A found payment with no store answer this long after: "contact the store". */
export const NO_ANSWER_AFTER_SECS = 30 * 60;
/**
 * Finalized blocks past an attempt's last valid height before the watch may
 * judge it over: the copy of commerce's private `EXPIRY_SETTLE_BLOCKS`
 * (`buyer/solana-pay.ts:71`, used at `:1048`). The countdown only; the watch decides.
 */
export const RETRY_SETTLE_BLOCKS = 32n;
/** Solana's target slot time, for an estimate of a block count in seconds. */
export const SLOT_SECS_ESTIMATE = 0.4;
/** The extra block-height read of a watch pass gives up after this long. */
export const EPOCH_READ_TIMEOUT_MS = 4_000;
/**
 * The Solana chain-time read before an order gives up after this long: its RPC
 * has no timeout of its own, and the buyer would wait on "Checking..." forever.
 */
export const CHAIN_TIME_TIMEOUT_MS = 15_000;
/** The one look-up of a transaction a receipt may name gives up after this long: no row then. */
export const TX_CHECK_TIMEOUT_MS = 10_000;

/** A wallet as the screens show it. */
export interface WalletChoice {
  name: string;
  icon?: string;
}

/** A wallet the page can offer: connecting it yields the account that signs. */
export interface WalletOption {
  name: string;
  icon?: string;
  connect(): Promise<SolanaWallet>;
}

export type Problem =
  | { reason: 'no_wallet' | 'clock_skew' | 'rpc_error' | 'self_payment' | 'too_late' }
  | { reason: 'tempo_unsupported' | 'wallet_busy' }
  | { reason: 'order_not_acknowledged' | 'no_store_inbox' | 'failed' | 'bad_email' }
  | { reason: 'wallet_failed' | 'wallet_unsupported' }
  | { reason: 'policy_blocked' | 'wrong_chain' | 'rejected' | 'attempt_over' | 'late_approval' }
  | { reason: 'offer_changed' | 'offer_refused' }
  | { reason: 'insufficient_token' | 'insufficient_sol'; needed: bigint; available: bigint };

/** The payment a progress screen is about: the live order's, else the payout chosen. */
export interface Paying {
  /** In the coin's subunits. */
  amount: string;
  asset: Asset;
  network: Network;
  chain: Rail;
}

/** The store as the header names it. No level when it comes from an order's old snapshot. */
export interface StoreInfo {
  name: string | undefined;
  level?: TrustLevel;
  domain?: string;
}

/** What a progress view is about: the store, the product (the order's own once it is paid on), the email sent. */
export interface About {
  store: StoreInfo;
  product: { title: string; summary?: string; price: Product['price'] };
  /** The email this session sent with the order shown, if any. */
  email?: string;
}

/**
 * What a finished order was, from its own record: "Paid" only when this
 * checkout's own verifier found the payment (`paid`), never on the store's word.
 * Otherwise the transaction this checkout sent may show (`sent`), and only once
 * the chain says it went through - which is not proof it paid this order's terms.
 */
export interface Receipt {
  store: string;
  product: string;
  /** What the order is for; absent when its payout cannot be read. */
  paying?: Paying;
  orderId: string;
  /** The payment this checkout found: its transaction, and when it was found (seconds). */
  paid?: { tx: string; at?: number; explorer?: string };
  /** A transaction this checkout sent for the order, found on chain and successful. */
  sent?: { tx: string; explorer?: string };
  /** When the store's answer was accepted (seconds): the date row when no payment was seen. */
  answeredAt?: number;
}

/** A time estimate: `seconds` left as of `at` (unix seconds, device clock). */
export interface Countdown {
  seconds: number;
  at: number;
}

export type View =
  | {
      kind: 'offer';
      offer: ReadyOffer;
      payout: PricedPayout;
      /** The payouts this widget can pay (a chooser when more than one), and the one chosen. */
      payouts: PricedPayout[];
      payoutIndex: number;
      wallets: WalletChoice[];
      problem?: Problem;
      /**
       * An earlier order of this product on these exact terms is still open: it
       * is paid as it is (its email went with it), so no email is asked. `created`:
       * not acknowledged by the store yet; `ordered`: acknowledged, not paid.
       */
      continuing: false | 'created' | 'ordered';
      /** The merchant asks for an email (optional for the buyer). */
      askEmail: boolean;
      email: string;
    }
  | {
      kind: 'working';
      step: 'checking' | 'ordering' | 'signing';
      paying?: Paying;
      about: About;
      /** Waiting for the wallet's connect answer: the buyer may cancel and choose again. */
      cancellable?: true;
    }
  | {
      kind: 'waiting_payment';
      paying?: Paying;
      about: About;
      /** The coin being paid, for amounts in a problem. */
      asset: Asset;
      explorer?: string;
      /** The attempt provably ended with no payment: a retry is safe. */
      canRetry: boolean;
      /** Wallets for the retry. */
      wallets: WalletChoice[];
      /** A Tempo attempt: no retry here; it ends once proven over. */
      tempo: boolean;
      /** The wallet answered: a signature (Solana), or a hash or bundle (Tempo). */
      signed: boolean;
      /** This session only follows the order: never a retry, start over only. */
      followOnly: boolean;
      /** This checkout cannot read the order's network: it cannot tell when it ends. */
      unserved: boolean;
      /** When still unsure, the buyer should contact the store (unix seconds). */
      unsureAt?: number;
      /** Solana: about when a retry can be judged safe (an estimate; the watch decides). */
      retryIn?: Countdown;
      /** Tempo: about when the checkout stops waiting for the wallet request. */
      requestEndsIn?: Countdown;
      problem?: Problem;
    }
  | {
      kind: 'waiting_store';
      paying?: Paying;
      about: About;
      explorer?: string;
      cancelled: boolean;
      /** Paid, and no answer from the store for 30 minutes: contact the store. */
      noAnswer: boolean;
    }
  /**
   * A Tempo order of this product ended with its wallet prompt maybe still open:
   * approving it pays that order too. Asked before this payment's wallet opens.
   */
  | {
      kind: 'old_prompt';
      orders: number;
      /** After this (seconds), the store no longer sees an approval of the old request. */
      until: number;
      about: About;
      paying?: Paying;
    }
  /** The recipient's transfer policy blocked the payment: the money sits with the guard. */
  | { kind: 'blocked'; store?: StoreInfo; product?: About['product'] }
  /** The store cancelled an order that was not paid: a new one may start. */
  | { kind: 'cancelled'; store?: StoreInfo; product?: About['product'] }
  | {
      kind: 'delivered';
      text: string;
      link?: string;
      store?: StoreInfo;
      product?: About['product'];
      receipt?: Receipt;
    }
  | { kind: 'refunded'; store?: StoreInfo; product?: About['product']; receipt?: Receipt }
  | { kind: 'refused'; message: string; store?: StoreInfo; product?: About['product'] };

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
  /** One-shot timers (the chain-time read's deadline). */
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  onView(view: View): void;
  onStatus(state: CheckoutState): void;
  /** The merchant set `collect-email`: the offer asks for one (optional). */
  collectEmail?: boolean;
  /** Tempo: a read RPC of a Tempo network, or `undefined` when none is configured. */
  tempoFor?(network: Network): Eip1193Client | undefined;
  /** Tempo: wallets (EIP-6963) that can pay on this Tempo network. */
  tempoWallets?(network: Network): TempoWalletOption[];
  /** Tempo chain time (seconds): the finalized head. */
  tempoChainTime?(client: Eip1193Client): Promise<number>;
  /**
   * A store answer (or a late payment found) for an order not on screen: shown
   * at once as a banner, never held back by the order that is.
   */
  onBanner?(banner: Banner): void;
  /**
   * The offer is refused now, but the product has an order to follow (paid,
   * paying, delivered, or ended and still heard): no new payment, this message
   * where the offer would be.
   */
  followOnly?: { message: string; orderId: string };
}

/** A late answer or find for an order that is not on screen. */
export interface Banner {
  orderId: string;
  state: 'paid' | 'blocked' | 'completed' | 'refunded';
  text?: string;
  link?: string;
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

export type Rail = 'solana' | 'tempo';

function railOf(payout: PricedPayout): Rail {
  return payout.target.caip19.chain.family === 'evm' ? 'tempo' : 'solana';
}

function recordRail(record: OrderRecord): Rail {
  return record.payout.caip19.startsWith('eip155:') ? 'tempo' : 'solana';
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
/** The reloaded offer has no payout this widget can pay on the page's network. */
const NO_PAYABLE_PAYOUT = 'This product cannot be paid here';

function samePayout(left: PricedPayout, right: PricedPayout): boolean {
  return (
    left.target.caip19.id === right.target.caip19.id && left.target.address === right.target.address
  );
}

/** What an order is paying, from the order's own snapshot. */
function recordPaying(record: OrderRecord): Paying | undefined {
  const target = recordTarget(record);
  return target === undefined
    ? undefined
    : {
        amount: record.amount,
        asset: target.caip19.asset,
        network: target.caip19.chain.network,
        chain: recordRail(record),
      };
}

/** A product as a progress view names it. */
function productOf(product: Product): About['product'] {
  return {
    title: product.title,
    ...(product.summary === undefined ? {} : { summary: product.summary }),
    price: product.price,
  };
}

/** What a new order for `payout` would pay. */
export function payoutPaying(payout: PricedPayout): Paying {
  return {
    amount: payout.amount.toString(),
    asset: payout.target.caip19.asset,
    network: networkOf(payout),
    chain: railOf(payout),
  };
}

/** The explorer page of a transaction on the record's own chain. */
function explorerFor(record: OrderRecord, tx: string, network: Network): string {
  if (recordRail(record) === 'solana') {
    return explorerLink(tx, network);
  }
  const template = recordTarget(record)?.caip19.chain.explorerTx;
  return template === undefined ? '' : template.replace('{tx}', encodeURIComponent(tx));
}

/** The block explorer page of a Solana transaction. */
export function explorerLink(signature: string, network: Network): string {
  const cluster = network === 'mainnet' ? '' : `?cluster=${network}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${cluster}`;
}

/** A wallet's connect answer: the wallet, or why there is none. */
type ConnectAnswer = { wallet: SolanaWallet } | { error: 'rejected' | 'busy' | 'failed' };

/** The problem a refused or failed wallet connect shows. */
function connectProblem(
  error: 'rejected' | 'busy' | 'failed',
): 'rejected' | 'wallet_busy' | 'no_wallet' {
  switch (error) {
    case 'rejected':
      return 'rejected';
    case 'busy':
      return 'wallet_busy';
    case 'failed':
      return 'no_wallet';
  }
}

/** A Tempo connect failure, as the buyer is told: a wallet without the chain is named as such. */
function tempoConnectProblem(
  error: unknown,
): 'tempo_unsupported' | 'rejected' | 'wallet_busy' | 'no_wallet' {
  return error instanceof TempoChainUnsupported
    ? 'tempo_unsupported'
    : connectProblem(walletErrorKind(error));
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
  private record: OrderRecord | undefined;
  /** The relays the store is heard on for the current record (its inbox and past acknowledgers). */
  private relays: string[] = [];
  private busy = false;
  /** The press that holds `busy`: only its own end releases it. */
  private busyOwner: number | undefined;
  /**
   * The current press id: bumped by every pay or retry press and by a cancel. A
   * press whose id is no longer current drops whatever its awaits bring back.
   */
  private press = 0;
  /** The press now waiting for the wallet's connect answer: the one Cancel ends. */
  private cancellableFor: number | undefined;
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
  /** A Tempo hash returned in this session that could not be stored yet: the watch retries it. */
  private pendingHash: { orderId: string; hash: string } | undefined;
  /** A payment refused until the buyer confirms the old-prompt warning: the action, the orders. */
  private oldPrompt:
    | { walletName: string; action: 'pay' | 'retry'; unconfirmed: string[] }
    | undefined;
  /** What the last wallet press was (a confirmation re-runs it). */
  private lastAction: 'pay' | 'retry' = 'pay';
  /** A hash approved for an order another tab ended meanwhile: watched until it is found. */
  private lateHash: { orderId: string; hash: string; timer: unknown } | undefined;
  /** The one-shot "no answer from the store" redraw. */
  private noAnswerTimer: { orderId: string; handle: unknown } | undefined;
  /** The wallet of the last pay press (a confirmation re-runs it). */
  private lastWallet = '';
  /** A pay or retry press is running (from its first await): the payout cannot change under it. */
  private pressing = false;
  /** A retry is running: its progress views name the order's own terms. */
  private retrying = false;
  /** The email this session sent with each order it placed (the record keeps none). */
  private readonly sentEmail = new Map<string, string>();
  /**
   * Every Tempo hash a wallet returned in this session, by order: a receipt
   * may name it even after the pending or late hash was let go.
   */
  private readonly sentHash = new Map<string, string>();
  /** Attempts this session proved over: their transaction never landed and is never named. */
  private readonly overAttemptIds = new Set<string>();
  /** The transaction each finished order's receipt may name, chosen once. */
  private readonly receiptCandidates = new Map<string, string>();
  /** The one on-chain look-up of each such transaction, by order and transaction. */
  private readonly txChecks = new Map<string, 'pending' | boolean>();
  /**
   * Why a re-check refused this page, while an order kept it from ending: the
   * trust level is no longer shown, and no new purchase is offered.
   */
  private refusedHere: string | undefined;
  /** The last block-height estimate of the live Solana attempt, by attempt. */
  private retryEstimate:
    | { attemptId: string; seconds: number; at: number; latched: boolean }
    | undefined;
  /** When the page loaded: the "no answer" timer of a payment found before `paidAt` existed. */
  private readonly loadedAt: number;
  /**
   * The page's network, fixed at load: a reloaded offer that lists another
   * network first never moves a purchase to it.
   */
  private readonly network: Network;

  constructor(
    offer: ReadyOffer,
    private readonly deps: SessionDeps,
  ) {
    this.followOnly = deps.followOnly;
    this.offer = offer;
    // The first payout's network is the page's: never a quiet switch to another
    // network. Among its payouts, the first this widget can pay is the default.
    const first = offer.payouts[0];
    const payout =
      offer.payouts.find(
        (each) =>
          first !== undefined && networkOf(each) === networkOf(first) && this.servable(each),
      ) ?? first;
    if (first === undefined || payout === undefined) {
      throw new Error('an offer without a payout');
    }
    this.network = networkOf(first);
    this.payout = payout;
    this.loadedAt = deps.now();
  }

  /** Resume the product's open record (published again, the store's inbox read again), or show the offer. */
  async start(): Promise<void> {
    const records = await this.deps.store.forProduct(this.offer.productAddress);
    if (this.followOnly === undefined && !this.servable(this.payout)) {
      // No new payment on this network. An order paid or paying on a served one is
      // still followed, and orders that ended unpaid are still heard.
      const stillFollowed = recordToShow(
        records.filter(
          (record) =>
            record.state !== 'created' &&
            record.state !== 'ordered' &&
            !gone(record) &&
            (isTerminal(record) || this.recordServed(record)),
        ),
      );
      this.followOnly = {
        message: NO_NETWORK,
        ...(stillFollowed === undefined ? {} : { orderId: stillFollowed.orderId }),
      };
    }
    this.listenToEnded(records);
    // A Tempo order that ended with its prompt still open may have been paid since.
    await this.reconcileEnded(records);
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

  /** What the buyer typed as email (sent with a new order only when it is one). */
  setEmail(value: string): void {
    this.email = value;
  }

  /**
   * The buyer picked another payout: only while no payment is pressed or
   * running, the old-prompt question is not up, and the order on screen (if
   * any) is not paid on yet.
   */
  choosePayout(index: number): void {
    const payout = this.payablePayouts()[index];
    const state = this.record?.state;
    const open = state === undefined || state === 'created' || state === 'ordered';
    if (
      payout === undefined ||
      this.busy ||
      this.pressing ||
      !open ||
      this.oldPrompt !== undefined
    ) {
      return;
    }
    this.payout = payout;
    this.showOffer();
  }

  /** The buyer confirmed the old-prompt warning: the refused payment runs again. */
  async confirmOldPrompt(): Promise<void> {
    const pending = this.oldPrompt;
    const current =
      this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
    if (pending === undefined || this.busy || current === undefined) {
      return;
    }
    this.oldPrompt = undefined;
    const confirmed = [...new Set([...(current.confirmedOverIds ?? []), ...pending.unconfirmed])];
    const written = await this.deps.store.update(current.orderId, current.version, {
      confirmedOverIds: confirmed,
    });
    if (!written.ok) {
      this.showOffer({ reason: 'failed' });
      return;
    }
    this.setRecord(written.record);
    if (pending.action === 'retry') {
      await this.retry(pending.walletName);
    } else {
      await this.pay(pending.walletName);
    }
  }

  /** The buyer declined: back to what is on screen, nothing requested. */
  cancelOldPrompt(): void {
    this.oldPrompt = undefined;
    if (this.record?.state === 'paying') {
      void this.follow(this.record);
    } else {
      this.showOffer();
    }
  }

  /** Pay with the wallet named `walletName`. */
  async pay(walletName: string): Promise<void> {
    if (this.busy || this.pressing || this.followOnly !== undefined) {
      return;
    }
    this.press += 1;
    const press = this.press;
    this.pressing = true;
    try {
      await this.payPressed(walletName, press);
    } finally {
      // A cancelled press ends later: it never releases a newer press's flag.
      if (this.press === press) {
        this.pressing = false;
      }
    }
  }

  /**
   * The buyer cancels while the wallet has not answered its connect request:
   * the press ends now (a late answer is dropped), the screen it came from shows
   * again, and nothing about the order changes - nothing was asked of it yet.
   */
  cancel(): void {
    if (this.disposed || this.cancellableFor === undefined || this.cancellableFor !== this.press) {
      return;
    }
    this.press += 1;
    this.cancellableFor = undefined;
    this.busy = false;
    this.busyOwner = undefined;
    this.pressing = false;
    this.retrying = false;
    // Exactly how an action ends: the stored truth, then any answer held meanwhile.
    this.render();
    void this.showPendingAnswer();
  }

  private async payPressed(walletName: string, press: number): Promise<void> {
    this.lastWallet = walletName;
    this.lastAction = 'pay';
    if (this.lateHashHolds()) {
      return;
    }
    if (await this.deliveryFirst()) {
      return;
    }
    // A new order is certain: a typo never costs a wallet prompt or the open order.
    // (Both rails: `payTempo` starts below.) An order continued on its own terms
    // went with its email already, so no typed value blocks it.
    const newOrder = this.record === undefined || onOtherTerms(this.record, this.payout);
    if (newOrder && this.emailUnusable()) {
      this.showOffer({ reason: 'bad_email' });
      return;
    }
    if (railOf(this.payout) === 'tempo') {
      await this.payTempo(walletName, press);
      return;
    }
    await this.guard(press, async () => {
      this.cancellableFor = press;
      this.working('checking', true);
      const answer = await this.connect(walletName, networkOf(this.payout));
      if (this.press !== press) {
        // Cancelled: the answer is dropped, nothing is drawn.
        return;
      }
      this.cancellableFor = undefined;
      if ('error' in answer) {
        this.showOffer({ reason: connectProblem(answer.error) });
        return;
      }
      const wallet = answer.wallet;
      this.working('checking');
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
      if (record === undefined) {
        return;
      }
      this.working('signing');
      this.stopWatching();
      this.generation += 1;
      const result = await payWithSolana(
        record,
        wallet,
        { fresh: ready, chainTime },
        this.payDeps(rpc),
      );
      await this.afterPay(result, rpc);
    });
  }

  /**
   * Pay on Tempo: connect (accounts, then the chain) before anything is ordered
   * or composed, order on Tempo's finalized time, then one wallet request. No
   * retry exists on Tempo: an attempt stays live until it is found or proven over.
   */
  private async payTempo(walletName: string, press: number): Promise<void> {
    await this.guard(press, async () => {
      this.cancellableFor = press;
      this.working('checking', true);
      const network = networkOf(this.payout);
      const option = this.deps.tempoWallets?.(network).find((each) => each.name === walletName);
      if (option === undefined) {
        this.cancellableFor = undefined;
        this.showOffer({ reason: 'no_wallet' });
        return;
      }
      let wallet: TempoWallet;
      try {
        wallet = await option.connect();
      } catch (error) {
        if (this.press !== press) {
          // Cancelled: a late refusal draws nothing.
          return;
        }
        this.cancellableFor = undefined;
        this.showOffer({ reason: tempoConnectProblem(error) });
        return;
      }
      if (this.press !== press) {
        return;
      }
      this.cancellableFor = undefined;
      this.working('checking');
      const ready = await this.freshOffer();
      if (ready === undefined) {
        return;
      }
      const client = this.deps.tempoFor?.(network);
      if (client === undefined) {
        this.showOffer({ reason: 'rpc_error' });
        return;
      }
      let chainTime: number;
      try {
        chainTime = await (this.deps.tempoChainTime ?? readTempoChainTime)(client);
      } catch {
        this.showOffer({ reason: 'rpc_error' });
        return;
      }
      if (!clockAgrees(chainTime, this.deps.now())) {
        this.showOffer({ reason: 'clock_skew' });
        return;
      }
      const record = await this.orderFor(chainTime);
      if (record === undefined) {
        return;
      }
      this.working('signing');
      this.stopWatching();
      this.generation += 1;
      const result = await payWithTempo(record, wallet, ready, this.tempoDeps(client));
      await this.afterTempoPay(result);
    });
  }

  private async afterTempoPay(result: TempoPayResult): Promise<void> {
    if (result.ok) {
      // Remembered before anything else: a store that answered while the wallet was
      // open makes the record terminal, and its receipt still names what was sent.
      this.sentHash.set(result.record.orderId, result.hash);
    }
    if (result.record !== undefined) {
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
      if (result.hashUnsaved === true && result.record.state === 'ended-unpaid') {
        // Another tab ended the order while the wallet was open: the buyer approved
        // it anyway. The hash is watched until the payment is found, and said so.
        this.watchLateHash(result.record, result.hash);
        // Its store answer still comes: heard in the background, shown as a banner.
        this.listenToEnded([result.record], this.relays);
        this.setRecord(undefined);
        this.showOffer({ reason: 'late_approval' });
        return;
      }
      if (result.hashUnsaved === true) {
        this.pendingHash = { orderId: result.record.orderId, hash: result.hash };
        this.sentHash.set(result.record.orderId, result.hash);
      }
      await this.follow(result.record);
      return;
    }
    switch (result.reason) {
      case 'insufficient_token':
        this.showOrWait({
          reason: 'insufficient_token',
          needed: result.needed ?? 0n,
          available: result.available ?? 0n,
        });
        return;
      case 'needs_confirmation':
        await this.askOldPrompt(result.unconfirmed ?? []);
        return;
      case 'rejected':
        // Nothing was signed: the order ended, a new one may start (no old-prompt warning).
        this.setRecord(undefined);
        if (result.record !== undefined) {
          this.listenToEnded([result.record]);
        }
        this.status('ended');
        this.showOffer({ reason: 'rejected' });
        return;
      case 'wallet_failed':
        // No hash: the attempt may still land (a queued prompt): it stays live.
        this.attemptProblem = { reason: 'wallet_failed' };
        this.attemptOver = false;
        if (this.record !== undefined) {
          await this.follow(this.record);
        }
        return;
      case 'policy_blocked':
      case 'wrong_chain':
      case 'self_payment':
      case 'rpc_error':
        this.showOrWait({ reason: result.reason });
        return;
      case 'offer_changed':
      case 'too_late':
      case 'unpayable': {
        const current =
          this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
        const ended = current === undefined ? undefined : await this.endOrder(current);
        if (ended !== undefined && !ended.ended) {
          await this.follow(ended.record);
          return;
        }
        this.setRecord(undefined);
        this.showOffer({ reason: result.reason === 'unpayable' ? 'failed' : result.reason });
        return;
      }
      case 'exclusion': {
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

  /** A payment refused for an ended Tempo order whose prompt may still be approved: ask. */
  private async askOldPrompt(unconfirmed: string[]): Promise<void> {
    this.oldPrompt = { walletName: this.lastWallet, action: this.lastAction, unconfirmed };
    let until = 0;
    try {
      const records = await this.deps.store.forProduct(this.offer.productAddress);
      until = Math.max(
        0,
        ...records
          .filter((record) => unconfirmed.includes(record.orderId))
          .map((record) => record.createdAt + MERCHANT_CATCH_UP_SECS),
      );
    } catch {
      // The date is shown when known; the question is asked either way.
    }
    const terms = this.termsShown(false);
    const paying = this.payingOf(terms);
    this.deps.onView({
      kind: 'old_prompt',
      orders: unconfirmed.length,
      until,
      about: this.aboutOf(terms),
      ...(paying === undefined ? {} : { paying }),
    });
  }

  /** An unsaved hash of an order another tab ended: it is a late approval now. */
  private adoptLateHash(record: OrderRecord): void {
    if (this.pendingHash?.orderId === record.orderId) {
      this.watchLateHash(record, this.pendingHash.hash);
      this.pendingHash = undefined;
    }
  }

  /**
   * An approval of an ended order is in flight (known only in this session):
   * no other payment of the product until it is found - the buyer approved it,
   * so there is no prompt left to reject.
   */
  private lateHashHolds(): boolean {
    if (this.lateHash === undefined) {
      return false;
    }
    this.showOffer({ reason: 'late_approval' });
    return true;
  }

  /** Watch a hash approved for an ended order until it is found (or blocked): a banner then. */
  private watchLateHash(record: OrderRecord, hash: string): void {
    const client = this.tempoOfRecord(record);
    if (client === undefined || this.disposed) {
      return;
    }
    if (this.lateHash !== undefined) {
      this.deps.clearInterval(this.lateHash.timer);
    }
    let checking = false;
    const check = async () => {
      if (checking || this.disposed) {
        return;
      }
      checking = true;
      try {
        const current = await this.deps.store.get(record.orderId);
        if (current === undefined) {
          return;
        }
        const watched = await watchTempoPayment(current, this.tempoDeps(client), {
          pendingHash: hash,
        });
        if (watched.state === 'paid' || watched.state === 'blocked' || watched.state === 'closed') {
          this.banner(watched.record);
          if (this.lateHash !== undefined) {
            this.deps.clearInterval(this.lateHash.timer);
            this.lateHash = undefined;
          }
        }
      } finally {
        checking = false;
      }
    };
    const timer = this.deps.setInterval(() => void check().catch(() => undefined), WATCH_EVERY_MS);
    this.lateHash = { orderId: record.orderId, hash, timer };
    this.sentHash.set(record.orderId, hash);
    void check().catch(() => undefined);
  }

  private tempoDeps(client: Eip1193Client): TempoPayDeps {
    return {
      store: this.deps.store,
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
      client,
      now: this.deps.now,
    };
  }

  /** The payouts this widget can pay now, on the page's network. */
  private payablePayouts(offer: ReadyOffer = this.offer): PricedPayout[] {
    return offer.payouts.filter(
      (payout) => networkOf(payout) === this.network && this.servable(payout),
    );
  }

  /** The buyer typed an email the merchant asked for, and it is not one. */
  private emailUnusable(): boolean {
    return (
      this.deps.collectEmail === true &&
      this.email.trim() !== '' &&
      usableEmail(this.email) === undefined
    );
  }

  /**
   * The order whose terms a progress screen shows: the open one while it is
   * being signed or retried, or while it is the one being continued; else none,
   * and the screen shows the payout chosen - exactly what a new order is placed
   * for. The payment line and the product always come from the same choice.
   */
  private termsShown(signing: boolean): OrderRecord | undefined {
    const record = this.record;
    return record !== undefined && (signing || this.retrying || !onOtherTerms(record, this.payout))
      ? record
      : undefined;
  }

  private payingOf(terms: OrderRecord | undefined): Paying | undefined {
    return terms === undefined ? payoutPaying(this.payout) : recordPaying(terms);
  }

  /**
   * An order seen ended with nothing found, or an attempt proven over: its
   * marker's transaction never landed, so no receipt ever names it.
   */
  private noteOver(record: OrderRecord): void {
    if (record.marker !== undefined) {
      this.overAttemptIds.add(record.marker.attemptId);
    }
  }

  /**
   * The transaction a finished order's receipt may name, chosen once: the
   * attempt's own (not one proven over), else a Tempo hash a wallet returned
   * in this session for the order.
   */
  private receiptCandidate(record: OrderRecord): string | undefined {
    const chosen = this.receiptCandidates.get(record.orderId);
    if (chosen !== undefined) {
      return chosen;
    }
    const marker = record.marker;
    let tx: string | undefined;
    if (marker?.rail === 'solana' && !this.overAttemptIds.has(marker.attemptId)) {
      tx = marker.signature;
    } else if (marker?.rail === 'tempo' && !this.overAttemptIds.has(marker.attemptId)) {
      tx = marker.txHash;
    }
    tx ??= this.sentHash.get(record.orderId);
    if (tx !== undefined) {
      this.receiptCandidates.set(record.orderId, tx);
    }
    return tx;
  }

  /**
   * A finished order's receipt, entirely from its own record. "Paid" only with
   * `paidTx` (this checkout's verifier found the payment); otherwise the
   * transaction this checkout sent, once the chain says it succeeded - looked
   * up once, after the view is drawn, never shown while unknown.
   */
  private receiptOf(record: OrderRecord, network: Network): Receipt {
    const paying = recordPaying(record);
    const base = {
      store: record.offer.profile.name ?? 'Unnamed store',
      product: record.offer.product.title,
      ...(paying === undefined ? {} : { paying }),
      orderId: record.orderId,
      ...(record.status === undefined ? {} : { answeredAt: record.status.at }),
    };
    const paidTx = record.paidTx;
    if (paidTx !== undefined) {
      const explorer = explorerFor(record, paidTx, network);
      return {
        ...base,
        paid: {
          tx: paidTx,
          ...(record.paidAt === undefined ? {} : { at: record.paidAt }),
          ...(explorer.startsWith('https://') ? { explorer } : {}),
        },
      };
    }
    const tx = this.receiptCandidate(record);
    if (tx === undefined) {
      return base;
    }
    const checked = this.txChecks.get(`${record.orderId}:${tx}`);
    if (checked === undefined) {
      this.checkSentTx(record, tx);
      return base;
    }
    if (checked !== true) {
      return base;
    }
    const explorer = explorerFor(record, tx, network);
    return {
      ...base,
      sent: { tx, ...(explorer.startsWith('https://') ? { explorer } : {}) },
    };
  }

  /**
   * Look a sent transaction up once, on the order's own network: found and
   * successful, or nothing. A late answer only fills the cache; it redraws only
   * the same finished order, and never during an action.
   */
  private checkSentTx(record: OrderRecord, tx: string): void {
    const key = `${record.orderId}:${tx}`;
    this.txChecks.set(key, 'pending');
    void this.sentTxSucceeded(record, tx)
      .catch(() => false)
      .then((found) => {
        this.txChecks.set(key, found);
        const current = this.record;
        if (
          found &&
          !this.busy &&
          !this.disposed &&
          !this.refused &&
          current?.orderId === record.orderId &&
          isTerminal(current)
        ) {
          this.render();
        }
      });
  }

  private async sentTxSucceeded(record: OrderRecord, tx: string): Promise<boolean> {
    if (recordTarget(record) === undefined) {
      return false;
    }
    if (recordRail(record) === 'solana') {
      const rpc = this.rpcOfRecord(record);
      if (rpc === undefined || !isSignature(tx)) {
        return false;
      }
      const statuses = await rpc
        .getSignatureStatuses([tx], { searchTransactionHistory: true })
        .send({ abortSignal: AbortSignal.timeout(TX_CHECK_TIMEOUT_MS) });
      const status = statuses.value[0];
      return (
        status !== null &&
        status !== undefined &&
        status.err === null &&
        (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
      );
    }
    const client = this.tempoOfRecord(record);
    if (client === undefined) {
      return false;
    }
    const receipt: unknown = await withAbort(
      client.request({ method: 'eth_getTransactionReceipt', params: [tx] }),
      AbortSignal.timeout(TX_CHECK_TIMEOUT_MS),
    );
    if (typeof receipt !== 'object' || receipt === null || !('status' in receipt)) {
      return false;
    }
    return readQuantity(receipt.status) === 1n;
  }

  /**
   * The store from the offer on screen: its name only when that offer is an
   * order's old snapshot (follow-only), so no trust level is shown it no longer has.
   */
  private storeInfo(): StoreInfo {
    const { profile, level, domain } = this.offer.offer;
    if (this.deps.followOnly !== undefined || this.refusedHere !== undefined) {
      return { name: profile.name };
    }
    return { name: profile.name, level, ...(domain === undefined ? {} : { domain }) };
  }

  private aboutOf(terms: OrderRecord | undefined): About {
    const email = terms === undefined ? undefined : this.sentEmail.get(terms.orderId);
    return {
      store: this.storeInfo(),
      product: productOf(terms === undefined ? this.offer.offer.product : terms.offer.product),
      ...(email === undefined ? {} : { email }),
    };
  }

  /** A progress screen, with the payment and the product it is about. */
  private working(step: 'checking' | 'ordering' | 'signing', cancellable = false): void {
    const terms = this.termsShown(step === 'signing');
    const paying = this.payingOf(terms);
    this.deps.onView({
      kind: 'working',
      step,
      about: this.aboutOf(terms),
      ...(paying === undefined ? {} : { paying }),
      ...(cancellable ? { cancellable: true as const } : {}),
    });
  }

  private servable(payout: PricedPayout): boolean {
    const network = networkOf(payout);
    return railOf(payout) === 'tempo'
      ? this.deps.tempoFor?.(network) !== undefined
      : this.deps.rpcFor(network) !== undefined;
  }

  /** The record's own chain is reachable from here. */
  private recordServed(record: OrderRecord): boolean {
    return recordRail(record) === 'tempo'
      ? this.tempoOfRecord(record) !== undefined
      : this.rpcOfRecord(record) !== undefined;
  }

  private tempoOfRecord(record: OrderRecord): Eip1193Client | undefined {
    const network = this.networkOfRecord(record);
    return network === undefined ? undefined : this.deps.tempoFor?.(network);
  }

  private walletChoices(payout: PricedPayout): WalletChoice[] {
    const network = networkOf(payout);
    const options =
      railOf(payout) === 'tempo'
        ? (this.deps.tempoWallets?.(network) ?? [])
        : this.deps.wallets(network);
    return options.map((option) => ({
      name: option.name,
      ...(option.icon === undefined ? {} : { icon: option.icon }),
    }));
  }

  /**
   * Each load: every Tempo order of the product that ended `over` recently is
   * checked on its own chain, one after another - its prompt may have been
   * approved since. A payment found (or blocked) shows as a banner, and a paid
   * one holds the product again until the store answers.
   */
  private async reconcileEnded(records: readonly OrderRecord[]): Promise<void> {
    const now = this.deps.now();
    for (const record of records) {
      // Ended orders whose prompt may still be approved, and every paying Tempo
      // order whether or not it is the one shown: each is checked once per load.
      const eligible = mayStillBePaid(record, now) || record.state === 'paying';
      if (this.disposed || recordRail(record) !== 'tempo' || !eligible) {
        continue;
      }
      const client = this.tempoOfRecord(record);
      if (client === undefined) {
        continue;
      }
      try {
        const watched = await watchTempoPayment(record, this.tempoDeps(client));
        if (watched.state === 'paid' || watched.state === 'blocked') {
          this.banner(watched.record);
        } else if (watched.state === 'over') {
          // A paying order proven over (no hash, no pending call): it ends `over`.
          await endTempoOrder(watched.record, this.tempoDeps(client));
        }
      } catch {
        // Unreadable now: the next load checks again.
      }
    }
  }

  private banner(record: OrderRecord): void {
    const state = record.state;
    if (state !== 'paid' && state !== 'blocked' && state !== 'completed' && state !== 'refunded') {
      return;
    }
    const text = state === 'completed' ? (record.status?.delivery ?? '') : undefined;
    const link = text === undefined ? undefined : deliveryLink(text);
    this.deps.onBanner?.({
      orderId: record.orderId,
      state,
      ...(text === undefined ? {} : { text }),
      ...(link === undefined ? {} : { link }),
    });
  }

  /**
   * A new attempt for the same order, once the last one provably ended. Never
   * before: no wallet even opens while the attempt may still land (commerce's
   * `retryWithSolana` refuses one too).
   */
  async retry(walletName: string): Promise<void> {
    const record = this.record;
    if (
      this.busy ||
      this.pressing ||
      record === undefined ||
      this.followOnly !== undefined ||
      !this.attemptOver
    ) {
      return;
    }
    this.press += 1;
    const press = this.press;
    this.pressing = true;
    try {
      await this.retryPressed(record, walletName, press);
    } finally {
      if (this.press === press) {
        this.pressing = false;
      }
    }
  }

  private async retryPressed(
    record: OrderRecord,
    walletName: string,
    press: number,
  ): Promise<void> {
    this.lastWallet = walletName;
    this.lastAction = 'retry';
    if (this.lateHashHolds()) {
      return;
    }
    if (await this.deliveryFirst()) {
      return;
    }
    const network = this.networkOfRecord(record);
    if (network === undefined) {
      return;
    }
    await this.guard(press, async () => {
      this.retrying = true;
      try {
        await this.retryGuarded(record, walletName, network, press);
      } finally {
        if (this.press === press) {
          this.retrying = false;
        }
      }
    });
  }

  private async retryGuarded(
    record: OrderRecord,
    walletName: string,
    network: Network,
    press: number,
  ): Promise<void> {
    this.cancellableFor = press;
    this.working('checking', true);
    const answer = await this.connect(walletName, network);
    if (this.press !== press) {
      return;
    }
    this.cancellableFor = undefined;
    if ('error' in answer) {
      this.render({ problem: { reason: connectProblem(answer.error) } });
      return;
    }
    const wallet = answer.wallet;
    this.working('checking');
    const ready = await this.freshOffer();
    // The re-verification drew its own view (a changed or refused offer).
    if (ready === undefined) {
      return;
    }
    const rpc = this.deps.rpcFor(network);
    if (rpc === undefined) {
      this.render();
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
    this.working('signing');
    this.stopWatching();
    this.generation += 1;
    const result = await retryWithSolana(
      current,
      wallet,
      { fresh: ready, chainTime },
      this.payDeps(rpc),
    );
    await this.afterPay(result, rpc);
  }

  /** Leave an order that will not be paid (only once nothing can still land). */
  async startOver(): Promise<void> {
    const record = this.record;
    if (this.busy || record === undefined) {
      return;
    }
    // Not a press: it never runs beside one, so it keeps the current id.
    await this.guard(this.press, async () => {
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
    if (this.lateHash !== undefined) {
      this.deps.clearInterval(this.lateHash.timer);
      this.lateHash = undefined;
    }
    if (this.noAnswerTimer !== undefined) {
      this.deps.clearInterval(this.noAnswerTimer.handle);
      this.noAnswerTimer = undefined;
    }
    this.setRecord(undefined);
    for (const closer of this.background.values()) {
      closer.close();
    }
    this.background.clear();
    this.backgroundCreated.clear();
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Run one action at a time, owned by `press`: a press cancelled meanwhile
   * (its id no longer current) neither draws from its failure nor releases
   * the newer press's `busy`.
   */
  private async guard(press: number, run: () => Promise<void>): Promise<void> {
    // One action at a time: a caller that awaited before this point may find one running.
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.busyOwner = press;
    try {
      await run();
    } catch {
      if (this.press !== press) {
        return;
      }
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
      if (this.busyOwner === press) {
        this.busy = false;
        this.busyOwner = undefined;
        if (this.cancellableFor === press) {
          this.cancellableFor = undefined;
        }
        // The store answered the current order during the action: that answer shows.
        if (this.record !== undefined && isTerminal(this.record) && !this.refused) {
          this.render();
        }
        void this.showPendingAnswer();
      }
    }
  }

  /** End an order that holds nothing yet, or whose attempt provably ended on its own network. */
  private endOrder(record: OrderRecord): Promise<{ ended: boolean; record: OrderRecord }> {
    const tempo = recordRail(record) === 'tempo' ? this.tempoOfRecord(record) : undefined;
    return endOrder(record, {
      store: this.deps.store,
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
      now: this.deps.now,
      rpc: recordRail(record) === 'solana' ? this.rpcOfRecord(record) : undefined,
      ...(tempo === undefined ? {} : { tempo }),
    });
  }

  /** The network an order's chain work runs on: the order's own, never the offer's. */
  private networkOfRecord(record: OrderRecord): Network | undefined {
    return recordTarget(record)?.caip19.chain.network;
  }

  private rpcOfRecord(record: OrderRecord): Rpc<SolanaRpcApi> | undefined {
    const network = this.networkOfRecord(record);
    return network === undefined ? undefined : this.deps.rpcFor(network);
  }

  /**
   * Ask the wallet to connect. The wallet comes back to the press that asked:
   * nothing keeps it, so a late answer for a cancelled press reaches no one.
   */
  private async connect(walletName: string, network: Network): Promise<ConnectAnswer> {
    const option = this.deps.wallets(network).find((wallet) => wallet.name === walletName);
    if (option === undefined) {
      return { error: 'failed' };
    }
    try {
      return { wallet: await option.connect() };
    } catch (error) {
      return { error: walletErrorKind(error) };
    }
  }

  /** Chain time, or `undefined` when unreadable or slower than `CHAIN_TIME_TIMEOUT_MS`. */
  private readChainTime(rpc: Rpc<SolanaRpcApi>): Promise<number | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (time: number | undefined) => {
        if (!settled) {
          settled = true;
          resolve(time);
        }
      };
      const timer = this.deps.setTimeout(() => finish(undefined), CHAIN_TIME_TIMEOUT_MS);
      this.deps
        .chainTime(rpc)
        .then(
          (time) => finish(time),
          () => finish(undefined),
        )
        .finally(() => this.deps.clearTimeout(timer));
    });
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
    this.deps.onView({
      kind: 'refused',
      message,
      store: { name: this.offer.offer.profile.name },
      product: productOf(this.offer.offer.product),
    });
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
   * two minutes. A changed price or payout sends the buyer back to the offer;
   * a refusal ends the attempt. Warnings are no change: none is asked about.
   */
  private async freshOffer(): Promise<ReadyOffer | undefined> {
    if (!isSnapshotStale(this.offer.snapshotAt, this.deps.now())) {
      return this.offer;
    }
    const reloaded = await this.deps.reloadOffer();
    if (!reloaded.ok) {
      return this.refusedOnReload(reloaded.message);
    }
    // The fresh offer's own warnings are passed: only the payout and its amount decide.
    const verdict = compareOffers(this.payout, reloaded.confirm, reloaded);
    // The chosen payout is gone: only another one on the page's network replaces
    // it, never one on another network. None: refused, exactly as above.
    const fallback = this.payablePayouts(reloaded)[0];
    if (verdict === 'gone' && fallback === undefined) {
      return this.refusedOnReload(NO_PAYABLE_PAYOUT);
    }
    this.offer = reloaded;
    this.refusedHere = undefined;
    if (verdict === 'same') {
      return reloaded;
    }
    const kept = reloaded.payouts.find((payout) => samePayout(payout, this.payout));
    const payout = kept ?? fallback;
    if (payout !== undefined) {
      this.payout = payout;
    }
    const live = this.record;
    if (live !== undefined && live.state !== 'created' && live.state !== 'ordered') {
      // The attempt on screen stays followed: the change shows where it is retried.
      this.render({ problem: { reason: 'offer_changed' } });
    } else {
      this.showOffer({ reason: 'offer_changed' });
    }
    return undefined;
  }

  /** The re-verification refused: a live order is still followed, else the widget refuses. */
  private refusedOnReload(message: string): undefined {
    // The store no longer accepts this page: its trust level is not shown again.
    this.refusedHere = message;
    const live = this.record;
    if (live !== undefined && live.state !== 'created' && live.state !== 'ordered') {
      // No new payment, but the order that is paying or paid is still followed.
      this.render({ problem: { reason: 'offer_refused' } });
      return undefined;
    }
    this.setRecord(undefined);
    this.refuse(message);
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
      this.noteOver(record);
      this.setRecord(undefined);
      record = undefined;
    }
    const stale = record !== undefined && onOtherTerms(record, this.payout);
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
      this.working('ordering');
      const resumed = await resumeOrder(record, this.orderDeps(), this.deps.now());
      record = resumed.record;
      this.relays = resumed.relays;
    }
    if (record === undefined) {
      // The one place both rails decide on a new order: never one with an unusable email.
      if (this.emailUnusable()) {
        this.showOffer({ reason: 'bad_email' });
        return undefined;
      }
      this.working('ordering');
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
        // Sent with it whether or not the store took it yet: a resume sends the same order.
        if (email !== undefined) {
          this.sentEmail.set(placed.record.orderId, email);
        }
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
    // A Tempo request is composed at the pay press (after the checks), in the core.
    if (recordRail(record) === 'tempo') {
      this.listen(record);
      return record;
    }
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
      case 'rejected':
        // The buyer declined: nothing was signed and the attempt was released, so the
        // same order is paid anew at once (follow also shows a store's cancellation).
        this.attemptProblem = undefined;
        this.attemptOver = false;
        if (result.record !== undefined) {
          await this.follow(result.record, undefined, { reason: 'rejected' });
        } else {
          this.showOffer({ reason: 'rejected' });
        }
        return;
      case 'wallet_failed':
      case 'wallet_unsupported':
        // Only an explicit decline proves nothing was signed: the attempt waits for expiry.
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
      case 'needs_confirmation':
        await this.askOldPrompt(result.unconfirmed ?? []);
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
      this.retryEstimate = undefined;
    }
    this.record = record;
  }

  /** Follow a record to its screen, starting the watch, the listener and the republishing it needs. */
  private async follow(record: OrderRecord, relays?: string[], problem?: Problem): Promise<void> {
    // Ended in another tab with nothing found: the product is free again.
    if (gone(record)) {
      this.adoptLateHash(record);
      this.noteOver(record);
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
      this.deps.onView({
        kind: 'cancelled',
        store: this.storeInfo(),
        product: productOf(record.offer.product),
      });
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
      this.adoptLateHash(record);
      this.noteOver(record);
      const relays = this.relays;
      this.setRecord(undefined);
      this.listenToEnded([record], relays);
      this.showOffer(extra.problem);
      void this.showPendingAnswer();
      return;
    }
    if (record === undefined || record.state === 'created' || record.state === 'ordered') {
      if (record !== undefined && cancelledUnpaid(record)) {
        this.deps.onView({
          kind: 'cancelled',
          store: this.storeInfo(),
          product: productOf(record.offer.product),
        });
        return;
      }
      this.showOffer(extra.problem);
      return;
    }
    const target = recordTarget(record);
    const network = target?.caip19.chain.network ?? networkOf(this.payout);
    const status = record.status;
    const paying = recordPaying(record);
    const store = this.storeInfo();
    const product = productOf(record.offer.product);
    if (record.state === 'completed') {
      const text = status?.delivery ?? '';
      const link = deliveryLink(text);
      this.deps.onView({
        kind: 'delivered',
        text,
        ...(link === undefined ? {} : { link }),
        store,
        product,
        receipt: this.receiptOf(record, network),
      });
      return;
    }
    if (record.state === 'refunded') {
      this.deps.onView({
        kind: 'refunded',
        store,
        product,
        receipt: this.receiptOf(record, network),
      });
      return;
    }
    const about = this.aboutOf(record);
    if (record.state === 'paid' || record.paidTx !== undefined) {
      if (status === undefined) {
        this.redrawAtNoAnswer(record);
      }
      this.deps.onView({
        kind: 'waiting_store',
        ...(paying === undefined ? {} : { paying }),
        about,
        cancelled: status?.status === 'cancelled',
        noAnswer:
          status === undefined &&
          this.deps.now() - (record.paidAt ?? this.loadedAt) > NO_ANSWER_AFTER_SECS,
        ...(record.paidTx === undefined
          ? {}
          : { explorer: explorerFor(record, record.paidTx, network) }),
      });
      return;
    }
    if (record.state === 'blocked') {
      this.deps.onView({ kind: 'blocked', store, product });
      return;
    }
    // The store cancelled and the attempt is over: only a new order is left.
    if (this.attemptOver && status?.status === 'cancelled') {
      this.deps.onView({ kind: 'cancelled', store, product });
      return;
    }
    const marker = record.marker;
    const tempo = recordRail(record) === 'tempo';
    let signature: string | undefined;
    let signed = false;
    if (marker?.rail === 'solana') {
      signature = marker.signature;
      signed = marker.signature !== undefined;
    } else if (marker?.rail === 'tempo') {
      const pending =
        this.pendingHash?.orderId === record.orderId ? this.pendingHash.hash : undefined;
      signature = marker.txHash ?? pending;
      signed =
        marker.txHash !== undefined || marker.bundleId !== undefined || pending !== undefined;
    }
    // A refusal by the store stays explained on every redraw while the order lives.
    const refused: Problem | undefined =
      this.refusedHere === undefined ? undefined : { reason: 'offer_refused' };
    const problem = extra.problem ?? this.attemptProblem ?? refused;
    const retryIn = this.retryCountdown(record);
    const requestEndsIn = tempo && !signed ? this.requestCountdown(record) : undefined;
    this.deps.onView({
      kind: 'waiting_payment',
      ...(paying === undefined ? {} : { paying }),
      about,
      asset: target?.caip19.asset ?? this.payout.target.caip19.asset,
      tempo,
      // Follow-only never pays: no retry is offered (start over is). Tempo has no retry.
      canRetry: this.attemptOver && !tempo,
      wallets:
        this.attemptOver && !tempo && this.followOnly === undefined && target !== undefined
          ? this.deps.wallets(network).map((option) => ({
              name: option.name,
              ...(option.icon === undefined ? {} : { icon: option.icon }),
            }))
          : [],
      signed,
      followOnly: this.followOnly !== undefined,
      unserved: !this.recordServed(record),
      ...(this.attemptOver || marker === undefined
        ? {}
        : { unsureAt: marker.setAt + UNSURE_AFTER_SECS }),
      ...(retryIn === undefined ? {} : { retryIn }),
      ...(requestEndsIn === undefined ? {} : { requestEndsIn }),
      ...(signature === undefined ? {} : { explorer: explorerFor(record, signature, network) }),
      ...(problem === undefined ? {} : { problem }),
    });
  }

  /** The live Solana attempt's estimate, while it may still land and is the one estimated. */
  private retryCountdown(record: OrderRecord): Countdown | undefined {
    const estimate = this.retryEstimate;
    const marker = record.marker;
    if (
      this.attemptOver ||
      estimate === undefined ||
      marker?.rail !== 'solana' ||
      marker.attemptId !== estimate.attemptId
    ) {
      return undefined;
    }
    return { seconds: estimate.seconds, at: estimate.at };
  }

  /** A Tempo request not answered yet: about when the checkout stops waiting for it. */
  private requestCountdown(record: OrderRecord): Countdown | undefined {
    const request = storedTempoRequest(record);
    if (request === undefined) {
      return undefined;
    }
    const now = this.deps.now();
    return { seconds: Math.max(0, tempoLateDeadline(request) - now), at: now };
  }

  /**
   * Read the finalized block height for the live Solana attempt's estimate:
   * outside the watch pass, bounded, never drawing; the next pass shows it. A
   * failed read keeps the last estimate; one that reached 0 is never read again.
   */
  private readRetryEstimate(record: OrderRecord, generation: number): void {
    const marker = record.marker;
    const rpc = this.rpcOfRecord(record);
    if (marker?.rail !== 'solana' || rpc === undefined || this.attemptOver) {
      return;
    }
    const known = this.retryEstimate;
    if (known?.attemptId === marker.attemptId && known.latched) {
      return;
    }
    let lastValid: bigint;
    try {
      lastValid = BigInt(marker.lastValidBlockHeight);
    } catch {
      return;
    }
    const attemptId = marker.attemptId;
    void rpc
      .getEpochInfo({ commitment: 'finalized' })
      .send({ abortSignal: AbortSignal.timeout(EPOCH_READ_TIMEOUT_MS) })
      .then((epoch) => {
        if (
          this.disposed ||
          generation !== this.generation ||
          this.record?.marker?.attemptId !== attemptId
        ) {
          return;
        }
        const left = lastValid + RETRY_SETTLE_BLOCKS - BigInt(epoch.blockHeight);
        const blocksLeft = left > 0n ? Number(left) : 0;
        const at = this.deps.now();
        let seconds = Math.ceil(blocksLeft * SLOT_SECS_ESTIMATE);
        // Skipped slots make blocks slower than the estimate: never count back up,
        // or the line would flip between "checking" and "waiting".
        const earlier = this.retryEstimate;
        if (earlier?.attemptId === attemptId) {
          seconds = Math.min(seconds, Math.max(0, earlier.seconds - (at - earlier.at)));
        }
        this.retryEstimate = { attemptId, seconds, at, latched: blocksLeft === 0 };
      })
      .catch(() => {
        // Unread now: the last estimate stays, counted down from its own time.
      });
  }

  private showOffer(problem?: Problem): void {
    // The old-prompt question is no longer on screen: the next wallet press asks
    // it again (commerce answers `needs_confirmation` until it is confirmed).
    this.oldPrompt = undefined;
    if (this.refusedHere !== undefined) {
      // The store refused this page while an order was still live; that order
      // has ended, so the refusal shows now instead of a new purchase.
      this.refuse(this.refusedHere);
      return;
    }
    if (this.followOnly !== undefined) {
      this.deps.onView({
        kind: 'refused',
        message: this.followOnly.message,
        store: { name: this.offer.offer.profile.name },
        product: productOf(this.offer.offer.product),
      });
      this.status('refused');
      return;
    }
    const payouts = this.payablePayouts();
    let payoutIndex = payouts.findIndex((payout) => samePayout(payout, this.payout));
    let shown = problem;
    const substitute = payouts[0];
    if (payoutIndex === -1 && substitute !== undefined) {
      // Never reached (the payout always comes from that list): if it ever is, the
      // buyer reviews the payout now selected - never a quiet switch.
      this.payout = substitute;
      payoutIndex = 0;
      shown = { reason: 'offer_changed' };
    }
    this.offerProblem = shown;
    this.deps.onView({
      kind: 'offer',
      offer: this.offer,
      payout: this.payout,
      payouts,
      payoutIndex,
      wallets: this.walletChoices(this.payout),
      continuing: this.continuing(),
      askEmail: this.deps.collectEmail === true,
      email: this.email,
      ...(shown === undefined ? {} : { problem: shown }),
    });
    if (this.record === undefined) {
      this.status('ready');
    }
  }

  /** The open order a pay press continues on its own terms, if any (its email went with it). */
  private continuing(): false | 'created' | 'ordered' {
    const record = this.record;
    if (record === undefined || onOtherTerms(record, this.payout)) {
      return false;
    }
    return record.state === 'created' || record.state === 'ordered' ? record.state : false;
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
      const served = record !== undefined && this.recordServed(record);
      // One tick at a time, never during an action, never for an older record or attempt.
      if (this.watching || this.busy || record === undefined || !served) {
        return;
      }
      if (generation !== this.generation) {
        if (this.watchGeneration === generation) {
          this.stopWatching();
        }
        return;
      }
      try {
        this.readRetryEstimate(record, generation);
      } catch {
        // An estimate only: it never stops the watch.
      }
      this.watching = true;
      try {
        const current = await this.deps.store.get(record.orderId);
        if (current === undefined) {
          return;
        }
        const watched = await this.watchOnce(current);
        if (watched === undefined) {
          return;
        }
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
          // The attempt was cleared (nothing was requested, or the buyer declined in
          // another tab): back to the offer, and the page hears the order is open again.
          this.stopWatching();
          this.attemptOver = false;
          const reopened = stateOf(this.record);
          if (reopened !== undefined && reopened !== 'ended') {
            this.status(reopened);
          }
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
        } else if (watched.state === 'over' && recordRail(watched.record) === 'tempo') {
          // A Tempo attempt proven over ends at once (no retry): its prompt stays open,
          // so the next payment of the product asks for confirmation first.
          this.stopWatching();
          const client = this.tempoOfRecord(watched.record);
          const ended =
            client === undefined
              ? undefined
              : await endTempoOrder(watched.record, this.tempoDeps(client));
          if (ended?.ended === true && generation === this.generation && !this.busy) {
            this.setRecord(undefined);
            this.listenToEnded([ended.record]);
            this.status('ended');
            this.showOffer({ reason: 'attempt_over' });
            void this.showPendingAnswer();
          } else if (generation === this.generation && !this.disposed) {
            // Not ended (a lost write, a read that answered otherwise): keep watching.
            this.render();
            this.watch();
          }
        } else if (watched.state === 'over') {
          this.stopWatching();
          this.attemptProblem = undefined;
          this.attemptOver = true;
          this.noteOver(watched.record);
          this.render();
          // The attempt provably ended: a delivery already heard now shows.
          void this.showPendingAnswer();
        } else if (watched.state === 'blocked') {
          this.stopWatching();
          this.render();
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

  /** One watch pass on the record's own rail. */
  private async watchOnce(
    current: OrderRecord,
  ): Promise<
    | Awaited<ReturnType<typeof watchSolanaPayment>>
    | Awaited<ReturnType<typeof watchTempoPayment>>
    | undefined
  > {
    if (recordRail(current) === 'tempo') {
      const client = this.tempoOfRecord(current);
      if (client === undefined) {
        return undefined;
      }
      const pending =
        this.pendingHash?.orderId === current.orderId ? this.pendingHash.hash : undefined;
      const watched = await watchTempoPayment(current, this.tempoDeps(client), {
        ...(pending === undefined ? {} : { pendingHash: pending }),
      });
      const stored =
        watched.record.marker?.rail === 'tempo' ? watched.record.marker.txHash : undefined;
      if (pending !== undefined && stored === pending) {
        this.pendingHash = undefined;
      }
      return watched;
    }
    const rpc = this.rpcOfRecord(current);
    return rpc === undefined ? undefined : await watchSolanaPayment(current, this.payDeps(rpc));
  }

  /** Redraw once the "no answer from the store" moment passes, while this record is shown. */
  private redrawAtNoAnswer(record: OrderRecord): void {
    if (this.noAnswerTimer?.orderId === record.orderId || this.disposed) {
      return;
    }
    if (this.noAnswerTimer !== undefined) {
      this.deps.clearInterval(this.noAnswerTimer.handle);
    }
    const dueIn = (record.paidAt ?? this.loadedAt) + NO_ANSWER_AFTER_SECS - this.deps.now();
    if (dueIn < 0) {
      this.noAnswerTimer = { orderId: record.orderId, handle: undefined };
      return;
    }
    const handle = this.deps.setInterval(
      () => {
        this.deps.clearInterval(handle);
        if (this.record?.orderId === record.orderId && !this.busy) {
          this.render();
        }
      },
      dueIn * 1000 + 1000,
    );
    this.noAnswerTimer = { orderId: record.orderId, handle };
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
    for (const record of records) {
      if (gone(record)) {
        this.noteOver(record);
      }
    }
    const ended = records
      .filter((record) => gone(record) && !this.background.has(record.orderId))
      .sort((left, right) => right.createdAt - left.createdAt);
    const now = this.deps.now();
    for (const record of ended) {
      if (this.disposed) {
        return;
      }
      // A Tempo order whose prompt may still be approved always listens (the cap is for the rest).
      const openPrompt = recordRail(record) === 'tempo' && mayStillBePaid(record, now);
      if (!openPrompt && this.background.size >= MAX_ENDED_LISTENERS) {
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
            // Never held: a Tempo order's answer shows at once, whatever is on screen.
            if (recordRail(updated) === 'tempo') {
              this.banner(updated);
            }
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
        const ended = this.recordServed(live) ? await this.endOrder(live) : undefined;
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
    if (this.noAnswerTimer !== undefined) {
      this.deps.clearInterval(this.noAnswerTimer.handle);
      this.noAnswerTimer = undefined;
    }
    if (this.republishTimer !== undefined) {
      this.deps.clearInterval(this.republishTimer);
      this.republishTimer = undefined;
    }
    this.listening?.closer.close();
    this.listening = undefined;
    this.relays = [];
  }
}
