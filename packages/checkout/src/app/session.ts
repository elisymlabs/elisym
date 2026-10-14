import {
  KIND_GIFT_WRAP,
  MAX_FUTURE_SKEW_SECS,
  type Product,
  type TrustLevel,
} from '@elisym/commerce';
import {
  type FeeTermsSource,
  type LoadedOffer,
  type PricedPayout,
  isSnapshotStale,
  planFee,
} from '@elisym/commerce/buyer';
import {
  type OrderDeps,
  applyStatus,
  clockAgrees,
  compareOffers,
  listenForStatus,
  placeOrder,
  resumeOrder,
  statusFor,
  WRAP_BACKDATE_SECS,
} from '@elisym/commerce/buyer';
import {
  type OrderRecord,
  cancelledUnpaid,
  endOrder,
  gone,
  holdsPayExclusion,
  isTerminal,
  onOtherTerms,
  recordToShow,
} from '@elisym/commerce/buyer';
import {
  type OrderStore,
  type StoreWrite,
  STORE_WRITE_ATTEMPTS,
  storeClosed,
} from '@elisym/commerce/buyer';
import {
  type ComposeOrderPaymentResult,
  type SolanaPayResult,
  type SolanaSignAgain,
  type SolanaWallet,
  composeOrderPayment,
  endSolanaOrder,
  payWithSolana,
  retryWithSolana,
  signAgainWithSolana,
  watchSolanaPayment,
} from '@elisym/commerce/buyer';
import {
  type TempoBundleStep,
  type TempoPayDeps,
  type TempoPayResult,
  type TempoWallet,
  type TempoWatchOptions,
  endTempoOrder,
  followTempoBundle,
  tempoWalletCanBatch,
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
import { hexToBytes } from 'nostr-tools/utils';
import type { CheckoutState } from '../embed/protocol';
import type { FollowOnly, RefusedReason } from './controller';
import { type TempoWalletOption, TempoChainUnsupported, walletErrorKind } from './evm-wallets';
import { type Purchase, purchaseOf, purchasesOf } from './history';
import {
  explorerFor,
  receiptBase,
  recordNetwork,
  recordPaying,
  recordRail,
  recordTarget,
} from './receipts';
import { REF_NEEDS_VERIFIED_STORE, sameRef } from './ref-scope';

export { explorerLink } from './receipts';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

/** How often a live attempt is reconciled against the chain. */
export const WATCH_EVERY_MS = 5_000;
/** How often the signed order and receipt are published again while no status came. */
export const REPUBLISH_EVERY_MS = 3 * 60_000;
/** An attempt still unsure this long after it was made: say "contact the store". */
export const UNSURE_AFTER_SECS = 10 * 60;
/** At most this many of the product's ended orders keep listening for a late completion. */
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
/** An unknown answer about a sent transaction is asked again this many times at most. */
export const TX_RECHECKS = 3;
/**
 * A resumed order the store took only now is read for a store answer held for it
 * (a hand cancel or refund) before it is paid, for at most this long.
 */
export const HELD_STATUS_READ_MS = 2_000;
/**
 * A press waits at most this long for an order placement still in flight (a
 * press detached by a close) before it reads the open orders: the placement's
 * own bounds, commerce's `RELAY_QUERY_DEADLINE_MS` inbox read plus its
 * `RELAY_PUBLISH_DEADLINE_MS` publish.
 */
export const PLACING_WAIT_MS = 35_000;

/**
 * What the chain says of a sent transaction. `succeeded` and `failed` are
 * final (confirmed or finalized); anything else - not found, only processed,
 * an error, a timeout, no RPC - is `unknown`, never read as "not paid".
 */
export type TxVerdict = 'succeeded' | 'failed' | 'unknown';

/** A sent transaction's check: running, final, or unknown after `attempts` look-ups. */
type TxCheck = 'pending' | boolean | { kind: 'unknown'; attempts: number };

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
  /** `declined`: the buyer declined an again request; the attempt stays live. */
  | { reason: 'wallet_failed'; declined?: true }
  | { reason: 'wallet_unsupported' }
  /** The wallet asked again is on another account than the attempt's: `payer`, in full. */
  | { reason: 'other_payer'; payer: string }
  /** The buyer declined the again request's connect: the attempt stays live. */
  | { reason: 'again_declined' }
  | { reason: 'policy_blocked' | 'wrong_chain' | 'rejected' | 'attempt_over' | 'late_approval' }
  | { reason: 'offer_changed' | 'offer_refused' }
  /**
   * The protocol fee is above 0 and the store's payment node cannot take a
   * fee-split payment yet: nothing was ordered or paid (an order on screen ended).
   */
  | { reason: 'store_outdated' }
  /** The payment carries a fee leg and this wallet cannot send both in one batch: another wallet can. */
  | { reason: 'wallet_cannot_batch' }
  /** The fee terms could not be read now: nothing was paid, try again. */
  | { reason: 'fee_config_unavailable' }
  /** elisym's fee configuration cannot be used right now (no retry wording). */
  | { reason: 'fee_config_invalid' }
  /** The wallet reported the batched payment failed: it was not made. */
  | { reason: 'wallet_payment_failed' }
  /** The store stopped selling the product while an order of it is followed. */
  | { reason: 'sold_out' }
  /** Another account's purchase of this product holds it in this browser: try later. */
  | { reason: 'other_purchase' }
  /**
   * The buyer's own earlier payment of this product may still land (or landed and
   * waits for the store): this press asked the wallet nothing.
   */
  | EarlierPayment
  | { reason: 'insufficient_token' | 'insufficient_sol'; needed: bigint; available: bigint };

/** Why a press found an earlier payment of this product in this browser, and when to try again. */
export interface EarlierPayment {
  reason: 'earlier_payment';
  /**
   * `confirming`: an attempt may still land; `tempo_request`: a Tempo request
   * not approved yet is open in the wallet; `waiting_store`: it was paid.
   */
  phase: 'confirming' | 'tempo_request' | 'waiting_store';
  /** `waiting_store`: the store cancelled the paid order (no refund stated). */
  cancelled?: boolean;
  /** About when a press may proceed (the holder's own attempt). */
  retryIn?: Countdown;
  /**
   * The holder's approved bundle could not be asked about through its wallet
   * without a connection: "Check in wallet" connects it and asks.
   */
  checkWallet?: true;
}

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
  /** When the order was placed (seconds, the order's own time): "Ordered on" of an open purchase. */
  orderedAt?: number;
  /** Set only on the history's receipt of a purchase not finished yet: its `Status:` line. */
  openStatus?: OpenStatus;
}

/** Where a purchase that is not completed or refunded stands. */
export type OpenStatus = 'waiting_store' | 'paying' | 'blocked' | 'cancelled_paid';

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
      /** Signing: about when the unanswered request can be judged over (Start over then). */
      startOverIn?: Countdown;
      /** Signing: after this (unix seconds), with no countdown left, it is taking long. */
      unsureAt?: number;
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
      /** Solana: the wallet that failed this attempt may be asked again, at once. */
      again?: { wallet: string };
      /** Solana: the attempt's request is about to expire: it is not asked again. */
      expiring?: true;
      /** Solana: a transaction for this order reached the network: the watch decides. */
      seenOnChain?: true;
      /** Solana: the wallet's last answer for this attempt was not sent. */
      signedNotSent?: true;
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
  /** The store completed the order (the name stays from when it delivered). */
  | {
      kind: 'delivered';
      store?: StoreInfo;
      product?: About['product'];
      receipt?: Receipt;
    }
  | { kind: 'refunded'; store?: StoreInfo; product?: About['product']; receipt?: Receipt }
  | {
      kind: 'refused';
      reason: RefusedReason;
      message: string;
      store?: StoreInfo;
      product?: About['product'];
    };

export interface SessionDeps {
  store: OrderStore;
  readClient: OrderDeps['readClient'];
  clientFor: OrderDeps['clientFor'];
  /** The widget's RPC for a network, or `undefined` when none is configured. */
  rpcFor(network: Network): Rpc<SolanaRpcApi> | undefined;
  /** The protocol fee terms of a chain (CAIP-2), read fresh: see `planFee`. */
  feeTerms: FeeTermsSource;
  /**
   * The EIP-6963 wallet named `rdns`, asked only for a bundle's status (no
   * connect, no prompt): how an approved bundle is observed after a reload.
   */
  bundleWallet?(rdns: string | undefined): Pick<TempoWallet, 'callsStatus'> | undefined;
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
  /**
   * The page's account (v3 `customer-ref`), already checked: a level-A store on
   * this page's domain, in the top window. Orders of other accounts are never
   * shown, resumed or reported here; they are only resolved in the background.
   */
  customerRef?: string;
  /** Tempo: a read RPC of a Tempo network, or `undefined` when none is configured. */
  tempoFor?(network: Network): Eip1193Client | undefined;
  /** Tempo: wallets (EIP-6963) that can pay on this Tempo network. */
  tempoWallets?(network: Network): TempoWalletOption[];
  /** Tempo chain time (seconds): the finalized head. */
  tempoChainTime?(client: Eip1193Client): Promise<number>;
  /**
   * A store answer (or a late payment found) for an order not on screen: shown
   * at once as a banner, never held back by the order that is. `undefined`
   * clears it: the modal closed and opens again at its first step.
   */
  onBanner?(banner: Banner | undefined): void;
  /**
   * The offer is refused now, but the product has an order to follow (paid,
   * paying, delivered, or ended and still heard): no new payment, this message
   * where the offer would be.
   */
  followOnly?: FollowOnly;
  /** Every order record of this browser (on this site), read only: "Your purchases". */
  readAll?(): Promise<OrderRecord[]>;
}

/** A late answer or find for an order that is not on screen. */
export interface Banner {
  orderId: string;
  state: 'paid' | 'blocked' | 'completed' | 'refunded';
}

/** At most this long, and shaped like an address; anything else is not sent. */
const MAX_EMAIL_LENGTH = 254;

/** The email to send with the order, or `undefined` for none or a malformed one. */
export function usableEmail(value: string): string | undefined {
  const email = value.trim();
  return email.length <= MAX_EMAIL_LENGTH && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(email)
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

const NO_NETWORK = 'This network is not available here yet.';
/** The reloaded offer has no payout this widget can pay on the page's network. */
const NO_PAYABLE_PAYOUT = 'This product cannot be paid here';

function samePayout(left: PricedPayout, right: PricedPayout): boolean {
  return (
    left.target.caip19.id === right.target.caip19.id && left.target.address === right.target.address
  );
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

/**
 * A Solana signature status as a verdict: final only when confirmed or
 * finalized; a processed status, with or without an error, proves nothing.
 */
export function solanaVerdict(
  status: { err: unknown; confirmationStatus?: string | null } | null | undefined,
): TxVerdict {
  if (status === null || status === undefined) {
    return 'unknown';
  }
  const final =
    status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  if (!final) {
    return 'unknown';
  }
  return status.err === null ? 'succeeded' : 'failed';
}

/** A receipt with the transaction this checkout sent, once its chain check succeeded. */
function withSent(record: OrderRecord, base: Receipt, tx: string, network: Network): Receipt {
  const explorer = explorerFor(record, tx, network);
  return { ...base, sent: { tx, ...(explorer.startsWith('https://') ? { explorer } : {}) } };
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

/** What a follow-only session shows instead of an offer, and the one order it follows. */
interface FollowOnlyState {
  reason: RefusedReason;
  message: string;
  orderId?: string;
}

/** An open unpaid order this checkout may still pay: placed or acknowledged, no attempt, not cancelled. */
function continuedUnpaid(record: OrderRecord): boolean {
  return (
    (record.state === 'created' || record.state === 'ordered') &&
    record.marker === undefined &&
    !cancelledUnpaid(record)
  );
}

/**
 * An order followed in the background while not on screen: one that holds the
 * product (an attempt that may land, a payment waiting for the store), and a
 * blocked payment whose store answer (a refund) must still be stored.
 */
function followable(record: OrderRecord): boolean {
  return !isTerminal(record) && (holdsPayExclusion(record) || record.state === 'blocked');
}

/** Whole seconds until an attempt's blockhash is settled past its last valid height. */
function settleSeconds(lastValid: bigint, height: bigint): { seconds: number; blocksLeft: number } {
  const left = lastValid + RETRY_SETTLE_BLOCKS - height;
  const blocksLeft = left > 0n ? Number(left) : 0;
  return { seconds: Math.ceil(blocksLeft * SLOT_SECS_ESTIMATE), blocksLeft };
}

/** A press's own identity, for the store writes it makes: its id, and the close count it began at. */
interface PressScope {
  press: number;
  resets: number;
}

/** A bundle this session knows of, and the wallet to ask about it. */
interface BundleHold {
  orderId: string;
  bundleId: string;
  wallet: Pick<TempoWallet, 'callsStatus'>;
}

/** The chain id as EIP-1193 wants it (`0x...`). */
function chainIdHex(payout: PricedPayout): string {
  return `0x${(payout.target.caip19.chain.evmChainId ?? 0).toString(16)}`;
}

/** One watch pass's verdict, on either rail. */
type Watched =
  | Awaited<ReturnType<typeof watchSolanaPayment>>
  | Awaited<ReturnType<typeof watchTempoPayment>>;

/** The verdict of one watch pass, as `applyVerdict` applied it. */
type VerdictApplied =
  /** A payment found (`paid`) or blocked: drawn; a caller outside the watch follows it. */
  | 'follow'
  /** Another tab replaced the attempt during the pass: drawn, and nothing else follows it. */
  | 'replaced'
  /** Drawn: an attempt proven over, or cleared. */
  | 'drawn'
  /** Not applied: stale, terminal, or not ended. */
  | 'skipped';

/** The unanswered-wallet probe of one signing press. */
interface Probe {
  press: number;
  orderId: string;
  generation: number;
  /** `resets` when the probe started: a close since then drops what it would draw. */
  resets: number;
  timer: unknown;
  ticking: boolean;
  /** The countdown drawn last, so an unchanged one is not drawn again. */
  drawn: string;
}

/** A background follower: another account's holder, or this account's order not on screen. */
interface Follower {
  /** The rail tick, while the order holds the product (`undefined` once stopped). */
  timer: unknown;
  listener: { close(): void };
  /** This account's own order: republished, its relays followed. */
  republish: unknown;
  relays: string[];
  ticking: boolean;
}

/**
 * One product's purchase in the widget: it resumes whatever record of the
 * product is open, and drives a new one from the offer to its completion. Every
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
  /**
   * Why the live attempt may not have gone out (the wallet failed): kept until it
   * ends, and shown only while the attempt on screen is the one it was set for.
   */
  private attemptProblem: { problem: Problem; attemptId: string | undefined } | undefined;
  /** The Solana wallet that failed the live attempt, which may be asked again: its handle. */
  private againOffer: { handle: SolanaSignAgain; walletName: string } | undefined;
  /** What the answers about one Solana attempt said, for its status line and the again button. */
  private againFlags:
    | { attemptId: string; expiring?: true; seenOnChain?: true; signedNotSent?: true }
    | undefined;
  private email = '';
  private lastStatus: CheckoutState | undefined;
  /** The current attempt provably ended with no payment (a retry is offered). */
  private attemptOver = false;
  /** The widget refused (no RPC, the offer refused): nothing redraws an offer over it. */
  private refused = false;
  /** The generation the running watch timer belongs to. */
  private watchGeneration = -1;
  /** Never pays, only follows this order (the offer was refused, or its network is not served). */
  private followOnly: FollowOnlyState | undefined;
  /** The problem last shown on the offer, kept across a redraw. */
  private offerProblem: Problem | undefined;
  /** Listeners on the product's orders that ended unpaid: a completion for one still shows. */
  private readonly background = new Map<string, { close(): void }>();
  /** When each background-heard order was placed (the cap keeps the newest). */
  private readonly backgroundCreated = new Map<string, number>();
  /** The background-heard orders of another account (the cap drops them first). */
  private readonly backgroundOther = new Set<string>();
  /** Completions or refunds heard for ended orders, shown once nothing live is on screen. */
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
  /**
   * A bundle id returned in this session that could not be stored on the marker:
   * it holds the order like a stored bundle (`pendingBundleId`) and is asked
   * about through its wallet on every pass, until a hash or the wallet's "failed".
   * It outlives a close, as `pendingHash` does.
   */
  private pendingBundle: BundleHold | undefined;
  /** The stored bundle of the order on screen, asked about on the foreground watch only. */
  private bundleFollow: BundleHold | undefined;
  /** A bundle approved for an order another tab ended meanwhile: followed until it resolves. */
  private lateBundle: (BundleHold & { timer: unknown }) | undefined;
  /** The wallet each order's bundle was approved in (this session's press or "Check in wallet"). */
  private readonly bundleWallets = new Map<string, Pick<TempoWallet, 'callsStatus'>>();
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
  /** The on-chain look-up of each such transaction, by order and transaction: only final answers stay. */
  private readonly txChecks = new Map<string, TxCheck>();
  /** That look-up's own promise, by the same key: a receipt opened later awaits it, never a second one. */
  private readonly txLookups = new Map<string, Promise<boolean>>();
  /** The one re-check timer of an unknown answer, by the same key (only while its order is on screen). */
  private readonly txRechecks = new Map<string, unknown>();
  /**
   * Why a re-check refused this page, while an order kept it from ending: the
   * trust level is no longer shown, and no new purchase is offered.
   */
  private refusedHere: { reason: RefusedReason; message: string } | undefined;
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
  /** The page's account, if the page named one (see `SessionDeps.customerRef`). */
  private readonly customerRef: string | undefined;
  /**
   * Silent followers of other accounts' orders that hold the product in this
   * browser: they resolve them (store answers, watch verdicts) and show nothing.
   */
  private readonly followers = new Map<string, Follower>();
  /** The background republishing of an open order drawn at load: a press waits for it. */
  private resuming: Promise<void> | undefined;
  /** An order placement in flight (its press may be detached since): a press waits for it. */
  private placing: Promise<unknown> | undefined;
  /** A follower saw the product freed while a press was running: the press's end redraws. */
  private exclusionFreed = false;
  /** The offer on screen carries a note that clears once a holder frees the product. */
  private noteShown = false;
  /** The order of this account the earlier-payment line on screen names. */
  private lineHolder: string | undefined;
  /** Bumped by every close of the modal: an action that captured an older value draws nothing. */
  private resets = 0;
  /** `start` drew its first view: a close before that changes nothing. */
  private started = false;
  /**
   * This account's orders whose outcome is stored only: followed in the
   * background after a close or a load, never posted, drawn or shown as a banner.
   */
  private readonly quiet = new Set<string>();
  /**
   * The current record continued without the buyer engaging with it (at load,
   * or kept on a close): its store answer that finishes it is stored only.
   */
  private silent: string | undefined;
  /** That answer landed while a press ran: the press drops the record where it ends or re-reads. */
  private silentAnswered: string | undefined;
  /** The record of the last marker write through a press's store (the newest known copy). */
  private marked: OrderRecord | undefined;
  /** The probe of a press whose wallet has not answered. */
  private unanswered: Probe | undefined;
  /** The view drawn last. */
  private shownView: View | undefined;

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
    this.customerRef = deps.customerRef;
  }

  /**
   * The first step: the offer (or the open unpaid order continued silently
   * behind it), drawn right after the local read. Every order of this account
   * in progress is followed in the background, never shown: it is under "Your
   * purchases", and a press for the product waits while it may still land. A
   * follow-only page shows exactly the order it follows.
   */
  async start(): Promise<void> {
    // Two sets: every record is listened to, reconciled and resolved; only the
    // page's own account's records are shown, resumed or followed.
    const allRecords = await this.deps.store.forProduct(this.offer.productAddress);
    const records = allRecords.filter((record) => this.own(record));
    if (this.followOnly === undefined && !this.servable(this.payout)) {
      // No new payment on this network. An order paid or paying on a served one is
      // still followed, and orders that ended unpaid are still heard.
      const stillFollowed = recordToShow(
        records.filter(
          (record) =>
            record.state !== 'created' &&
            record.state !== 'ordered' &&
            !gone(record) &&
            // A finished order is never followed here: this page is accepted, and the page
            // would hear `completed` where a visitor without one hears `refused`.
            !isTerminal(record) &&
            this.recordServed(record),
        ),
      );
      this.followOnly = {
        reason: 'offer_refused',
        message: NO_NETWORK,
        ...(stillFollowed === undefined ? {} : { orderId: stillFollowed.orderId }),
      };
    }
    const followed = this.followOnly;
    if (followed !== undefined) {
      await this.startFollowOnly(allRecords, records, followed);
      return;
    }
    // Drawn before any relay or RPC round trip: the same offer, at the same moment,
    // for a visitor with or without an order in progress.
    const shown = recordToShow(records);
    const continued = shown !== undefined && continuedUnpaid(shown) ? shown : undefined;
    if (continued === undefined) {
      this.showOffer();
      this.status('ready');
    } else {
      // An open unpaid order is continued silently: the offer is drawn exactly as for
      // a first visit (no note, same status). It listens for the store now (a held
      // cancel or refund ends it before any payment); an acknowledged one is
      // republished in the background, a `created` one at the press.
      this.setRecord(continued);
      this.silent = continued.orderId;
      this.relays = continued.inboxRelays;
      this.showOffer();
      this.status('ready');
    }
    this.started = true;
    for (const record of records) {
      if (record.orderId !== continued?.orderId) {
        this.quiet.add(record.orderId);
      }
    }
    if (continued !== undefined) {
      this.listen(continued);
      if (continued.state === 'ordered') {
        this.resuming = this.resumeInBackground(continued);
      }
    }
    for (const record of records) {
      if (followable(record)) {
        this.followOwn(record);
      }
    }
    void this.startInBackground(allRecords).catch(() => undefined);
  }

  /** At load, after the first step is drawn: ended orders heard, Tempo ones reconciled, others resolved. */
  private async startInBackground(allRecords: readonly OrderRecord[]): Promise<void> {
    this.listenToEnded(allRecords);
    // A Tempo order that ended with its prompt still open may have been paid since.
    await this.reconcileEnded(allRecords);
    for (const record of allRecords) {
      if (!this.own(record) && holdsPayExclusion(record)) {
        this.followOther(record);
      }
    }
  }

  /** A page that only follows an order: exactly the order the snapshot was built from. */
  private async startFollowOnly(
    allRecords: readonly OrderRecord[],
    records: readonly OrderRecord[],
    followed: FollowOnlyState,
  ): Promise<void> {
    this.listenToEnded(allRecords);
    // A Tempo order that ended with its prompt still open may have been paid since.
    await this.reconcileEnded(allRecords);
    for (const record of allRecords) {
      if (!this.own(record) && holdsPayExclusion(record)) {
        this.followOther(record);
      }
    }
    const shown = records.find((record) => record.orderId === followed.orderId);
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

  /**
   * Republish an acknowledged order drawn at load, then listen on the relays the
   * store reads today. It holds no press, draws nothing and tells the page
   * nothing; a failure is swallowed.
   */
  private async resumeInBackground(record: OrderRecord): Promise<void> {
    try {
      const resumed = await resumeOrder(record, this.orderDeps(), this.deps.now());
      if (this.disposed || this.record?.orderId !== record.orderId) {
        return;
      }
      // The listener started at load may have heard it finish meanwhile: nothing to follow.
      const current = this.record;
      if (current === undefined || isTerminal(current)) {
        return;
      }
      this.listenAgainOn(resumed.relays, current);
    } catch {
      // The press does not republish an acknowledged order: it relies on the
      // periodic republish and the receipt's own publish, as before this resume.
    }
  }

  /**
   * Listen for `record` on `relays` (where the store reads today): a listener
   * started on other relays, at load, is replaced rather than kept.
   */
  private listenAgainOn(relays: string[], record: OrderRecord): void {
    const moved = relays.join() !== this.relays.join();
    this.relays = relays;
    if (moved && this.listening?.orderId === record.orderId) {
      this.listening.closer.close();
      this.listening = undefined;
    }
    this.listen(record);
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
    const resets = this.resets;
    const pending = this.oldPrompt;
    const current =
      this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
    if (pending === undefined || this.busy || current === undefined || this.resets !== resets) {
      return;
    }
    this.oldPrompt = undefined;
    const confirmed = [...new Set([...(current.confirmedOverIds ?? []), ...pending.unconfirmed])];
    const written = await this.deps.store.update(current.orderId, current.version, {
      confirmedOverIds: confirmed,
    });
    // Closed meanwhile: the confirmation stands, nothing is paid from a closed modal.
    if (this.resets !== resets) {
      return;
    }
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
        this.redrawIfFreed();
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
    this.endPress();
    this.dropAnsweredSilent();
    // Exactly how an action ends: the stored truth, then any answer held meanwhile.
    this.render();
    void this.showPendingAnswer();
  }

  /**
   * The press now running is no longer the current one: its awaits drop what
   * they bring back (a wallet answer goes to `lateAnswer`). It touches no
   * record and no order, and draws nothing.
   */
  private endPress(): void {
    this.press += 1;
    // Its own end (`redrawIfFreed`) never runs: whoever ended it draws the screen.
    this.exclusionFreed = false;
    this.cancellableFor = undefined;
    this.busy = false;
    this.busyOwner = undefined;
    this.pressing = false;
    this.retrying = false;
    this.stopProbe();
  }

  /** The press `press` was ended (a close, a probe verdict, a cancel) or the session ended. */
  private stale(press: number): boolean {
    return this.press !== press || this.disposed;
  }

  /**
   * A silent record the store finished while a press ran: dropped where the
   * press ends, never drawn or posted (it was never the buyer's).
   */
  private dropAnsweredSilent(): boolean {
    if (this.silentAnswered === undefined || this.silentAnswered !== this.record?.orderId) {
      return false;
    }
    this.silentAnswered = undefined;
    this.setRecord(undefined);
    return true;
  }

  private async payPressed(walletName: string, press: number): Promise<void> {
    // The close count when the press started: a marker write that lands after a
    // close is followed in the background, never shown.
    const resets = this.resets;
    this.lastWallet = walletName;
    this.lastAction = 'pay';
    if (this.lateHashHolds()) {
      return;
    }
    if (await this.deliveryFirst(press)) {
      return;
    }
    if (this.stale(press)) {
      return;
    }
    // A new order is certain: a typo never costs a wallet prompt or the open order.
    // (Both rails: `payTempo` starts below.) An open order continued as it is
    // went with its own email already, so only a new email makes a new order.
    const newOrder =
      this.record === undefined ||
      onOtherTerms(this.record, this.payout, this.customerRef) ||
      this.emailChanged(this.record);
    if (newOrder && this.emailUnusable()) {
      this.showOffer({ reason: 'bad_email' });
      return;
    }
    if (railOf(this.payout) === 'tempo') {
      await this.payTempo(walletName, press, resets);
      return;
    }
    await this.guard(press, async () => {
      // Before the wallet is asked anything, not even to connect.
      if (await this.earlierPayment(press)) {
        return;
      }
      this.cancellableFor = press;
      this.working('checking', true);
      const answer = await this.connect(walletName, networkOf(this.payout));
      if (this.stale(press)) {
        // Cancelled or closed: the answer is dropped, nothing is drawn.
        return;
      }
      this.cancellableFor = undefined;
      if ('error' in answer) {
        this.showOffer({ reason: connectProblem(answer.error) });
        return;
      }
      const wallet = answer.wallet;
      this.working('checking');
      const ready = await this.freshOffer(press);
      if (ready === undefined || this.stale(press)) {
        return;
      }
      const rpc = this.deps.rpcFor(networkOf(this.payout));
      if (rpc === undefined) {
        this.showOffer({ reason: 'rpc_error' });
        return;
      }
      const chainTime = await this.readChainTime(rpc);
      if (this.stale(press)) {
        return;
      }
      if (chainTime === undefined) {
        this.showOffer({ reason: 'rpc_error' });
        return;
      }
      if (!clockAgrees(chainTime, this.deps.now())) {
        this.showOffer({ reason: 'clock_skew' });
        return;
      }
      const record = await this.orderFor(chainTime, press, wallet.address, () =>
        this.feeAllowsOrder(ready, wallet.address, undefined, press),
      );
      if (record === undefined || this.stale(press)) {
        return;
      }
      this.working('signing');
      this.stopWatching();
      this.generation += 1;
      this.startProbe(press, record);
      const result = await payWithSolana(
        record,
        wallet,
        { fresh: ready, chainTime },
        this.payDeps(rpc, { press, resets }),
      );
      this.stopProbe(press);
      if (this.stale(press)) {
        await this.lateAnswer(result, resets);
        return;
      }
      await this.afterPay(result, rpc, press, resets, walletName);
    });
  }

  /**
   * Pay on Tempo: connect (accounts, then the chain) before anything is ordered
   * or composed, order on Tempo's finalized time, then one wallet request. No
   * retry exists on Tempo: an attempt stays live until it is found or proven over.
   */
  private async payTempo(walletName: string, press: number, resets: number): Promise<void> {
    await this.guard(press, async () => {
      // Before the wallet is asked anything, not even to connect.
      if (await this.earlierPayment(press)) {
        return;
      }
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
        if (this.stale(press)) {
          // Cancelled: a late refusal draws nothing.
          return;
        }
        this.cancellableFor = undefined;
        this.showOffer({ reason: tempoConnectProblem(error) });
        return;
      }
      if (this.stale(press)) {
        return;
      }
      this.cancellableFor = undefined;
      this.working('checking');
      const ready = await this.freshOffer(press);
      if (ready === undefined || this.stale(press)) {
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
        if (!this.stale(press)) {
          this.showOffer({ reason: 'rpc_error' });
        }
        return;
      }
      if (this.stale(press)) {
        return;
      }
      if (!clockAgrees(chainTime, this.deps.now())) {
        this.showOffer({ reason: 'clock_skew' });
        return;
      }
      const record = await this.orderFor(chainTime, press, wallet.address, () =>
        this.feeAllowsOrder(ready, wallet.address, wallet, press),
      );
      if (record === undefined || this.stale(press)) {
        return;
      }
      this.working('signing');
      this.stopWatching();
      this.generation += 1;
      this.startProbe(press, record);
      const result = await payWithTempo(
        record,
        wallet,
        ready,
        this.tempoDeps(client, { press, resets }),
      );
      this.stopProbe(press);
      if (this.stale(press)) {
        await this.lateAnswer(result, resets, wallet);
        return;
      }
      await this.afterTempoPay(result, press, resets, wallet);
    });
  }

  /**
   * Before a new order is placed: the protocol fee planned from fresh terms for
   * this offer and payer, and on Tempo with a fee leg, a wallet that batches.
   * A refusal is drawn on the offer (`false`): nothing was ordered or paid. An
   * open order is never checked here: its compose (or the core) decides, so a
   * `store_outdated` one with no marker ends instead of staying open.
   */
  private async feeAllowsOrder(
    ready: ReadyOffer,
    payer: string,
    tempoWallet: TempoWallet | undefined,
    press: number,
  ): Promise<boolean> {
    const planned = await planFee(
      this.deps.feeTerms,
      this.payout.target.caip19.chain.caip2,
      ready.offer,
      { payout: this.payout.target.address, payer },
      this.payout.amount,
    );
    if (this.stale(press)) {
      return false;
    }
    if (!planned.ok) {
      this.showOffer({ reason: planned.reason });
      return false;
    }
    if (
      tempoWallet !== undefined &&
      planned.plan.amount > 0n &&
      !(await tempoWalletCanBatch(tempoWallet, chainIdHex(this.payout)))
    ) {
      if (!this.stale(press)) {
        this.showOffer({ reason: 'wallet_cannot_batch' });
      }
      return false;
    }
    return !this.stale(press);
  }

  private async afterTempoPay(
    result: TempoPayResult,
    press: number,
    resets: number,
    wallet: TempoWallet,
  ): Promise<void> {
    if (result.ok) {
      // Remembered before anything else: a store that answered while the wallet was
      // open makes the record terminal, and its receipt still names what was sent.
      this.rememberSent(result, wallet);
    }
    if (result.record !== undefined) {
      const stored = await this.deps.store.get(result.record.orderId);
      if (this.stale(press)) {
        await this.lateAnswer(result, resets, wallet);
        return;
      }
      this.setRecord(stored !== undefined && isTerminal(stored) ? stored : result.record);
      if (stored !== undefined && isTerminal(stored)) {
        await this.follow(stored);
        return;
      }
    }
    if (result.ok && 'bundleId' in result) {
      this.attemptProblem = undefined;
      this.attemptOver = false;
      const hold: BundleHold = {
        orderId: result.record.orderId,
        bundleId: result.bundleId,
        wallet,
      };
      if (result.bundleUnsaved === true && result.record.state === 'ended-unpaid') {
        // Another tab ended the order while the wallet was open: the buyer approved
        // the bundle anyway. It is followed until it resolves, and said so.
        this.watchLateBundle(result.record, hold);
        this.listenToEnded([result.record], this.relays);
        this.setRecord(undefined);
        this.showOffer({ reason: 'late_approval' });
        return;
      }
      if (result.bundleUnsaved === true) {
        this.pendingBundle = hold;
      } else {
        this.bundleFollow = hold;
      }
      await this.follow(result.record);
      return;
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
        await this.askOldPrompt(result.unconfirmed ?? [], press);
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
        this.setAttemptProblem({ reason: 'wallet_failed' }, this.record?.marker?.attemptId);
        this.attemptOver = false;
        if (this.record !== undefined) {
          await this.follow(this.record);
        }
        return;
      case 'policy_blocked':
      case 'wrong_chain':
      case 'self_payment':
      case 'rpc_error':
      case 'wallet_cannot_batch':
      case 'fee_config_unavailable':
      case 'fee_config_invalid':
        // Nothing was requested: the record stays as it is (`ordered` again after a
        // wallet that cannot batch), and another wallet or a later press can pay it.
        this.showOrWait({ reason: result.reason });
        return;
      case 'offer_changed':
      case 'store_outdated':
      case 'too_late':
      case 'unpayable': {
        const current =
          this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
        if (this.stale(press)) {
          return;
        }
        const ended = current === undefined ? undefined : await this.endOrder(current);
        if (this.stale(press)) {
          return;
        }
        if (ended !== undefined && !ended.ended) {
          await this.follow(ended.record);
          return;
        }
        this.setRecord(undefined);
        this.showOffer({ reason: result.reason === 'unpayable' ? 'failed' : result.reason });
        return;
      }
      case 'exclusion':
        await this.metHolder(result.holder, press);
        return;
      default: {
        const current =
          this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
        if (this.stale(press)) {
          await this.lateAnswer(result, resets, wallet);
          return;
        }
        if (current !== undefined) {
          await this.follow(current);
        } else {
          this.showOffer({ reason: 'failed' });
        }
      }
    }
  }

  /**
   * The store refused the marker: another order of this product holds a live
   * attempt. This account's own is never shown again: its earlier-payment line,
   * and it is followed in the background. Another account's keeps its note.
   */
  private async metHolder(holderId: string | undefined, press: number): Promise<void> {
    const holder = holderId === undefined ? undefined : await this.deps.store.get(holderId);
    if (holder !== undefined && this.own(holder) && followable(holder)) {
      this.followOwn(holder);
    }
    if (this.stale(press)) {
      return;
    }
    if (holder === undefined) {
      this.showOffer({ reason: 'failed' });
      return;
    }
    if (!this.own(holder)) {
      this.followOther(holder);
      this.showOffer({ reason: 'other_purchase' });
      return;
    }
    const line = await this.holderLine(holder);
    if (this.stale(press)) {
      return;
    }
    this.showLine(holder.orderId, line);
  }

  /**
   * A payment refused for an ended Tempo order whose prompt may still be
   * approved: ask. Every order counts (another account's too, since its prompt
   * would pay as well), but only the date comes from them: what is shown is
   * this page's own terms.
   */
  private async askOldPrompt(unconfirmed: string[], press: number): Promise<void> {
    const walletName = this.lastWallet;
    const action = this.lastAction;
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
    // Closed meanwhile: no question on the first step, with nothing behind it.
    if (this.stale(press)) {
      return;
    }
    this.oldPrompt = { walletName, action, unconfirmed };
    const terms = this.termsShown(false);
    const paying = this.payingOf(terms);
    this.show({
      kind: 'old_prompt',
      orders: unconfirmed.length,
      until,
      about: this.aboutOf(terms),
      ...(paying === undefined ? {} : { paying }),
    });
  }

  /** What a Tempo pay answer sent, remembered for receipts and for following a bundle. */
  private rememberSent(
    result: Extract<TempoPayResult, { ok: true }>,
    wallet: Pick<TempoWallet, 'callsStatus'> | undefined,
  ): void {
    if ('hash' in result) {
      this.sentHash.set(result.record.orderId, result.hash);
    } else if (wallet !== undefined) {
      this.bundleWallets.set(result.record.orderId, wallet);
    }
  }

  /** An unsaved hash or bundle of an order another tab ended: it is a late approval now. */
  private adoptLateHash(record: OrderRecord): void {
    if (this.pendingHash?.orderId === record.orderId) {
      this.watchLateHash(record, this.pendingHash.hash);
      this.pendingHash = undefined;
    }
    if (this.pendingBundle?.orderId === record.orderId) {
      this.watchLateBundle(record, this.pendingBundle);
      this.pendingBundle = undefined;
    }
  }

  /**
   * An approval of an ended order is in flight (known only in this session):
   * no other payment of the product until it is found - the buyer approved it,
   * so there is no prompt left to reject.
   */
  private lateHashHolds(): boolean {
    const late = this.lateHash ?? this.lateBundle;
    if (late === undefined) {
      return false;
    }
    // An order followed in the background since a close: only that a payment from
    // earlier is still being confirmed, never the old banner's text.
    if (this.quiet.has(late.orderId)) {
      this.showLine(late.orderId, { reason: 'earlier_payment', phase: 'confirming' });
    } else {
      this.showOffer({ reason: 'late_approval' });
    }
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
    // A close since this watch started makes its outcome stored, never shown.
    const resets = this.resets;
    // This watch's own entry: a later watch replaces it, and a check of this one
    // still in flight then must never stop the later one.
    const own: { orderId: string; hash: string; timer: unknown } = {
      orderId: record.orderId,
      hash,
      timer: undefined,
    };
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
          // Its own outcome is still this order's banner (quiet rules apply there).
          if (this.resets === resets) {
            this.banner(watched.record);
          }
          if (this.lateHash === own) {
            this.deps.clearInterval(own.timer);
            this.lateHash = undefined;
          }
        }
      } finally {
        checking = false;
      }
    };
    own.timer = this.deps.setInterval(() => void check().catch(() => undefined), WATCH_EVERY_MS);
    this.lateHash = own;
    this.sentHash.set(record.orderId, hash);
    void check().catch(() => undefined);
  }

  /**
   * Follow a bundle approved for an ended order (known only in this session):
   * asked about through its wallet until a hash comes (then it is a late hash)
   * or the wallet says it failed (the hold is dropped); meanwhile the memo watch
   * may find its payment. Every press is refused while it lasts.
   */
  private watchLateBundle(record: OrderRecord, hold: BundleHold): void {
    const client = this.tempoOfRecord(record);
    if (client === undefined || this.disposed) {
      return;
    }
    if (this.lateBundle !== undefined) {
      this.deps.clearInterval(this.lateBundle.timer);
    }
    let checking = false;
    const resets = this.resets;
    const own: BundleHold & { timer: unknown } = { ...hold, timer: undefined };
    const stopOwn = () => {
      if (this.lateBundle === own) {
        this.deps.clearInterval(own.timer);
        this.lateBundle = undefined;
      }
    };
    const check = async () => {
      if (checking || this.disposed || this.lateBundle !== own) {
        return;
      }
      checking = true;
      try {
        const current = await this.deps.store.get(record.orderId);
        if (current === undefined) {
          return;
        }
        const step = await followTempoBundle(
          current,
          this.tempoDeps(client),
          own.wallet,
          own.bundleId,
        );
        if (step.step === 'hash') {
          stopOwn();
          this.watchLateHash(step.record, step.hash);
          return;
        }
        if (step.step === 'failed') {
          // The wallet's final word: this bundle never paid. Nothing is stored.
          stopOwn();
          return;
        }
        const watched = await watchTempoPayment(step.record, this.tempoDeps(client), {
          pendingBundleId: own.bundleId,
        });
        if (watched.state === 'paid' || watched.state === 'blocked' || watched.state === 'closed') {
          if (this.resets === resets) {
            this.banner(watched.record);
          }
          stopOwn();
        }
      } finally {
        checking = false;
      }
    };
    own.timer = this.deps.setInterval(() => void check().catch(() => undefined), WATCH_EVERY_MS);
    this.lateBundle = own;
    this.bundleWallets.set(record.orderId, hold.wallet);
    void check().catch(() => undefined);
  }

  /** The bundle a pass on `record` asks its wallet about: this session's unsaved one, or the one on screen. */
  private bundleToFollow(record: OrderRecord): BundleHold | undefined {
    if (this.pendingBundle?.orderId === record.orderId) {
      return this.pendingBundle;
    }
    const marker = record.marker;
    const follow = this.bundleFollow;
    if (
      follow?.orderId === record.orderId &&
      marker?.rail === 'tempo' &&
      marker.bundleId === follow.bundleId &&
      marker.bundleFailed !== true &&
      marker.txHash === undefined
    ) {
      return follow;
    }
    return undefined;
  }

  /** What one answer about a bundle changes in this session's holds. */
  private applyBundleStep(orderId: string, bundleId: string, step: TempoBundleStep): void {
    const matches = (hold: BundleHold | undefined) =>
      hold?.orderId === orderId && hold.bundleId === bundleId;
    if (step.step !== 'hash' && step.step !== 'failed') {
      return;
    }
    if (matches(this.pendingBundle)) {
      this.pendingBundle = undefined;
    }
    if (matches(this.bundleFollow)) {
      this.bundleFollow = undefined;
    }
    if (step.step === 'hash') {
      this.sentHash.set(orderId, step.hash);
      if (step.hashUnsaved === true) {
        this.pendingHash = { orderId, hash: step.hash };
      }
      return;
    }
    if (this.record?.orderId === orderId) {
      this.setAttemptProblem({ reason: 'wallet_payment_failed' }, this.record.marker?.attemptId);
    }
  }

  /** The in-session holds of an order a Tempo watch or end must count: its unsaved bundle. */
  private bundleHold(orderId: string): TempoWatchOptions {
    return this.pendingBundle?.orderId === orderId
      ? { pendingBundleId: this.pendingBundle.bundleId }
      : {};
  }

  /**
   * Ask the wallet that approved `record`'s stored bundle how it went, without a
   * connection (EIP-6963 discovery, or this session's own wallet): before any
   * memo watch at load and at a press. `reachable: false`: no wallet answered,
   * so "Check in wallet" is offered; the order stays held either way.
   */
  private async observeBundle(
    record: OrderRecord,
  ): Promise<{ record: OrderRecord; reachable: boolean }> {
    const marker = record.marker;
    const client = this.tempoOfRecord(record);
    if (
      marker?.rail !== 'tempo' ||
      marker.bundleId === undefined ||
      marker.bundleFailed === true ||
      marker.txHash !== undefined ||
      client === undefined
    ) {
      return { record, reachable: true };
    }
    const wallet =
      this.bundleWallets.get(record.orderId) ?? this.deps.bundleWallet?.(marker.bundleWallet);
    const step = await followTempoBundle(record, this.tempoDeps(client), wallet, marker.bundleId);
    this.applyBundleStep(record.orderId, marker.bundleId, step);
    return { record: step.record, reachable: step.step !== 'unknown' };
  }

  private tempoDeps(client: Eip1193Client, scope?: PressScope): TempoPayDeps {
    return {
      store: scope === undefined ? this.deps.store : this.pressStore(scope),
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
      client,
      now: this.deps.now,
      feeTerms: this.deps.feeTerms,
    };
  }

  /** The payouts this widget can pay now, on the page's network. */
  private payablePayouts(offer: ReadyOffer = this.offer): PricedPayout[] {
    return offer.payouts.filter(
      (payout) => networkOf(payout) === this.network && this.servable(payout),
    );
  }

  /**
   * The buyer typed an email this session did not send with that open order: it
   * goes with a new order instead (the old one ends unpaid). A retry of this
   * session's own order with the same email pays the same order; after a reload
   * the old order's email is unknown, so any typed email starts a new one.
   */
  private emailChanged(record: OrderRecord): boolean {
    if (
      this.deps.collectEmail !== true ||
      (record.state !== 'created' && record.state !== 'ordered')
    ) {
      return false;
    }
    const typed = this.email.trim();
    if (typed === '') {
      return false;
    }
    const usable = usableEmail(typed);
    return usable === undefined || usable !== this.sentEmail.get(record.orderId);
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
    return record !== undefined &&
      (signing || this.retrying || !onOtherTerms(record, this.payout, this.customerRef))
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
    const base = receiptBase(record, network);
    if (base.paid !== undefined) {
      return base;
    }
    const tx = this.receiptCandidate(record);
    if (tx === undefined) {
      return base;
    }
    const checked = this.txChecks.get(`${record.orderId}:${tx}`);
    if (checked === undefined) {
      void this.checkSentTx(record, tx);
      return base;
    }
    // Pending, unknown (its own timer asks again) or failed: no row, and no new look-up here.
    return checked === true ? withSent(record, base, tx, network) : base;
  }

  /**
   * This store's purchases in this browser for "Your purchases": the page's own
   * account only. Read only: it writes nothing, tells the page nothing, and
   * touches no part of the purchase on screen.
   */
  async purchases(): Promise<Purchase[]> {
    const records = (await this.deps.readAll?.()) ?? [];
    return purchasesOf(records, {
      storePubkey: this.offer.offer.storePubkey,
      customerRef: this.customerRef,
      productAddress: this.offer.productAddress,
    });
  }

  /**
   * One purchase as it stands now, for its detail: its status and its
   * receipt from the record read once, never the list's older snapshot.
   */
  async purchase(orderId: string): Promise<Purchase | undefined> {
    const record = await this.ownStoreRecord(orderId);
    const purchase =
      record === undefined ? undefined : purchaseOf(record, this.offer.productAddress);
    if (record === undefined || purchase === undefined) {
      return undefined;
    }
    return { ...purchase, receipt: await this.receiptFor(record) };
  }

  /** A record of this store and this page's account, or nothing. */
  private async ownStoreRecord(orderId: string): Promise<OrderRecord | undefined> {
    const record = await this.deps.store.get(orderId);
    return record !== undefined &&
      record.storePubkey === this.offer.offer.storePubkey &&
      this.own(record)
      ? record
      : undefined;
  }

  /**
   * A purchase's receipt for its detail. A finished order's sent transaction is
   * named only after its one chain check (shared with the receipt panel's); an
   * unfinished one gets no check, so its later receipt is never pinned to a
   * look-up made too early.
   */
  private async receiptFor(record: OrderRecord): Promise<Receipt> {
    const network = recordNetwork(record);
    const base = receiptBase(record, network);
    if (!isTerminal(record) || base.paid !== undefined) {
      return base;
    }
    const tx = this.receiptCandidate(record);
    if (tx === undefined) {
      return base;
    }
    const key = `${record.orderId}:${tx}`;
    const checked = this.txChecks.get(key);
    let found: boolean;
    if (checked === true || checked === false) {
      found = checked;
    } else if (checked === 'pending') {
      found = await (this.txLookups.get(key) ?? Promise.resolve(false));
    } else if (checked === undefined) {
      found = await this.checkSentTx(record, tx);
    } else {
      // Unknown: never read as "not paid", and never a look-up beyond its timer's.
      found = false;
    }
    return found ? withSent(record, base, tx, network) : base;
  }

  /**
   * Look a sent transaction up on the order's own network. Only a final answer
   * is kept (confirmed or finalized: it succeeded or it failed); an unknown one
   * is asked again by one timer while that finished order is on screen, at most
   * `TX_RECHECKS` times. A success redraws the same finished order only, never
   * during an action. Resolves `true` only for a success.
   */
  private checkSentTx(record: OrderRecord, tx: string): Promise<boolean> {
    const key = `${record.orderId}:${tx}`;
    const before = this.txChecks.get(key);
    const attempts = typeof before === 'object' ? before.attempts : 0;
    const lookup = this.sentTxVerdict(record, tx)
      .catch((): TxVerdict => 'unknown')
      .then((verdict) => {
        if (verdict === 'unknown') {
          this.txChecks.set(key, { kind: 'unknown', attempts: attempts + 1 });
          this.recheckLater(record, tx, attempts + 1);
          return false;
        }
        const found = verdict === 'succeeded';
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
        return found;
      });
    this.txChecks.set(key, 'pending');
    this.txLookups.set(key, lookup);
    return lookup;
  }

  /** One more look-up of an unknown answer, later, only while that finished order is on screen. */
  private recheckLater(record: OrderRecord, tx: string, attempts: number): void {
    const key = `${record.orderId}:${tx}`;
    const current = this.record;
    if (
      attempts > TX_RECHECKS ||
      this.disposed ||
      this.txRechecks.has(key) ||
      current?.orderId !== record.orderId ||
      !isTerminal(current)
    ) {
      return;
    }
    const handle = this.deps.setTimeout(() => {
      // Only the one timer set for this key, once: never a stopped or replaced one.
      if (this.txRechecks.get(key) !== handle) {
        return;
      }
      this.txRechecks.delete(key);
      const shown = this.record;
      if (this.disposed || shown?.orderId !== record.orderId || !isTerminal(shown)) {
        return;
      }
      void this.checkSentTx(record, tx);
    }, WATCH_EVERY_MS);
    this.txRechecks.set(key, handle);
  }

  /** Every re-check timer stops (the finished order left the screen, or the session ended). */
  private stopRechecks(): void {
    for (const handle of this.txRechecks.values()) {
      this.deps.clearTimeout(handle);
    }
    this.txRechecks.clear();
  }

  private async sentTxVerdict(record: OrderRecord, tx: string): Promise<TxVerdict> {
    if (recordTarget(record) === undefined) {
      return 'unknown';
    }
    if (recordRail(record) === 'solana') {
      const rpc = this.rpcOfRecord(record);
      if (rpc === undefined || !isSignature(tx)) {
        return 'unknown';
      }
      const statuses = await rpc
        .getSignatureStatuses([tx], { searchTransactionHistory: true })
        .send({ abortSignal: AbortSignal.timeout(TX_CHECK_TIMEOUT_MS) });
      return solanaVerdict(statuses.value[0]);
    }
    const client = this.tempoOfRecord(record);
    if (client === undefined) {
      return 'unknown';
    }
    const receipt: unknown = await withAbort(
      client.request({ method: 'eth_getTransactionReceipt', params: [tx] }),
      AbortSignal.timeout(TX_CHECK_TIMEOUT_MS),
    );
    if (typeof receipt !== 'object' || receipt === null || !('status' in receipt)) {
      return 'unknown';
    }
    return readQuantity(receipt.status) === 1n ? 'succeeded' : 'failed';
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
  private working(
    step: 'checking' | 'ordering' | 'signing',
    cancellable = false,
    unanswered: { startOverIn?: Countdown; unsureAt?: number } = {},
  ): void {
    const terms = this.termsShown(step === 'signing');
    const paying = this.payingOf(terms);
    this.show({
      kind: 'working',
      step,
      about: this.aboutOf(terms),
      ...(paying === undefined ? {} : { paying }),
      ...(cancellable ? { cancellable: true as const } : {}),
      ...(unanswered.startOverIn === undefined ? {} : { startOverIn: unanswered.startOverIn }),
      ...(unanswered.unsureAt === undefined ? {} : { unsureAt: unanswered.unsureAt }),
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
        // An approved bundle first: the wallet may already know it failed or landed.
        const observed = await this.observeBundle(record);
        const watched = await watchTempoPayment(observed.record, this.tempoDeps(client));
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
    // Another account's answer never reaches this page; an order followed in the
    // background since a close or a load is stored only.
    if (!this.own(record) || this.quiet.has(record.orderId)) {
      return;
    }
    const state = record.state;
    if (state !== 'paid' && state !== 'blocked' && state !== 'completed' && state !== 'refunded') {
      return;
    }
    this.deps.onBanner?.({ orderId: record.orderId, state });
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
        this.redrawIfFreed();
      }
    }
  }

  private async retryPressed(
    record: OrderRecord,
    walletName: string,
    press: number,
  ): Promise<void> {
    const resets = this.resets;
    this.lastWallet = walletName;
    this.lastAction = 'retry';
    if (this.lateHashHolds()) {
      return;
    }
    if (await this.deliveryFirst(press)) {
      return;
    }
    if (this.stale(press)) {
      return;
    }
    const network = this.networkOfRecord(record);
    if (network === undefined) {
      return;
    }
    await this.guard(press, async () => {
      this.retrying = true;
      try {
        await this.retryGuarded(record, walletName, network, { press, resets });
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
    scope: PressScope,
  ): Promise<void> {
    const press = scope.press;
    this.cancellableFor = press;
    this.working('checking', true);
    const answer = await this.connect(walletName, network);
    if (this.stale(press)) {
      return;
    }
    this.cancellableFor = undefined;
    if ('error' in answer) {
      this.render({ problem: { reason: connectProblem(answer.error) } });
      return;
    }
    const wallet = answer.wallet;
    this.working('checking');
    const ready = await this.freshOffer(press);
    // The re-verification drew its own view (a changed or refused offer).
    if (ready === undefined || this.stale(press)) {
      return;
    }
    const rpc = this.deps.rpcFor(network);
    if (rpc === undefined) {
      this.render();
      return;
    }
    const chainTime = await this.readChainTime(rpc);
    if (this.stale(press)) {
      return;
    }
    if (chainTime === undefined) {
      this.render({ problem: { reason: 'rpc_error' } });
      return;
    }
    const current = (await this.deps.store.get(record.orderId)) ?? record;
    if (this.stale(press)) {
      return;
    }
    if (current.status?.status === 'cancelled') {
      // The store cancelled it: never another attempt (the store refuses one too).
      await this.follow(current);
      return;
    }
    this.working('signing');
    this.stopWatching();
    this.generation += 1;
    this.startProbe(press, current);
    const result = await retryWithSolana(
      current,
      wallet,
      { fresh: ready, chainTime },
      this.payDeps(rpc, scope),
    );
    this.stopProbe(press);
    if (this.stale(press)) {
      await this.lateAnswer(result, scope.resets);
      return;
    }
    await this.afterPay(result, rpc, press, scope.resets, walletName);
  }

  /**
   * Ask the Solana wallet that failed the live attempt again, inside that same
   * attempt: offered only while the view's button is (`againFor`, judged now,
   * not on the view the buyer saw). Nothing new is composed; commerce checks
   * the stored attempt again and reads the chain before the wallet opens.
   */
  async signAgain(): Promise<void> {
    const record = this.record;
    const offer = record === undefined ? undefined : this.againFor(record);
    if (
      this.busy ||
      this.pressing ||
      this.followOnly !== undefined ||
      record === undefined ||
      offer === undefined
    ) {
      return;
    }
    this.press += 1;
    const press = this.press;
    this.pressing = true;
    try {
      await this.signAgainPressed(record, offer, press);
    } finally {
      if (this.press === press) {
        this.pressing = false;
        this.redrawIfFreed();
      }
    }
  }

  private async signAgainPressed(
    record: OrderRecord,
    offer: { handle: SolanaSignAgain; walletName: string },
    press: number,
  ): Promise<void> {
    const resets = this.resets;
    if (this.lateHashHolds()) {
      return;
    }
    if (await this.deliveryFirst(press)) {
      return;
    }
    if (this.stale(press)) {
      return;
    }
    const network = this.networkOfRecord(record);
    if (network === undefined) {
      return;
    }
    await this.guard(press, async () => {
      // The order's own terms on every progress view, as a retry shows them.
      this.retrying = true;
      try {
        await this.signAgainGuarded(record, offer, network, { press, resets });
      } finally {
        if (this.press === press) {
          this.retrying = false;
        }
      }
    });
  }

  private async signAgainGuarded(
    record: OrderRecord,
    offer: { handle: SolanaSignAgain; walletName: string },
    network: Network,
    scope: PressScope,
  ): Promise<void> {
    const press = scope.press;
    this.cancellableFor = press;
    this.working('checking', true);
    const answer = await this.connect(offer.walletName, network);
    if (this.stale(press)) {
      return;
    }
    this.cancellableFor = undefined;
    if ('error' in answer) {
      // The attempt stays live: a declined connect is no "nothing was paid".
      this.render({
        problem: {
          reason: answer.error === 'rejected' ? 'again_declined' : connectProblem(answer.error),
        },
      });
      return;
    }
    const current = (await this.deps.store.get(record.orderId)) ?? record;
    if (this.stale(press)) {
      return;
    }
    if (storeClosed(current)) {
      // The store cancelled or delivered it: never another wallet request.
      await this.follow(current);
      return;
    }
    const rpc = this.deps.rpcFor(network);
    if (rpc === undefined) {
      this.render();
      return;
    }
    this.working('signing');
    this.stopWatching();
    this.generation += 1;
    this.startProbe(press, current);
    let result: SolanaPayResult;
    try {
      result = await signAgainWithSolana(offer.handle, answer.wallet, {
        ...this.payDeps(rpc, scope),
        // A close or a probe verdict during the reads before the wallet opens no window.
        mayAsk: () => !this.stale(press),
      });
    } catch (error) {
      // The wallet may have signed before the store failed: it is never asked again
      // for this attempt, and nothing says it did not answer.
      if (this.againOffer === offer) {
        this.againOffer = undefined;
        this.setAttemptProblem({ reason: 'failed' }, offer.handle.attemptId);
      }
      throw error;
    }
    this.stopProbe(press);
    if (this.stale(press)) {
      await this.lateAnswer(result, scope.resets);
      return;
    }
    await this.afterPay(result, rpc, press, scope.resets, offer.walletName);
  }

  /**
   * "Check in wallet": the earlier-payment line names an approved bundle its
   * wallet would not answer about without a connection. Connect that wallet
   * (the one that approved it, by `rdns`), then the press path's own first
   * step: the earlier payment is asked about through it, and its line drawn
   * again - or, freed, the offer. It never asks the wallet to pay.
   */
  async checkInWallet(): Promise<void> {
    const holderId = this.lineHolder;
    if (this.busy || this.pressing || this.followOnly !== undefined || holderId === undefined) {
      return;
    }
    this.press += 1;
    const press = this.press;
    this.pressing = true;
    try {
      await this.guard(press, () => this.checkInWalletGuarded(holderId, press));
    } finally {
      if (this.press === press) {
        this.pressing = false;
        this.redrawIfFreed();
      }
    }
  }

  private async checkInWalletGuarded(holderId: string, press: number): Promise<void> {
    const holder = await this.deps.store.get(holderId);
    const network = holder === undefined ? undefined : this.networkOfRecord(holder);
    if (this.stale(press) || holder === undefined || network === undefined) {
      return;
    }
    const marker = holder.marker;
    const options = this.deps.tempoWallets?.(network) ?? [];
    const rdns = marker?.rail === 'tempo' ? marker.bundleWallet : undefined;
    // A bundle whose wallet is named is checked in through that wallet only.
    const named = rdns === undefined ? undefined : options.find((each) => each.rdns === rdns);
    const option = rdns === undefined && options.length === 1 ? options[0] : named;
    if (option === undefined) {
      this.showOffer({ reason: 'no_wallet' });
      return;
    }
    this.cancellableFor = press;
    this.working('checking', true);
    let wallet: TempoWallet;
    try {
      wallet = await option.connect();
    } catch (error) {
      if (!this.stale(press)) {
        this.cancellableFor = undefined;
        this.showOffer({ reason: tempoConnectProblem(error) });
      }
      return;
    }
    if (this.stale(press)) {
      return;
    }
    this.cancellableFor = undefined;
    this.bundleWallets.set(holderId, wallet);
    if (!(await this.earlierPayment(press)) && !this.stale(press)) {
      this.showOffer();
    }
  }

  /** Leave an order that will not be paid (only once nothing can still land). */
  async startOver(): Promise<void> {
    const record = this.record;
    if (this.busy || record === undefined) {
      return;
    }
    const resets = this.resets;
    // Not a press: it never runs beside one, so it keeps the current id.
    await this.guard(this.press, async () => {
      try {
        await this.leaveOrder(record, resets);
      } finally {
        // No press ends after it to redraw: a product freed meanwhile is drawn by
        // its own screen, never left to clear a later press's note.
        this.exclusionFreed = false;
      }
    });
  }

  /** `startOver`'s work, under its guard. */
  private async leaveOrder(record: OrderRecord, resets: number): Promise<void> {
    this.againOffer = undefined;
    const current = (await this.deps.store.get(record.orderId)) ?? record;
    // Closed meanwhile: the first step is on screen already.
    if (this.resets !== resets) {
      return;
    }
    // Finished (completed or refunded): nothing to end, a new order may start.
    if (isTerminal(current)) {
      this.setRecord(undefined);
      this.showOffer();
      return;
    }
    const ended = await this.endOrder(current);
    if (this.resets !== resets) {
      // The end the buyer asked for stands; its store answer is still stored.
      if (ended.ended) {
        this.stopFollowing(ended.record.orderId);
        this.quiet.add(ended.record.orderId);
        this.listenToEnded([ended.record], ended.record.inboxRelays);
      }
      return;
    }
    if (ended.ended) {
      const relays = this.relays;
      this.setRecord(undefined);
      this.listenToEnded([ended.record], relays);
      this.status('ended');
      this.showOffer();
    } else {
      await this.follow(ended.record);
    }
  }

  /**
   * The modal closed: the next open shows the first step, a fresh offer, in
   * every state. View-only: it writes nothing, ends nothing and clears no
   * marker. A press running is detached (its wallet answer still lands, in the
   * background); an order that may still land is followed in the background and
   * shows under "Your purchases"; an open unpaid order stays, continued
   * silently. Refused (`false`, nothing changes) on a follow-only or refused
   * page, before the first view, and after the session ended.
   */
  resetOnClose(): boolean {
    if (this.disposed || this.followOnly !== undefined || this.refused || !this.started) {
      return false;
    }
    this.resets += 1;
    // 1. A running press is detached: its later awaits draw, post and pay nothing.
    if (this.busy || this.pressing) {
      this.endPress();
    }
    // 2. The foreground machinery of the record on screen stops.
    this.stopProbe();
    this.stopWatching();
    // Only the foreground poll of a STORED bundle: the marker keeps it, and the next
    // load or press asks about it. An unsaved or late bundle keeps its own hold.
    this.bundleFollow = undefined;
    if (this.noAnswerTimer !== undefined) {
      this.deps.clearInterval(this.noAnswerTimer.handle);
      this.noAnswerTimer = undefined;
    }
    // 3. An order that may still land goes on in the background: the newest known
    // copy, since a marker written during signing reaches `this.record` only later.
    let current = this.record;
    const marked = this.marked;
    if (
      current !== undefined &&
      marked !== undefined &&
      marked.orderId === current.orderId &&
      marked.version > current.version
    ) {
      current = marked;
    }
    if (current !== undefined && followable(current)) {
      this.followOwn(current, this.relays.length === 0 ? undefined : this.relays);
    }
    // 4. What is shown is cleared; an open unpaid order stays, silently.
    if (this.dropAnsweredSilent()) {
      current = undefined;
    }
    if (current !== undefined && this.record !== undefined && continuedUnpaid(current)) {
      this.record = current;
      this.silent = current.orderId;
    } else {
      this.setRecord(undefined);
    }
    this.attemptProblem = undefined;
    this.againOffer = undefined;
    this.attemptOver = false;
    this.oldPrompt = undefined;
    this.offerProblem = undefined;
    this.noteShown = false;
    this.lineHolder = undefined;
    this.exclusionFreed = false;
    // 5. Everything of this account heard in the background is stored only from now on.
    for (const orderId of this.background.keys()) {
      if (!this.backgroundOther.has(orderId)) {
        this.quiet.add(orderId);
      }
    }
    if (this.lateHash !== undefined) {
      this.quiet.add(this.lateHash.orderId);
    }
    if (this.lateBundle !== undefined) {
      this.quiet.add(this.lateBundle.orderId);
    }
    for (const orderId of this.pendingAnswers.keys()) {
      this.quiet.add(orderId);
    }
    this.pendingAnswers.clear();
    this.deps.onBanner?.(undefined);
    // 6. The first step (a redraw of the plain offer would be identical).
    const view = this.shownView;
    if (view?.kind !== 'offer' || view.problem !== undefined) {
      this.showOffer();
    }
    this.status('ready');
    return true;
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
    this.stopProbe();
    if (this.lateHash !== undefined) {
      this.deps.clearInterval(this.lateHash.timer);
      this.lateHash = undefined;
    }
    if (this.lateBundle !== undefined) {
      this.deps.clearInterval(this.lateBundle.timer);
      this.lateBundle = undefined;
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
    this.backgroundOther.clear();
    for (const orderId of [...this.followers.keys()]) {
      this.stopFollowing(orderId);
    }
  }

  // ---- the unanswered wallet ------------------------------------------------

  /**
   * While a press waits for the wallet's signature, the attempt is measured:
   * a countdown to when it can be proven over, and the watch's own verdicts.
   * Started after the watch stopped and the generation moved on.
   */
  private startProbe(press: number, record: OrderRecord): void {
    this.stopProbe();
    const probe: Probe = {
      press,
      orderId: record.orderId,
      generation: this.generation,
      resets: this.resets,
      timer: undefined,
      ticking: false,
      drawn: '',
    };
    probe.timer = this.deps.setInterval(
      () => void this.probeTick(probe).catch(() => undefined),
      WATCH_EVERY_MS,
    );
    this.unanswered = probe;
    void this.probeTick(probe).catch(() => undefined);
  }

  /** Stop the probe (only `press`'s, when named). */
  private stopProbe(press?: number): void {
    const probe = this.unanswered;
    if (probe === undefined || (press !== undefined && probe.press !== press)) {
      return;
    }
    this.deps.clearInterval(probe.timer);
    this.unanswered = undefined;
  }

  /** This probe stopped (its press ended, the wallet answered, a close) while a tick awaited. */
  private probeGone(probe: Probe): boolean {
    return this.unanswered !== probe || this.stale(probe.press);
  }

  private async probeTick(probe: Probe): Promise<void> {
    if (probe.ticking || this.probeGone(probe)) {
      return;
    }
    probe.ticking = true;
    try {
      const stored = await this.deps.store.get(probe.orderId);
      if (this.probeGone(probe) || stored?.marker === undefined) {
        return;
      }
      // A retry's predecessor, already proven over: never judged or counted again.
      if (this.overAttemptIds.has(stored.marker.attemptId)) {
        return;
      }
      this.attemptOver = false;
      const shown = this.record;
      if (shown?.orderId === probe.orderId) {
        // The marker reaches the record on screen here (the press holds the pre-marker copy).
        if (stored.version > shown.version || shown.marker === undefined) {
          this.record = stored;
        }
      }
      const marker = stored.marker;
      const tempo = marker.rail === 'tempo';
      if (!tempo) {
        this.readRetryEstimate(stored, probe.generation);
      }
      const startOverIn = tempo ? this.requestCountdown(stored) : this.retryCountdown(stored);
      const unsureAt = marker.setAt + UNSURE_AFTER_SECS;
      const key = `${startOverIn === undefined ? '' : startOverIn.at + startOverIn.seconds}/${unsureAt}`;
      if (key !== probe.drawn) {
        probe.drawn = key;
        this.working('signing', false, {
          ...(startOverIn === undefined ? {} : { startOverIn }),
          unsureAt,
        });
      }
      const watched = await this.watchOnce(stored);
      if (this.probeGone(probe) || watched === undefined) {
        return;
      }
      if (watched.state !== 'over' && watched.state !== 'paid' && watched.state !== 'blocked') {
        // Waiting, unsure, or the store answered: the press keeps waiting for the wallet.
        return;
      }
      // Proven over, paid or blocked: the press ends here; the wallet's answer, when
      // it comes, is a late one.
      this.endPress();
      const applied = await this.applyVerdict(watched, probe.generation);
      if (this.resets !== probe.resets || this.disposed) {
        return;
      }
      const record = this.record;
      if ((applied === 'follow' || applied === 'replaced') && record !== undefined) {
        // Followed as the press would have: the watch, the receipt resent, the republishing.
        await this.follow(record);
      } else if (applied === 'skipped' && !this.busy && !this.pressing) {
        // What the press's own end would have drawn: a finished order, a held answer.
        if (record !== undefined && isTerminal(record) && !this.refused) {
          this.render();
        }
        void this.showPendingAnswer();
      }
    } finally {
      probe.ticking = false;
    }
  }

  /**
   * The wallet answered a press that is no longer the current one (a close, or
   * the probe's verdict). Its money bookkeeping always runs: an order that may
   * still land is followed in the background, a hash is remembered and watched.
   * It never draws a screen of its own: the order's own screen is refreshed only
   * while the modal stayed open, and after a close at most a line clears.
   * `pressResets`: the close count when the press began.
   */
  private async lateAnswer(
    result: SolanaPayResult | TempoPayResult,
    pressResets: number,
    wallet?: TempoWallet,
  ): Promise<void> {
    const resets = this.resets;
    const hash = 'hash' in result ? result.hash : undefined;
    if (result.ok && hash !== undefined) {
      this.sentHash.set(result.record.orderId, hash);
    }
    if (!result.ok && 'attemptId' in result && result.attemptId !== undefined) {
      // A Solana answer of its attempt: what it says of the attempt still counts (never
      // over what is said of a newer attempt), and a handle of that attempt is let go
      // unless the wallet only failed again.
      if (
        this.againFlags === undefined ||
        this.againFlags.attemptId === result.attemptId ||
        this.record?.marker?.attemptId === result.attemptId
      ) {
        this.rewriteAgainFlags(result);
      }
      if (
        this.againOffer?.handle.attemptId === result.attemptId &&
        result.reason !== 'wallet_failed'
      ) {
        this.againOffer = undefined;
      }
    }
    const bundle =
      result.ok && 'bundleId' in result && wallet !== undefined
        ? {
            hold: { orderId: result.record.orderId, bundleId: result.bundleId, wallet },
            unsaved: result.bundleUnsaved === true,
          }
        : undefined;
    if (bundle !== undefined) {
      this.bundleWallets.set(bundle.hold.orderId, bundle.hold.wallet);
    }
    const record = result.record;
    if (record === undefined) {
      return;
    }
    const orderId = record.orderId;
    const stored = (await this.deps.store.get(orderId)) ?? record;
    // An unsaved bundle of an order still paying holds it in this session (the
    // background tick passes it on); one of an order ended meanwhile is late.
    if (bundle?.unsaved === true && !gone(stored)) {
      this.pendingBundle = bundle.hold;
    }
    const shown = this.record?.orderId === orderId;
    if (!shown && followable(stored)) {
      this.followOwn(stored);
    }
    if (continuedUnpaid(stored)) {
      this.narrowFollower(orderId);
    }
    if (gone(stored)) {
      this.stopFollowing(orderId);
      if (!shown && (this.resets !== pressResets || this.quiet.has(orderId))) {
        this.quiet.add(orderId);
      }
      if (hash !== undefined && result.ok) {
        // Approved for an order that ended meanwhile: watched until it is found.
        this.watchLateHash(stored, hash);
      }
      if (bundle?.unsaved === true) {
        this.watchLateBundle(stored, bundle.hold);
      }
      this.listenToEnded([stored], stored.inboxRelays);
    }
    if (!holdsPayExclusion(stored)) {
      this.ownFreed(orderId);
    }
    if (this.resets !== resets || this.disposed || this.busy || this.pressing) {
      return;
    }
    if (this.resets !== pressResets) {
      // Closed since the press began: the first step stays; a line may clear.
      return;
    }
    if (shown) {
      // The modal stayed open (a probe verdict ended the press): its order, as stored.
      this.record = stored;
      if (stored.marker === undefined) {
        this.attemptOver = false;
      }
      this.render();
      return;
    }
    if (
      (hash !== undefined || bundle?.unsaved === true) &&
      gone(stored) &&
      !this.quiet.has(orderId) &&
      this.shownView?.kind === 'offer'
    ) {
      this.showOffer({ reason: 'late_approval' });
    }
  }

  // ---- the press after a close: an earlier payment --------------------------

  /**
   * Before the wallet is asked anything: an order of this account that may
   * still land holds the product. One pass on its rail; proven over, it is
   * ended (proven again) and the press goes on; otherwise its line, and `true`:
   * the press stops, no wallet request.
   */
  private async earlierPayment(press: number): Promise<boolean> {
    this.working('checking');
    const all = await this.deps.store.forProduct(this.offer.productAddress);
    if (this.stale(press)) {
      return true;
    }
    const holders = all.filter((record) => this.own(record) && holdsPayExclusion(record));
    for (const holder of holders) {
      if (this.record?.orderId === holder.orderId) {
        // Never drawn or told again: it goes on in the background.
        this.setRecord(undefined);
      }
      this.followOwn(holder);
    }
    for (const holder of holders) {
      const pendingHash = this.sentHash.get(holder.orderId);
      // An approved bundle is asked about first, through the wallet that approved it.
      const observed = await this.observeBundle(holder);
      if (this.stale(press)) {
        return true;
      }
      const watched = await this.watchOnce(observed.record, pendingHash);
      if (this.stale(press)) {
        return true;
      }
      if (watched?.state === 'over') {
        const ended = await this.endOrder(watched.record, {
          ...(pendingHash === undefined ? {} : { pendingHash }),
          ...this.bundleHold(holder.orderId),
        });
        if (ended.ended) {
          this.stopFollowing(holder.orderId);
          this.quiet.add(holder.orderId);
          this.listenToEnded([ended.record], ended.record.inboxRelays);
        }
        if (this.stale(press)) {
          return true;
        }
        if (ended.ended) {
          continue;
        }
      }
      // Read again after the pass: a holder that no longer holds is no line.
      const fresh = await this.deps.store.get(holder.orderId);
      if (this.stale(press)) {
        return true;
      }
      if (fresh === undefined || !holdsPayExclusion(fresh) || watched?.state === 'closed') {
        continue;
      }
      const line = await this.holderLine(fresh);
      if (this.stale(press)) {
        return true;
      }
      this.showLine(fresh.orderId, observed.reachable ? line : { ...line, checkWallet: true });
      return true;
    }
    return false;
  }

  /** The earlier-payment line for a holder of this account, from its stored record. */
  private async holderLine(holder: OrderRecord): Promise<EarlierPayment> {
    if (holder.state === 'paid' || holder.paidTx !== undefined) {
      return {
        reason: 'earlier_payment',
        phase: 'waiting_store',
        ...(holder.status?.status === 'cancelled' ? { cancelled: true } : {}),
      };
    }
    const marker = holder.marker;
    if (marker?.rail === 'tempo') {
      const known = marker.txHash ?? this.sentHash.get(holder.orderId);
      // A bundle the wallet reported failed is no approval: its request counts down.
      const approvedBundle =
        (marker.bundleId !== undefined && marker.bundleFailed !== true) ||
        this.pendingBundle?.orderId === holder.orderId;
      if (known !== undefined || approvedBundle) {
        // Approved: being confirmed, with nothing to count down.
        return { reason: 'earlier_payment', phase: 'confirming' };
      }
      const retryIn = this.requestCountdown(holder);
      return {
        reason: 'earlier_payment',
        phase: 'tempo_request',
        ...(retryIn === undefined ? {} : { retryIn }),
      };
    }
    const retryIn = marker?.rail === 'solana' ? await this.holderCountdown(holder) : undefined;
    return {
      reason: 'earlier_payment',
      phase: 'confirming',
      ...(retryIn === undefined ? {} : { retryIn }),
    };
  }

  /** About when a holder's Solana attempt can be proven over: one bounded height read. */
  private async holderCountdown(holder: OrderRecord): Promise<Countdown | undefined> {
    const marker = holder.marker;
    const rpc = this.rpcOfRecord(holder);
    if (marker?.rail !== 'solana' || rpc === undefined) {
      return undefined;
    }
    try {
      const lastValid = BigInt(marker.lastValidBlockHeight);
      const epoch = await rpc
        .getEpochInfo({ commitment: 'finalized' })
        .send({ abortSignal: AbortSignal.timeout(EPOCH_READ_TIMEOUT_MS) });
      return {
        seconds: settleSeconds(lastValid, BigInt(epoch.blockHeight)).seconds,
        at: this.deps.now(),
      };
    } catch {
      return undefined;
    }
  }

  // ---- internals -----------------------------------------------------------

  /** The record is the page's own account's (the same reference, or none on both). */
  private own(record: OrderRecord): boolean {
    return sameRef(record, this.customerRef);
  }

  /** Every view goes here: the "another purchase" note is tracked by what is on screen. */
  private show(view: View): void {
    const reason = view.kind === 'offer' ? view.problem?.reason : undefined;
    this.noteShown = reason === 'other_purchase' || reason === 'earlier_payment';
    if (!this.noteShown) {
      // The note that was freed is gone: a note drawn later names another holder.
      this.exclusionFreed = false;
    }
    if (reason !== 'earlier_payment') {
      this.lineHolder = undefined;
      // The line is no longer on screen: a redraw of the offer never brings it back
      // without the holder it names (that line would never clear by itself).
      if (this.offerProblem?.reason === 'earlier_payment') {
        this.offerProblem = undefined;
      }
    }
    this.shownView = view;
    this.deps.onView(view);
  }

  /**
   * Resolve another account's order that holds the product, showing nothing:
   * the store's answers are stored, and its own rail is watched (an attempt
   * proven over is ended). Once it no longer holds the product, the offer
   * shows again. One follower per order, one tick at a time.
   */
  private followOther(record: OrderRecord): void {
    const orderId = record.orderId;
    if (this.disposed || this.own(record) || this.followers.has(orderId)) {
      return;
    }
    const listener = listenForStatus(record, record.inboxRelays, this.orderDeps(), (message) => {
      void applyStatus(this.deps.store, orderId, message, this.deps.now()).catch(() => undefined);
    });
    const follower: Follower = {
      timer: undefined,
      listener,
      republish: undefined,
      relays: record.inboxRelays,
      ticking: false,
    };
    const tick = async () => {
      if (follower.ticking || this.disposed || this.followers.get(orderId) !== follower) {
        return;
      }
      follower.ticking = true;
      try {
        const current = await this.deps.store.get(orderId);
        if (current === undefined || !holdsPayExclusion(current)) {
          this.stopFollowing(orderId);
          this.exclusionFreedNow();
          return;
        }
        if (await this.resolveOther(current)) {
          this.stopFollowing(orderId);
          this.exclusionFreedNow();
        }
      } finally {
        follower.ticking = false;
      }
    };
    follower.timer = this.deps.setInterval(
      () => void tick().catch(() => undefined),
      WATCH_EVERY_MS,
    );
    this.followers.set(orderId, follower);
    void tick().catch(() => undefined);
  }

  /**
   * One silent pass over another account's order on its own rail: `true` once
   * it no longer holds the product (an attempt proven over and ended).
   */
  private async resolveOther(record: OrderRecord): Promise<boolean> {
    if (recordRail(record) === 'tempo') {
      const client = this.tempoOfRecord(record);
      if (client === undefined) {
        return false;
      }
      const holds = this.bundleHold(record.orderId);
      const watched = await watchTempoPayment(record, this.tempoDeps(client), holds);
      if (watched.state !== 'over') {
        return !holdsPayExclusion(watched.record);
      }
      const ended = await endTempoOrder(watched.record, this.tempoDeps(client), holds);
      return ended.ended;
    }
    const rpc = this.rpcOfRecord(record);
    if (rpc === undefined) {
      return false;
    }
    const watched = await watchSolanaPayment(record, this.payDeps(rpc));
    if (watched.state !== 'over') {
      return !holdsPayExclusion(watched.record);
    }
    const ended = await endSolanaOrder(watched.record, this.payDeps(rpc));
    return ended.ended;
  }

  /**
   * Follow this account's order in the background, with no screen: everything
   * the foreground does for it (the listener, the republishing with the relay
   * move, the rail's watch) and nothing more but one end: an attempt proven
   * over, proven again by `endOrder`, is ended. It posts nothing and draws
   * nothing: its outcome is stored, under "Your purchases". One per order.
   */
  private followOwn(record: OrderRecord, relays?: readonly string[]): void {
    const orderId = record.orderId;
    this.quiet.add(orderId);
    if (this.disposed || !this.own(record)) {
      return;
    }
    const existing = this.followers.get(orderId);
    if (existing !== undefined) {
      // Narrowed to its listener, or its tick stopped (open again), now holding again
      // (another tab paid it): whatever of the two is missing is armed again.
      if (followable(record)) {
        this.armOwn(record, existing);
      }
      return;
    }
    const heardOn = relays === undefined ? record.inboxRelays : [...relays];
    const follower: Follower = {
      timer: undefined,
      listener: this.listenInBackground(record, heardOn),
      republish: undefined,
      relays: heardOn,
      ticking: false,
    };
    this.followers.set(orderId, follower);
    this.armOwn(record, follower);
  }

  /**
   * A backgrounded order's republishing and, while it holds the product, its rail
   * tick: each armed only when it is not running yet (never two of one).
   */
  private armOwn(record: OrderRecord, follower: Follower): void {
    const orderId = record.orderId;
    const republishArmed = follower.republish === undefined;
    if (republishArmed) {
      follower.republish = this.deps.setInterval(
        () => void this.republishOwn(orderId, follower).catch(() => undefined),
        REPUBLISH_EVERY_MS,
      );
    }
    if (follower.timer === undefined && holdsPayExclusion(record)) {
      follower.timer = this.deps.setInterval(
        () => void this.tickOwn(orderId, follower).catch(() => undefined),
        WATCH_EVERY_MS,
      );
    }
    if (republishArmed) {
      // The order and its receipt go out again now, never awaited by a draw.
      void Promise.resolve()
        .then(() => this.republishOwn(orderId, follower))
        .catch(() => undefined);
    }
  }

  /** A background listener for this account's order: its answers are stored, nothing else. */
  private listenInBackground(record: OrderRecord, relays: readonly string[]): { close(): void } {
    const orderId = record.orderId;
    return listenForStatus(record, relays, this.orderDeps(), (message) => {
      void applyStatus(this.deps.store, orderId, message, this.deps.now())
        .then((updated) => {
          if (updated !== undefined && (isTerminal(updated) || gone(updated))) {
            this.stopFollowing(orderId);
            this.ownFreed(orderId);
          }
        })
        .catch(() => undefined);
    });
  }

  /** Publish a backgrounded order again, moving its listener when the store reads elsewhere. */
  private async republishOwn(orderId: string, follower: Follower): Promise<void> {
    if (this.disposed || this.followers.get(orderId) !== follower) {
      return;
    }
    const fresh = await this.deps.store.get(orderId);
    if (this.followers.get(orderId) !== follower) {
      return;
    }
    if (fresh === undefined || isTerminal(fresh) || gone(fresh)) {
      this.stopFollowing(orderId);
      this.ownFreed(orderId);
      return;
    }
    if (continuedUnpaid(fresh)) {
      this.narrowFollower(orderId);
      return;
    }
    const resumed = await resumeOrder(fresh, this.orderDeps(), this.deps.now());
    if (this.disposed || this.followers.get(orderId) !== follower) {
      return;
    }
    const moved =
      resumed.relays.length !== follower.relays.length ||
      resumed.relays.some((relay) => !follower.relays.includes(relay));
    if (moved) {
      follower.relays = resumed.relays;
      follower.listener.close();
      follower.listener = this.listenInBackground(resumed.record, resumed.relays);
    }
  }

  /** One pass of a backgrounded order's rail, while it holds the product. */
  private async tickOwn(orderId: string, follower: Follower): Promise<void> {
    if (follower.ticking || this.disposed || this.followers.get(orderId) !== follower) {
      return;
    }
    follower.ticking = true;
    try {
      const current = await this.deps.store.get(orderId);
      if (this.followers.get(orderId) !== follower) {
        return;
      }
      if (current === undefined || isTerminal(current) || gone(current)) {
        this.stopFollowing(orderId);
        this.ownFreed(orderId);
        return;
      }
      if (continuedUnpaid(current)) {
        this.narrowFollower(orderId);
        return;
      }
      if (!holdsPayExclusion(current)) {
        // A blocked payment: its listener and republishing stay, the rail is done.
        this.stopTick(follower);
        this.ownFreed(orderId);
        return;
      }
      const watched = await this.watchOnce(current, this.sentHash.get(orderId));
      if (watched === undefined || this.followers.get(orderId) !== follower) {
        return;
      }
      if (watched.state !== 'over') {
        if (!holdsPayExclusion(watched.record)) {
          this.stopTick(follower);
          this.ownFreed(orderId);
        }
        return;
      }
      // Proven over: ended through `endOrder`, which proves it again before its one write.
      const pendingHash = this.sentHash.get(orderId);
      const ended = await this.endOrder(watched.record, {
        ...(pendingHash === undefined ? {} : { pendingHash }),
        ...this.bundleHold(orderId),
      });
      if (!ended.ended) {
        return;
      }
      this.stopFollowing(orderId);
      this.quiet.add(orderId);
      this.listenToEnded([ended.record], follower.relays);
      this.ownFreed(orderId);
    } finally {
      follower.ticking = false;
    }
  }

  /** A backgrounded order is open and unpaid again: only its listener stays (no republish, no rail). */
  private narrowFollower(orderId: string): void {
    const follower = this.followers.get(orderId);
    if (follower !== undefined) {
      this.stopTick(follower);
      if (follower.republish !== undefined) {
        this.deps.clearInterval(follower.republish);
        follower.republish = undefined;
      }
    }
    this.ownFreed(orderId);
  }

  private stopTick(follower: Follower): void {
    if (follower.timer !== undefined) {
      this.deps.clearInterval(follower.timer);
      follower.timer = undefined;
    }
  }

  private stopFollowing(orderId: string): void {
    const follower = this.followers.get(orderId);
    if (follower === undefined) {
      return;
    }
    this.stopTick(follower);
    if (follower.republish !== undefined) {
      this.deps.clearInterval(follower.republish);
    }
    follower.listener.close();
    this.followers.delete(orderId);
  }

  /**
   * Another account's order stopped holding the product: the note gives way to
   * the offer - now if nothing else is going on, else at the end of the press.
   */
  private exclusionFreedNow(): void {
    if (!this.noteShown) {
      return;
    }
    if (this.busy || this.pressing) {
      this.exclusionFreed = true;
      return;
    }
    this.redrawNote();
  }

  /**
   * An order of this account stopped holding the product: only the earlier-payment
   * line that names it gives way (another account's note waits for its own holder).
   */
  private ownFreed(orderId: string): void {
    if (this.lineHolder !== orderId || !this.earlierPaymentShown()) {
      return;
    }
    this.exclusionFreedNow();
  }

  /** The earlier-payment line for `holderId`, on the offer. */
  private showLine(holderId: string, line: EarlierPayment): void {
    this.lineHolder = holderId;
    // A product freed earlier in the press was another holder's: never this new line's.
    this.exclusionFreed = false;
    this.showOffer(line);
    // A late approval holds the product in this session only: its store record never does.
    if (this.lateHash?.orderId !== holderId) {
      void this.freedWhileDrawn(holderId);
    }
  }

  /**
   * The holder read again once its line is up: one freed while the line was being
   * computed (its follower already gone, the line not yet up) clears it now.
   */
  private async freedWhileDrawn(holderId: string): Promise<void> {
    let record: OrderRecord | undefined;
    try {
      record = await this.deps.store.get(holderId);
    } catch {
      return;
    }
    if (record === undefined || !holdsPayExclusion(record)) {
      this.ownFreed(holderId);
    }
  }

  /** A press ended: a product freed during it shows its offer, if the note is still up. */
  private redrawIfFreed(): void {
    if (!this.exclusionFreed) {
      return;
    }
    this.exclusionFreed = false;
    this.redrawNote();
  }

  private redrawNote(): void {
    if (
      this.noteShown &&
      !this.busy &&
      !this.pressing &&
      this.oldPrompt === undefined &&
      !this.disposed &&
      !this.refused
    ) {
      this.showOffer();
      // An answer held back by the payment that held the product shows now.
      void this.showPendingAnswer();
    }
  }

  /**
   * The offer on screen says an earlier payment of this account holds the
   * product: like a live order on screen, it holds back other orders' answers.
   */
  private earlierPaymentShown(): boolean {
    const view = this.shownView;
    return view?.kind === 'offer' && view.problem?.reason === 'earlier_payment';
  }

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
      // A silent record the store finished meanwhile is dropped, never followed.
      const dropped = this.dropAnsweredSilent();
      // Show what is stored, never a screen the record does not back.
      const stored =
        this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
      if (this.stale(press)) {
        return;
      }
      if (stored === undefined || dropped || this.dropAnsweredSilent()) {
        this.setRecord(undefined);
        this.showOffer({ reason: 'failed' });
      } else {
        // A problem of the attempt on screen stays; one of another attempt never counts.
        const attemptId = stored.marker?.attemptId;
        if (this.attemptProblem === undefined || this.attemptProblem.attemptId !== attemptId) {
          this.setAttemptProblem({ reason: 'failed' }, attemptId);
        }
        await this.follow(stored, undefined, { reason: 'failed' });
      }
    } finally {
      if (this.busyOwner === press) {
        this.busy = false;
        this.busyOwner = undefined;
        if (this.cancellableFor === press) {
          this.cancellableFor = undefined;
        }
        this.stopProbe(press);
        this.dropAnsweredSilent();
        // The store answered the current order during the action: that answer shows.
        if (this.record !== undefined && isTerminal(this.record) && !this.refused) {
          this.render();
        }
        void this.showPendingAnswer();
      }
    }
  }

  /**
   * End an order that holds nothing yet, or whose attempt provably ended on its
   * own network. `pendingHash`: a Tempo hash returned in this session that could
   * not be stored (it still makes the attempt held).
   */
  private endOrder(
    record: OrderRecord,
    options: TempoWatchOptions = {},
  ): Promise<{ ended: boolean; record: OrderRecord }> {
    const tempo = recordRail(record) === 'tempo' ? this.tempoOfRecord(record) : undefined;
    const held = options.pendingHash !== undefined || options.pendingBundleId !== undefined;
    if (tempo !== undefined && held && record.state !== 'created') {
      return endTempoOrder(record, this.tempoDeps(tempo), options);
    }
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

  /** Settles once `work` settles (its outcome dropped) or after `ms`, whichever comes first. */
  private waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        this.deps.clearTimeout(timer);
        resolve();
      };
      const timer = this.deps.setTimeout(finish, ms);
      work.then(finish, finish);
    });
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

  private payDeps(rpc: Rpc<SolanaRpcApi>, scope?: PressScope) {
    return {
      store: scope === undefined ? this.deps.store : this.pressStore(scope),
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
      rpc,
      now: this.deps.now,
      feeTerms: this.deps.feeTerms,
    };
  }

  /**
   * The store as one press's pay rail sees it. A write that starts or replaces an
   * attempt (a marker) is refused once the press is stale: the rail then never
   * reaches the wallet. Every other write passes, stale or not: after the wallet
   * answered, the signature before its broadcast and the Tempo hash must be
   * stored. Every marker write that succeeds is the newest known copy; one that
   * lands after a close is followed in the background.
   */
  private pressStore(scope: PressScope): OrderStore {
    const store = this.deps.store;
    const latch = (written: StoreWrite): StoreWrite => {
      if (written.ok) {
        this.latchMarked(written.record, scope);
      }
      return written;
    };
    const refused: StoreWrite = { ok: false, reason: 'conflict' };
    const setMarker = async (...args: Parameters<OrderStore['setMarker']>) =>
      this.stale(scope.press) ? refused : latch(await store.setMarker(...args));
    const updateMarker = async (...args: Parameters<OrderStore['updateMarker']>) => {
      const [, , attemptId, next] = args;
      return this.stale(scope.press) && next.attemptId !== attemptId
        ? refused
        : latch(await store.updateMarker(...args));
    };
    const clearMarker = async (...args: Parameters<OrderStore['clearMarker']>) =>
      latch(await store.clearMarker(...args));
    return new Proxy(store, {
      get(target, property) {
        if (property === 'setMarker') {
          return setMarker;
        }
        if (property === 'updateMarker') {
          return updateMarker;
        }
        if (property === 'clearMarker') {
          return clearMarker;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * A marker write of a press succeeded: the newest known copy. Written after a
   * close (the press began before it), an order that may still land is followed
   * in the background and leaves the screen when no press runs.
   */
  private latchMarked(record: OrderRecord, scope: PressScope): void {
    this.marked = record;
    if (this.resets === scope.resets || !followable(record)) {
      return;
    }
    this.followOwn(record);
    if (this.record?.orderId === record.orderId && !this.busy && !this.pressing) {
      this.setRecord(undefined);
    }
  }

  private orderDeps(): OrderDeps {
    return {
      store: this.deps.store,
      readClient: this.deps.readClient,
      clientFor: this.deps.clientFor,
    };
  }

  private refuse(reason: RefusedReason, message: string): void {
    this.refused = true;
    this.show({
      kind: 'refused',
      reason,
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
  private async freshOffer(press: number): Promise<ReadyOffer | undefined> {
    if (!isSnapshotStale(this.offer.snapshotAt, this.deps.now())) {
      return this.offer;
    }
    const reloaded = await this.deps.reloadOffer();
    // Closed meanwhile: nothing of the reload is drawn over the first step.
    if (this.stale(press)) {
      return undefined;
    }
    if (!reloaded.ok) {
      const reason = reloaded.refusal === 'product_not_on_sale' ? 'sold_out' : 'offer_refused';
      return this.refusedOnReload(reason, reloaded.message);
    }
    if (this.customerRef !== undefined && reloaded.offer.level !== 'A') {
      return this.refusedOnReload('offer_refused', REF_NEEDS_VERIFIED_STORE);
    }
    // The fresh offer's own warnings are passed: only the payout and its amount decide.
    const verdict = compareOffers(this.payout, reloaded.confirm, reloaded);
    // The chosen payout is gone: only another one on the page's network replaces
    // it, never one on another network. None: refused, exactly as above.
    const fallback = this.payablePayouts(reloaded)[0];
    if (verdict === 'gone' && fallback === undefined) {
      return this.refusedOnReload('offer_refused', NO_PAYABLE_PAYOUT);
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
  private refusedOnReload(reason: RefusedReason, message: string): undefined {
    // The store no longer accepts this page: its trust level is not shown again.
    this.refusedHere = { reason, message };
    const live = this.record;
    if (live !== undefined && live.state !== 'created' && live.state !== 'ordered') {
      // No new payment, but the order that is paying or paid is still followed.
      this.render({ problem: { reason } });
      return undefined;
    }
    this.setRecord(undefined);
    this.refuse(reason, message);
    return undefined;
  }

  /**
   * The order to pay: the open acknowledged one when it is still for this
   * payout and price, else a new one. An order the store cancelled, or one on
   * old terms, ends first - and a new one starts only if it provably ended.
   * Acknowledged means the store's inbox holds it; the wallet never opens before.
   * `feeAllows` runs only before a new order is placed.
   */
  private async orderFor(
    chainTime: number,
    press: number,
    payer: string,
    feeAllows: () => Promise<boolean>,
  ): Promise<OrderRecord | undefined> {
    // An open order drawn at load is republished in the background: the press
    // waits for it here, after the wallet's connect and before its own re-read.
    const resuming = this.resuming;
    this.resuming = undefined;
    if (resuming !== undefined) {
      await resuming;
      if (this.stale(press)) {
        return undefined;
      }
    }
    // A press detached by a close may still be placing its order: the read below
    // sees it once stored, so it is adopted or ended, never paid beside.
    const placing = this.placing;
    if (placing !== undefined) {
      await this.waitAtMost(placing, PLACING_WAIT_MS);
      if (this.stale(press)) {
        return undefined;
      }
    }
    // Never a second open order beside one: this account's open orders, as stored now.
    if ((await this.openOrders(press)) === 'stop') {
      return undefined;
    }
    let record =
      this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
    if (this.stale(press)) {
      return undefined;
    }
    if (record !== undefined) {
      const settled = await this.settleCurrent(record, press);
      if (settled === 'stop') {
        return undefined;
      }
      if (settled === 'dropped') {
        record = undefined;
      }
    }
    const stale =
      record !== undefined &&
      (onOtherTerms(record, this.payout, this.customerRef) || this.emailChanged(record));
    if (record !== undefined && stale) {
      if (!(await this.endStale(record, press))) {
        return undefined;
      }
      record = undefined;
    }
    if (record?.state === 'created') {
      this.working('ordering');
      const resumed = await resumeOrder(record, this.orderDeps(), this.deps.now());
      if (this.stale(press)) {
        return undefined;
      }
      record = resumed.record;
      this.listenAgainOn(resumed.relays, record);
      if (record.state === 'ordered') {
        // Taken by the store only now: an answer it holds for it (a hand cancel or
        // refund) is read first, so such an order ends instead of being paid.
        record = await this.readHeldStatus(record);
        if (this.stale(press)) {
          return undefined;
        }
        const settled = await this.settleCurrent(record, press);
        if (settled === 'stop') {
          return undefined;
        }
        if (settled === 'dropped') {
          record = undefined;
        } else if (onOtherTerms(record, this.payout, this.customerRef)) {
          if (!(await this.endStale(record, press))) {
            return undefined;
          }
          record = undefined;
        }
      }
    }
    if (record === undefined) {
      if (!(await feeAllows())) {
        return undefined;
      }
      // The one place both rails decide on a new order: never one with an unusable email.
      if (this.emailUnusable()) {
        this.showOffer({ reason: 'bad_email' });
        return undefined;
      }
      // A reference credits an account: never on an offer that is not level A.
      if (this.customerRef !== undefined && this.offer.offer.level !== 'A') {
        this.setRecord(undefined);
        this.refuse('offer_refused', REF_NEEDS_VERIFIED_STORE);
        return undefined;
      }
      this.working('ordering');
      const email = this.deps.collectEmail === true ? usableEmail(this.email) : undefined;
      const placement = placeOrder(
        {
          offer: this.offer,
          payout: this.payout,
          chainTime,
          deviceTime: this.deps.now(),
          ...(email === undefined ? {} : { email }),
          ...(this.customerRef === undefined ? {} : { customerRef: this.customerRef }),
        },
        this.orderDeps(),
      );
      this.placing = placement;
      let placed: Awaited<typeof placement>;
      try {
        placed = await placement;
      } finally {
        if (this.placing === placement) {
          this.placing = undefined;
        }
      }
      // Sent with it whether or not the store took it yet: a resume sends the same order.
      if (placed.record !== undefined && email !== undefined) {
        this.sentEmail.set(placed.record.orderId, email);
      }
      // Closed meanwhile: the placed order stays stored; the next press pays or ends it.
      if (this.stale(press)) {
        return undefined;
      }
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
        // The press took it, and the buyer now sees its problem: no longer silent.
        this.silent = undefined;
        this.showOffer({ reason: 'order_not_acknowledged' });
      } else {
        await this.follow(record);
      }
      return undefined;
    }
    // The store answered a silent order during this press: never paid here. One that
    // holds the product (another tab paid it) is followed, its line shown; one that
    // finished or ended is dropped unseen.
    if (this.silentAnswered === record.orderId) {
      this.silentAnswered = undefined;
      this.setRecord(undefined);
      const stored = await this.deps.store.get(record.orderId);
      if (this.stale(press)) {
        return undefined;
      }
      if (stored === undefined || !followable(stored)) {
        this.showOffer();
        return undefined;
      }
      this.followOwn(stored);
      const line = await this.holderLine(stored);
      if (!this.stale(press)) {
        this.showLine(stored.orderId, line);
      }
      return undefined;
    }
    // The press commits to this order: its store answers show from now on.
    this.silent = undefined;
    this.status('ordered');
    // A Tempo request is composed at the pay press (after the checks), in the core.
    if (recordRail(record) === 'tempo') {
      this.listen(record);
      return record;
    }
    const composed = await composeOrderPayment(record, this.deps.store, {
      offer: this.offer.offer,
      feeTerms: this.deps.feeTerms,
      payer,
    });
    if (this.stale(press)) {
      return undefined;
    }
    if (!composed.ok) {
      await this.composeRefused(record, composed.reason, press);
      return undefined;
    }
    this.record = composed.record;
    this.listen(composed.record);
    return composed.record;
  }

  /**
   * The order's request could not be composed. `store_outdated`: this order
   * can never be paid as it is, so it ends (nothing was requested) and the
   * product is free again. The fee terms unreadable or unusable: the order is
   * left as it is, nothing was paid. Anything else: it could not be prepared.
   */
  private async composeRefused(
    record: OrderRecord,
    reason: Extract<ComposeOrderPaymentResult, { ok: false }>['reason'],
    press: number,
  ): Promise<void> {
    if (reason === 'fee_config_unavailable' || reason === 'fee_config_invalid') {
      this.showOffer({ reason });
      return;
    }
    if (reason !== 'store_outdated') {
      this.showOffer({ reason: 'failed' });
      return;
    }
    const ended = await this.endOrder(record);
    if (this.stale(press)) {
      return;
    }
    if (ended.ended) {
      const relays = this.relays;
      this.setRecord(undefined);
      this.listenToEnded([ended.record], relays);
      this.status('ended');
    }
    this.showOffer({ reason: 'store_outdated' });
  }

  /**
   * This account's open orders of the product, read from the store at the press:
   * the one to pay becomes `this.record` (checked for held store answers before
   * it is adopted), every other one (and every one the store cancelled) ends.
   * `stop`: the press stopped and drew why.
   */
  private async openOrders(press: number): Promise<'go' | 'stop'> {
    const all = await this.deps.store.forProduct(this.offer.productAddress);
    if (this.stale(press)) {
      return 'stop';
    }
    const own = all.filter((record) => this.own(record));
    const current = this.record;
    const storedCurrent =
      current === undefined ? undefined : own.find((record) => record.orderId === current.orderId);
    if (
      storedCurrent !== undefined &&
      !continuedUnpaid(storedCurrent) &&
      !cancelledUnpaid(storedCurrent) &&
      (await this.settleCurrent(storedCurrent, press)) === 'stop'
    ) {
      return 'stop';
    }
    const candidates = own.filter((record) => continuedUnpaid(record));
    const toEnd = own.filter((record) => cancelledUnpaid(record));
    const onTheseTerms = (record: OrderRecord) =>
      !onOtherTerms(record, this.payout, this.customerRef) && !this.emailChanged(record);
    const shownId = this.record?.orderId;
    let pick = candidates.find((record) => record.orderId === shownId && onTheseTerms(record));
    const passed = new Set<string>();
    while (pick === undefined) {
      const rest = candidates
        .filter((record) => record.orderId !== shownId && !passed.has(record.orderId))
        .sort((left, right) => right.createdAt - left.createdAt);
      const choice =
        rest.find((record) => record.state === 'ordered' && onTheseTerms(record)) ?? rest[0];
      if (choice === undefined) {
        break;
      }
      passed.add(choice.orderId);
      const checked = await this.checkCandidate(choice, press);
      if (checked === 'stop') {
        return 'stop';
      }
      if (checked === 'skip') {
        continue;
      }
      if (checked.kind === 'cancelled') {
        toEnd.push(checked.record);
        continue;
      }
      pick = checked.record;
    }
    const pickedId = pick?.orderId;
    for (const record of candidates) {
      if (record.orderId !== pickedId && !passed.has(record.orderId)) {
        toEnd.push(record);
      }
    }
    let exhausted = false;
    for (const record of toEnd) {
      const outcome = await this.endOpen(record, press);
      if (outcome === 'stale') {
        return 'stop';
      }
      exhausted ||= outcome === 'exhausted';
    }
    if (exhausted) {
      // An open order that cannot be ended: never a second one placed beside it.
      this.showOffer({ reason: 'failed' });
      return 'stop';
    }
    return 'go';
  }

  /**
   * A candidate to pay that is not on screen: its held store answers read (on
   * its own relays) and the store read again before it is adopted, with no
   * await between that read and the adoption.
   */
  private async checkCandidate(
    choice: OrderRecord,
    press: number,
  ): Promise<
    | 'stop'
    | 'skip'
    | { kind: 'adopted'; record: OrderRecord }
    | { kind: 'cancelled'; record: OrderRecord }
  > {
    await this.readHeldStatus(choice, choice.inboxRelays);
    if (this.stale(press)) {
      return 'stop';
    }
    const fresh = await this.deps.store.get(choice.orderId);
    if (this.stale(press)) {
      return 'stop';
    }
    if ((await this.recheckCurrent(press)) === 'stop') {
      return 'stop';
    }
    if (fresh === undefined || isTerminal(fresh) || gone(fresh)) {
      return 'skip';
    }
    if (cancelledUnpaid(fresh)) {
      return { kind: 'cancelled', record: fresh };
    }
    if (!continuedUnpaid(fresh)) {
      // Marked or paid meanwhile (another tab): it holds the product.
      if (followable(fresh)) {
        this.followOwn(fresh);
      }
      const line = await this.holderLine(fresh);
      if (!this.stale(press)) {
        this.showLine(fresh.orderId, line);
      }
      return 'stop';
    }
    this.stopFollowing(fresh.orderId);
    this.quiet.delete(fresh.orderId);
    this.setRecord(fresh);
    this.relays = fresh.inboxRelays;
    // Not the buyer's yet: an answer that finishes it before the press commits is stored only.
    this.silent = fresh.orderId;
    this.listen(fresh);
    return { kind: 'adopted', record: fresh };
  }

  /** `this.record` read again: one that is no longer open is settled (`settleCurrent`). */
  private async recheckCurrent(press: number): Promise<'go' | 'stop'> {
    const current = this.record;
    if (current === undefined) {
      return 'go';
    }
    const stored = await this.deps.store.get(current.orderId);
    if (this.stale(press)) {
      return 'stop';
    }
    if (stored === undefined || continuedUnpaid(stored) || cancelledUnpaid(stored)) {
      return 'go';
    }
    return (await this.settleCurrent(stored, press)) === 'stop' ? 'stop' : 'go';
  }

  /**
   * `this.record` as stored at a re-read of a press. Open: kept. The buyer's
   * own (engaged) order that finished, ended elsewhere, holds or is blocked:
   * followed (today's behaviour), the press stops. A silent one
   * that finished: dropped unseen; one that holds: followed in the background,
   * its earlier-payment line, the press stops.
   */
  private async settleCurrent(
    stored: OrderRecord,
    press: number,
  ): Promise<'keep' | 'dropped' | 'stop'> {
    const orderId = stored.orderId;
    const answered = this.silentAnswered === orderId;
    const silent = this.silent === orderId || answered;
    // A copy read before the answer was stored still looks open: the flag stays for
    // the commit site.
    if (this.record?.orderId !== orderId || continuedUnpaid(stored) || cancelledUnpaid(stored)) {
      return 'keep';
    }
    if (answered) {
      this.silentAnswered = undefined;
    }
    if (!silent) {
      await this.follow(stored);
      return 'stop';
    }
    this.setRecord(undefined);
    if (isTerminal(stored) || gone(stored)) {
      return 'dropped';
    }
    if (followable(stored)) {
      this.followOwn(stored);
    }
    const line = await this.holderLine(stored);
    if (!this.stale(press)) {
      this.showLine(stored.orderId, line);
    }
    return 'stop';
  }

  /**
   * End an open order beside the one paid (a version compare-and-swap), reading
   * it again after a lost one. `left`: it holds or ended meanwhile (another tab);
   * `exhausted`: still open after every attempt.
   */
  private async endOpen(
    record: OrderRecord,
    press: number,
  ): Promise<'ended' | 'left' | 'exhausted' | 'stale'> {
    let current = record;
    for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS; attempt += 1) {
      const ended = await this.endOrder(current);
      if (ended.ended) {
        this.stopFollowing(current.orderId);
        this.quiet.add(current.orderId);
        this.listenToEnded([ended.record]);
        if (this.stale(press)) {
          return 'stale';
        }
        // The order on screen, ended by this press: no longer the buyer's (as `endStale`).
        if (this.record?.orderId === current.orderId) {
          this.setRecord(undefined);
        }
        return 'ended';
      }
      const fresh = await this.deps.store.get(current.orderId);
      if (this.stale(press)) {
        return 'stale';
      }
      if (fresh === undefined || !(continuedUnpaid(fresh) || cancelledUnpaid(fresh))) {
        return 'left';
      }
      current = fresh;
    }
    return 'exhausted';
  }

  /**
   * End an open order that cannot be paid as it is (other terms, a typed email,
   * a store cancel): `true` once it ended. An attempt that may still land is
   * followed instead (`false`), never a second order beside it.
   */
  private async endStale(record: OrderRecord, press: number): Promise<boolean> {
    const ended = await this.endOrder(record);
    if (this.stale(press)) {
      return false;
    }
    if (!ended.ended) {
      await this.follow(ended.record);
      return false;
    }
    this.setRecord(undefined);
    return true;
  }

  /**
   * One read of the store's answers already sent for `record` (the same wraps the
   * listener hears), each stored, bounded by `HELD_STATUS_READ_MS`. A read that
   * fails or runs out finds nothing; the listener still hears it later.
   * `relays`: where to read (the record's own when it is not on screen).
   */
  private async readHeldStatus(
    record: OrderRecord,
    relays?: readonly string[],
  ): Promise<OrderRecord> {
    const client = this.deps.clientFor(hexToBytes(record.buyerSecretKey));
    let timer: unknown;
    const timedOut = new Promise<[]>((resolve) => {
      timer = this.deps.setTimeout(() => resolve([]), HELD_STATUS_READ_MS);
    });
    try {
      const readOn = relays ?? (this.relays.length === 0 ? record.inboxRelays : this.relays);
      const wraps = await Promise.race([
        client.query(readOn, [
          {
            kinds: [KIND_GIFT_WRAP],
            '#p': [record.buyerPubkey],
            since: record.createdAt - WRAP_BACKDATE_SECS - MAX_FUTURE_SKEW_SECS,
          },
        ]),
        timedOut,
      ]);
      for (const wrap of wraps) {
        const status = statusFor(record, wrap);
        if (status !== undefined) {
          await applyStatus(this.deps.store, record.orderId, status, this.deps.now());
        }
      }
    } catch {
      // Nothing read: the listener still hears an answer later.
    } finally {
      this.deps.clearTimeout(timer);
      client.close();
    }
    return (await this.deps.store.get(record.orderId)) ?? record;
  }

  private async afterPay(
    result: SolanaPayResult,
    rpc: Rpc<SolanaRpcApi>,
    press: number,
    resets: number,
    walletName: string,
  ): Promise<void> {
    // The press is current here: its answer decides whether the same wallet may be asked again.
    this.againOffer =
      !result.ok && result.again !== undefined ? { handle: result.again, walletName } : undefined;
    this.rewriteAgainFlags(result);
    // Decided before anything is awaited too: a store failure next never leaves an earlier
    // problem of this attempt that this answer proved false.
    this.noteAnswerProblem(result);
    if (result.record !== undefined) {
      // The store may have answered meanwhile: what is stored wins over the core's copy.
      const stored = await this.deps.store.get(result.record.orderId);
      if (this.stale(press)) {
        await this.lateAnswer(result, resets);
        return;
      }
      this.setRecord(stored !== undefined && isTerminal(stored) ? stored : result.record);
      if (stored !== undefined && isTerminal(stored)) {
        await this.follow(stored);
        return;
      }
    }
    if (!result.ok && result.afterMarker === true) {
      await this.afterLiveRefusal(result);
      return;
    }
    if (result.ok) {
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
      case 'store_outdated':
      case 'too_late': {
        // Nothing was requested for this attempt: the order ends only if it provably did.
        const current = this.record;
        const ended =
          current === undefined ? undefined : await endSolanaOrder(current, this.payDeps(rpc));
        if (this.stale(press)) {
          return;
        }
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
        // The attempt waits for expiry (its problem was noted as the answer came).
        this.attemptOver = false;
        if (this.record !== undefined) {
          await this.follow(this.record);
        }
        return;
      case 'self_payment':
      case 'rpc_error':
      case 'fee_config_unavailable':
      case 'fee_config_invalid':
        // Nothing was requested: the record is left as it is for a later press.
        this.showOrWait({ reason: result.reason });
        return;
      case 'needs_confirmation':
        await this.askOldPrompt(result.unconfirmed ?? [], press);
        return;
      case 'exclusion':
        // Another order of this product holds a live attempt: never a second request.
        await this.metHolder(result.holder, press);
        return;
      default: {
        if (result.reason === 'still_waiting' || result.reason === 'already_paid') {
          this.attemptOver = false;
        }
        const current =
          this.record === undefined ? undefined : await this.deps.store.get(this.record.orderId);
        if (this.stale(press)) {
          await this.lateAnswer(result, resets);
          return;
        }
        if (current !== undefined) {
          await this.follow(current);
        } else {
          this.showOffer({ reason: 'failed' });
        }
      }
    }
  }

  /**
   * A refusal that left this call's attempt live (`afterMarker`): never a retry
   * (the attempt may still land), the watch follows it again. What the buyer can
   * act on stays as the attempt's problem (a read that failed, another account,
   * the fee); a transaction seen, a request about to expire and an answer not
   * sent say so on their own line.
   */
  private async afterLiveRefusal(result: Extract<SolanaPayResult, { ok: false }>): Promise<void> {
    this.attemptOver = false;
    const record = result.record ?? this.record;
    if (record !== undefined) {
      await this.follow(record);
    }
  }

  /**
   * The attempt's problem an answer leaves (`afterPay`, as soon as it comes). A live
   * refusal keeps what the buyer can act on (a read that failed, another account, the
   * fee); a transaction seen, a request about to expire and an answer not sent say so
   * on their own line. A wallet that failed or changed the transaction says that.
   */
  private noteAnswerProblem(result: SolanaPayResult): void {
    if (result.ok) {
      // Signed and recorded: no earlier problem of the attempt holds any more.
      this.attemptProblem = undefined;
      return;
    }
    const attemptId = result.attemptId;
    if (result.afterMarker === true) {
      if (result.reason === 'rpc_error' && result.signedNotSent !== true) {
        this.setAttemptProblem({ reason: 'rpc_error' }, attemptId);
      } else if (result.reason === 'other_payer' && result.again !== undefined) {
        this.setAttemptProblem({ reason: 'other_payer', payer: result.again.payer }, attemptId);
      } else if (result.reason === 'insufficient_sol') {
        this.setAttemptProblem(
          {
            reason: 'insufficient_sol',
            needed: result.needed ?? 0n,
            available: result.available ?? 0n,
          },
          attemptId,
        );
      } else {
        this.attemptProblem = undefined;
      }
    } else if (result.signedNotSent === true) {
      // Signed, and every write of the answer lost: the checkout's own failure, never the wallet's.
      this.setAttemptProblem({ reason: 'failed' }, attemptId);
    } else if (result.reason === 'wallet_failed' || result.reason === 'wallet_unsupported') {
      // Only an explicit decline proves nothing was signed: the attempt waits for expiry.
      this.setAttemptProblem(
        result.reason === 'wallet_failed' && result.declined === true
          ? { reason: 'wallet_failed', declined: true }
          : { reason: result.reason },
        attemptId,
      );
    }
  }

  private setAttemptProblem(problem: Problem, attemptId: string | undefined): void {
    this.attemptProblem = { problem, attemptId };
  }

  /**
   * What a Solana answer says of its attempt: a request about to expire and a
   * transaction seen stay said for that attempt; whether the wallet's answer was
   * not sent is said by the attempt's last answer only.
   */
  private rewriteAgainFlags(result: SolanaPayResult): void {
    const attemptId = result.ok ? result.record.marker?.attemptId : result.attemptId;
    if (attemptId === undefined) {
      return;
    }
    const kept = this.againFlags?.attemptId === attemptId ? this.againFlags : undefined;
    const refusal = result.ok ? undefined : result;
    const expiring = kept?.expiring === true || refusal?.reason === 'request_expiring';
    const seenOnChain =
      kept?.seenOnChain === true ||
      (refusal?.reason === 'still_waiting' && refusal.afterMarker === true);
    this.againFlags = {
      attemptId,
      ...(expiring ? { expiring: true } : {}),
      ...(seenOnChain ? { seenOnChain: true } : {}),
      ...(refusal?.signedNotSent === true ? { signedNotSent: true } : {}),
    };
  }

  /**
   * The again request `record` offers now, if any: its wallet failed this very
   * attempt, which may still land and has no signature, nothing says the request
   * is about to expire or that a transaction reached the network, this page may
   * pay, and that wallet is still here.
   */
  private againFor(
    record: OrderRecord,
  ): { handle: SolanaSignAgain; walletName: string } | undefined {
    const offer = this.againOffer;
    const marker = record.marker;
    const flags = this.flagsFor(record);
    const network = this.networkOfRecord(record);
    if (
      offer === undefined ||
      offer.handle.orderId !== record.orderId ||
      record.state !== 'paying' ||
      marker?.rail !== 'solana' ||
      marker.attemptId !== offer.handle.attemptId ||
      marker.signature !== undefined ||
      this.attemptOver ||
      this.followOnly !== undefined ||
      this.refusedHere !== undefined ||
      storeClosed(record) ||
      isTerminal(record) ||
      flags?.expiring === true ||
      flags?.seenOnChain === true ||
      network === undefined ||
      !this.deps.wallets(network).some((option) => option.name === offer.walletName)
    ) {
      return undefined;
    }
    return offer;
  }

  /** The flags of the Solana attempt `record` shows, while it may still land. */
  private flagsFor(record: OrderRecord) {
    const flags = this.againFlags;
    const marker = record.marker;
    return flags !== undefined &&
      marker?.rail === 'solana' &&
      flags.attemptId === marker.attemptId &&
      !this.attemptOver
      ? flags
      : undefined;
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
      this.stopRechecks();
      this.attemptProblem = undefined;
      this.attemptOver = false;
      this.retryEstimate = undefined;
      // Silent is about one order: another one on screen is not.
      this.silent = undefined;
      this.silentAnswered = undefined;
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
      this.show({
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
        this.show({
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
      // A delivery an older node still sends is never shown: nothing is delivered through the checkout.
      this.show({
        kind: 'delivered',
        store,
        product,
        receipt: this.receiptOf(record, network),
      });
      return;
    }
    if (record.state === 'refunded') {
      this.show({
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
      this.show({
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
      this.show({ kind: 'blocked', store, product });
      return;
    }
    // The store cancelled and the attempt is over: only a new order is left.
    if (this.attemptOver && status?.status === 'cancelled') {
      this.show({ kind: 'cancelled', store, product });
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
      // A bundle the wallet reported failed shows like a request not answered: its countdown.
      signed =
        marker.txHash !== undefined ||
        (marker.bundleId !== undefined && marker.bundleFailed !== true) ||
        this.pendingBundle?.orderId === record.orderId ||
        pending !== undefined;
    }
    // A refusal by the store stays explained on every redraw while the order lives.
    const refused: Problem | undefined =
      this.refusedHere === undefined ? undefined : { reason: this.refusedHere.reason };
    // The attempt's problem is about that attempt only: never another tab's that replaced it.
    const attemptProblem =
      this.attemptProblem !== undefined && this.attemptProblem.attemptId === marker?.attemptId
        ? this.attemptProblem.problem
        : undefined;
    const problem = extra.problem ?? attemptProblem ?? refused;
    const retryIn = this.retryCountdown(record);
    const flags = this.flagsFor(record);
    const again = this.againFor(record);
    const requestEndsIn = tempo && !signed ? this.requestCountdown(record) : undefined;
    this.show({
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
      ...(again === undefined ? {} : { again: { wallet: again.walletName } }),
      ...(flags?.expiring === true ? { expiring: true } : {}),
      ...(flags?.seenOnChain === true ? { seenOnChain: true } : {}),
      ...(flags?.signedNotSent === true ? { signedNotSent: true } : {}),
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
    // Anchored at the deadline once it passed: its zero moment stays put, so the
    // probe never redraws it and "taking long" comes `UNSURE_AFTER_SECS` after it.
    const deadline = tempoLateDeadline(request);
    const at = Math.min(this.deps.now(), deadline);
    return { seconds: deadline - at, at };
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
        const settle = settleSeconds(lastValid, BigInt(epoch.blockHeight));
        const blocksLeft = settle.blocksLeft;
        const at = this.deps.now();
        let seconds = settle.seconds;
        // Skipped slots make blocks slower than the estimate: never count back up,
        // or the line would flip between "checking" and "waiting".
        const earlier = this.retryEstimate;
        if (earlier?.attemptId === attemptId) {
          const earlierZeroAt = earlier.at + earlier.seconds;
          if (earlierZeroAt <= at) {
            // Already at 0: it stays at 0 from the same moment, or every read would
            // push "taking long" back while blocks are still left.
            this.retryEstimate = {
              attemptId,
              seconds: 0,
              at: earlierZeroAt,
              latched: blocksLeft === 0,
            };
            return;
          }
          seconds = Math.min(seconds, earlierZeroAt - at);
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
      this.refuse(this.refusedHere.reason, this.refusedHere.message);
      return;
    }
    if (this.followOnly !== undefined) {
      this.show({
        kind: 'refused',
        reason: this.followOnly.reason,
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
    this.show({
      kind: 'offer',
      offer: this.offer,
      payout: this.payout,
      payouts,
      payoutIndex,
      wallets: this.walletChoices(this.payout),
      askEmail: this.deps.collectEmail === true,
      email: this.email,
      ...(shown === undefined ? {} : { problem: shown }),
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
        await this.applyVerdict(watched, generation);
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

  /**
   * Apply one watch pass's verdict for the record on screen (the regular watch,
   * or the unanswered-wallet probe once its press ended): the newer stored copy
   * adopted, an attempt another tab replaced kept watching, then the verdict's
   * screen. Dropped when stale (another record or attempt, an action running,
   * the session ended) or once the record on screen is finished.
   */
  private async applyVerdict(watched: Watched, generation: number): Promise<VerdictApplied> {
    if (
      this.busy ||
      generation !== this.generation ||
      this.disposed ||
      (this.record !== undefined && isTerminal(this.record))
    ) {
      return 'skipped';
    }
    // The listener may have stored a newer version (a status) during the pass.
    const stored = await this.deps.store.get(watched.record.orderId);
    if (this.busy || generation !== this.generation || this.disposed) {
      return 'skipped';
    }
    this.record =
      stored !== undefined && stored.version > watched.record.version ? stored : watched.record;
    // Another tab replaced the attempt during the pass: its verdict is not this one's.
    if (this.record.marker?.attemptId !== watched.record.marker?.attemptId) {
      this.attemptOver = false;
      this.render();
      void this.showPendingAnswer();
      return 'replaced';
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
      return 'drawn';
    }
    if (watched.state === 'paid') {
      this.stopWatching();
      this.status('paid');
      this.render();
      return 'follow';
    }
    if (watched.state === 'closed') {
      this.stopWatching();
      this.render();
      return 'drawn';
    }
    if (watched.state === 'over' && recordRail(watched.record) === 'tempo') {
      // A Tempo attempt proven over ends at once (no retry): its prompt stays open,
      // so the next payment of the product asks for confirmation first.
      this.stopWatching();
      const client = this.tempoOfRecord(watched.record);
      const ended =
        client === undefined
          ? undefined
          : await endTempoOrder(
              watched.record,
              this.tempoDeps(client),
              this.bundleHold(watched.record.orderId),
            );
      if (ended?.ended === true && generation === this.generation && !this.busy) {
        this.setRecord(undefined);
        this.listenToEnded([ended.record]);
        this.status('ended');
        this.showOffer({ reason: 'attempt_over' });
        void this.showPendingAnswer();
        return 'drawn';
      }
      if (ended?.ended === true) {
        // Ended, but no longer on screen (a close, a press): its answer is still stored.
        this.quiet.add(ended.record.orderId);
        this.listenToEnded([ended.record]);
        return 'skipped';
      }
      if (generation === this.generation && !this.disposed) {
        // Not ended (a lost write, a read that answered otherwise): keep watching.
        this.render();
        this.watch();
      }
      return 'skipped';
    }
    if (watched.state === 'over') {
      this.stopWatching();
      this.attemptProblem = undefined;
      this.attemptOver = true;
      this.noteOver(watched.record);
      this.render();
      // The attempt provably ended: a completion already heard now shows.
      void this.showPendingAnswer();
      return 'drawn';
    }
    if (watched.state === 'blocked') {
      this.stopWatching();
      this.render();
      return 'follow';
    }
    // Waiting: whatever was over, a new attempt (another tab's) is live now.
    this.attemptOver = false;
    this.render();
    return 'drawn';
  }

  /** One watch pass on the record's own rail. */
  private async watchOnce(
    current: OrderRecord,
    pendingHash?: string,
  ): Promise<Watched | undefined> {
    if (recordRail(current) === 'tempo') {
      const client = this.tempoOfRecord(current);
      if (client === undefined) {
        return undefined;
      }
      let record = current;
      let callPending = false;
      // A bundle this session knows of is asked about through its wallet first.
      const bundle = this.bundleToFollow(record);
      if (bundle !== undefined) {
        const step = await followTempoBundle(
          record,
          this.tempoDeps(client),
          bundle.wallet,
          bundle.bundleId,
        );
        record = step.record;
        this.applyBundleStep(record.orderId, bundle.bundleId, step);
        callPending = step.step === 'pending';
      }
      const pending =
        pendingHash ??
        (this.pendingHash?.orderId === record.orderId ? this.pendingHash.hash : undefined);
      const watched = await watchTempoPayment(record, this.tempoDeps(client), {
        ...(pending === undefined ? {} : { pendingHash: pending }),
        ...(callPending ? { callPending } : {}),
        ...this.bundleHold(record.orderId),
      });
      const stored =
        watched.record.marker?.rail === 'tempo' ? watched.record.marker.txHash : undefined;
      if (
        pending !== undefined &&
        stored === pending &&
        this.pendingHash?.orderId === current.orderId &&
        this.pendingHash.hash === pending
      ) {
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
   * The product's orders that ended unpaid still hear the store (a completion
   * that arrives for any record of the product is shown). When one is
   * completed or refunded and nothing live is on screen, it is shown.
   */
  private listenToEnded(records: readonly OrderRecord[], relays: readonly string[] = []): void {
    for (const record of records) {
      if (gone(record)) {
        this.noteOver(record);
      }
    }
    // This account's orders first: another's only resolve silently, so they yield.
    const ended = records
      .filter((record) => gone(record) && !this.background.has(record.orderId))
      .sort(
        (left, right) =>
          Number(this.own(right)) - Number(this.own(left)) || right.createdAt - left.createdAt,
      );
    const now = this.deps.now();
    for (const record of ended) {
      if (this.disposed) {
        return;
      }
      // A Tempo order whose prompt may still be approved always listens (the cap is for the rest).
      const openPrompt = recordRail(record) === 'tempo' && mayStillBePaid(record, now);
      if (!openPrompt && this.background.size >= MAX_ENDED_LISTENERS) {
        const evicted = this.listenerToDrop(record);
        if (evicted === undefined) {
          continue;
        }
        this.background.get(evicted)?.close();
        this.background.delete(evicted);
        this.backgroundCreated.delete(evicted);
        this.backgroundOther.delete(evicted);
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
            this.backgroundOther.delete(record.orderId);
            // Another account's answer is stored, never shown here; neither is one of an
            // order followed in the background since a close or a load.
            if (!this.own(updated) || this.quiet.has(updated.orderId)) {
              return;
            }
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
      if (!this.own(record)) {
        this.backgroundOther.add(record.orderId);
      }
    }
  }

  /**
   * The listener a full set drops for `record`, if any: another account's
   * first (the oldest), whatever its age, when `record` is this account's;
   * otherwise the oldest of the same kind, only when it is older than `record`.
   */
  private listenerToDrop(record: OrderRecord): string | undefined {
    const byAge = [...this.backgroundCreated.entries()].sort((left, right) => left[1] - right[1]);
    const others = byAge.filter(([orderId]) => this.backgroundOther.has(orderId));
    const own = this.own(record);
    if (own && others[0] !== undefined) {
      return others[0][0];
    }
    const sameKind = own ? byAge : others;
    const oldest = sameKind[0];
    return oldest === undefined || oldest[1] >= record.createdAt ? undefined : oldest[0];
  }

  /**
   * Show an ended order's completion or refund once nothing live is on screen:
   * never during an action, and never over an order that is (per the store)
   * paying or paid - in this tab or another.
   */
  private async showPendingAnswer(
    onlyDeliveries = false,
    press?: number,
  ): Promise<'shown' | 'held' | 'failed' | 'none'> {
    const resets = this.resets;
    // A completion first, else the newest refund.
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
    // A press's own delivery check (`deliveryFirst`) is never held by the line.
    if (
      this.busy ||
      this.disposed ||
      this.refused ||
      (press === undefined && this.earlierPaymentShown())
    ) {
      return 'held';
    }
    try {
      const current = this.record;
      const live = current === undefined ? undefined : await this.deps.store.get(current.orderId);
      if (press !== undefined && this.stale(press)) {
        return 'held';
      }
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
        // Another call showed it meanwhile (or a close dropped it).
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
        if (ended?.ended === true) {
          // Its store answer is still heard, whatever happened meanwhile: stored only
          // once the modal closed.
          if (this.resets !== resets) {
            this.quiet.add(ended.record.orderId);
          }
          this.listenToEnded([ended.record], this.relays);
        }
        if (!this.pendingAnswers.has(pending.orderId)) {
          return 'shown';
        }
        if (
          ended === undefined ||
          !ended.ended ||
          this.busy ||
          (press !== undefined && this.stale(press))
        ) {
          return 'held';
        }
      }
      if (this.resets !== resets) {
        return 'held';
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
   * Before any wallet opens: a completion already heard for an earlier order is
   * shown instead. `false` means go on.
   */
  private async deliveryFirst(press: number): Promise<boolean> {
    const outcome = await this.showPendingAnswer(true, press);
    if (this.stale(press)) {
      return true;
    }
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
        if (this.silent === orderId && !continuedUnpaid(updated)) {
          // An order the buyer never engaged with, no longer open (finished, cancelled,
          // paid or ended by another tab): stored only, nothing drawn or told. A press
          // running holds its own copy: it drops the order where it re-reads or ends.
          this.listening?.closer.close();
          this.listening = undefined;
          const relays = this.relays.length === 0 ? updated.inboxRelays : [...this.relays];
          if (this.busy || this.pressing) {
            this.silentAnswered = orderId;
          } else {
            this.setRecord(undefined);
          }
          // Its later answers are still stored, quietly: never shown here.
          if (followable(updated)) {
            this.followOwn(updated, relays);
          }
          if (gone(updated)) {
            this.quiet.add(orderId);
            this.listenToEnded([updated], relays);
          }
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
