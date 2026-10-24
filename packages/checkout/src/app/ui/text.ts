import {
  type Asset,
  type ChainSlug,
  NATIVE_SOL,
  type Network,
  formatAssetAmount,
} from '@elisym/pay-core';
import type { RefusalReason } from '../controller';
import type { PurchaseStatus } from '../history';
import { REF_NEEDS_VERIFIED_STORE } from '../ref-scope';
import type {
  Eip3009Send,
  EarlierPayment,
  OpenStatus,
  Paying,
  Problem,
  Rail,
  Receipt,
  RetryBlockedCause,
  View,
} from '../session';

export const REFUSALS: Record<RefusalReason, string> = {
  not_framed: 'This checkout only works embedded in a store page.',
  no_hello: 'The store page did not start the checkout.',
  no_product: 'This checkout names no product.',
  no_storage:
    'This browser blocks storage for the checkout (private mode?). Payments need it to stay safe.',
  offer_refused: 'This product cannot be bought here.',
  sold_out: 'Sold out. This product is not available right now.',
  failed: 'The checkout could not start. Reload the page to try again.',
  bad_customer_ref: 'The page passed an invalid customer reference.',
  ref_needs_verified_store: REF_NEEDS_VERIFIED_STORE,
};

/** Under a sold-out screen: the same for every buyer, so it tells no one's state. */
export const SOLD_OUT_PAID_LINE = 'An order already paid is still completed.';

export const WORKING: Record<Extract<View, { kind: 'working' }>['step'], string> = {
  checking: 'Checking…',
  ordering: 'Sending the order to the store…',
  signing: 'Confirm the payment in your wallet…',
};

/** EIP-3009 asks the wallet twice: the signature, then the transaction that carries it. */
export const EIP3009_SIGNING = 'Sign the payment in your wallet, then confirm sending it…';

/** "Send again" / "Send anyway": the signature exists, the wallet only sends it. */
export const EIP3009_SENDING = 'Confirm sending the payment in your wallet…';

/**
 * E7: this rail pays only at a protocol fee of 0, so with a fee on these chains
 * are not offered: the line under the payouts, and the refusal when none is left.
 */
export const FEE_HIDES_EIP3009 =
  'Ethereum, Arbitrum and Base are not offered while the elisym protocol fee is above 0.';

/** "Sign, then confirm": said before the first of the two prompts. */
export const EIP3009_TWO_PROMPTS =
  'Your wallet asks twice: first sign the payment, then confirm sending it.';

/** The gas line under an `eip3009` payout: "You need a little ETH on Base for the network fee." */
export function gasLine(coin: string, chain: string): string {
  return `You need a little ${coin} on ${chain} for the network fee.`;
}

export const CHAIN_NAMES: Record<ChainSlug, string> = {
  solana: 'Solana',
  tempo: 'Tempo',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  base: 'Base',
};

/** At most this many characters of a store-given name stay in the DOM (the full one in `title`). */
export const MAX_SHOWN_CHARS = 200;

/** The user-perceived characters of a text: a cut never splits an emoji or an accent. */
function graphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

/** A name as rendered: up to `MAX_SHOWN_CHARS` characters, then an ellipsis. */
export function shownText(value: string): string {
  if (value.length <= MAX_SHOWN_CHARS) {
    return value;
  }
  const parts = graphemes(value);
  return parts.length <= MAX_SHOWN_CHARS ? value : `${parts.slice(0, MAX_SHOWN_CHARS).join('')}…`;
}

/**
 * "Solana", "Solana devnet": the network a payment runs on, always shown. Real
 * money is just the chain; a test network says so, so test money is never
 * mistaken for real.
 */
export function networkLabel(chain: ChainSlug, network: Network): string {
  return network === 'mainnet' ? CHAIN_NAMES[chain] : `${CHAIN_NAMES[chain]} ${network}`;
}

/** A pay-with choice: "USDC · Solana devnet". */
export function payoutLabel(paying: Paying): string {
  return `${paying.asset.symbol} · ${networkLabel(paying.chain, paying.network)}`;
}

/** "Paying 49 USDC · Solana devnet": the exact payment, where it happens. */
export function payingLine(paying: Paying): string {
  return `Paying ${formatAssetAmount(paying.asset, BigInt(paying.amount))} · ${networkLabel(paying.chain, paying.network)}`;
}

/** A decline of an again request: the attempt it asked for stays live, so never "nothing was paid". */
export const AGAIN_DECLINED = 'You declined. Nothing new was sent.';

/** The store's payment node cannot take a fee-split payment: the store must update it. */
export const STORE_OUTDATED_TEXT =
  'This store’s payment node must be updated before it can take payments. Nothing was paid.';

/** "Includes elisym fee 0.49 USDC": the part of the price the store's payout passes on. */
export function feeLine(asset: Asset, feeAmount: bigint): string {
  return `Includes elisym fee ${formatAssetAmount(asset, feeAmount)}`;
}

/** Under the earlier-payment line when its wallet would not answer: connect and ask it. */
export const CHECK_IN_WALLET = 'Check in wallet';

/**
 * `asset`: the coin the order is paid in, for amounts of it. `canPress`: the screen
 * offers something to press now; without it, nothing says "try again".
 */
/** `rail`: the payout's rail, so a wallet hint names only the network the store takes. */
export function problemText(problem: Problem, asset: Asset, rail: Rail, canPress = true): string {
  switch (problem.reason) {
    case 'no_wallet':
      return NO_WALLET_HINTS[rail];
    case 'tempo_unsupported':
      return 'This wallet cannot pay on Tempo. Choose another wallet.';
    case 'wallet_busy':
      return 'Your wallet already has a request open. Answer or close it, then choose again.';
    case 'clock_skew':
      return 'This device’s clock is more than 5 minutes off. Fix the clock and try again.';
    case 'rpc_error':
      return 'The network could not be reached. Try again in a moment.';
    case 'policy_blocked':
      return 'The store’s account does not accept this coin from your wallet. Nothing was paid; contact the store.';
    case 'wrong_chain':
      return 'Your wallet is on another network. Switch it to the network shown and try again.';
    case 'rejected':
      return 'You declined in the wallet. Nothing was paid.';
    case 'late_approval':
      return 'Your wallet approved an old request, so it paid that earlier order. The checkout keeps watching it; contact the store if it is not completed.';
    case 'attempt_over':
      return 'The payment was not made. If your wallet still shows the request, reject it there.';
    case 'self_payment':
      return 'This wallet is the store’s own payout address; pay from another wallet.';
    case 'too_late':
      return 'This order is too old to pay. Start a new one.';
    case 'order_not_acknowledged':
      return 'The store’s relays did not take the order yet. Try again.';
    case 'no_store_inbox':
      return 'The store names no inbox to send orders to. Contact the store.';
    case 'failed':
      return canPress
        ? 'Something went wrong. Try again.'
        : 'Something went wrong in the checkout.';
    case 'wallet_failed':
      return problem.declined === true
        ? AGAIN_DECLINED
        : 'The wallet did not sign. If it signed after all, the payment will be found.';
    case 'again_declined':
      return AGAIN_DECLINED;
    case 'other_payer':
      return `Connect the account ${shortTx(problem.payer)} you started with.`;
    case 'wallet_unsupported':
      return 'This wallet changed the transaction, which the checkout never sends. Use another wallet once a retry is possible.';
    case 'offer_changed':
      return 'The store changed this offer. Review it before paying.';
    case 'store_outdated':
      return STORE_OUTDATED_TEXT;
    case 'wallet_cannot_batch':
      return 'This wallet cannot send this payment in one step. Nothing was paid; choose another wallet.';
    case 'fee_config_unavailable':
      return 'The elisym fee terms could not be read. Nothing was paid; try again in a moment.';
    case 'fee_config_invalid':
      return 'The elisym fee configuration cannot be used right now. Nothing was paid.';
    case 'wallet_payment_failed':
      return 'Your wallet reports that the payment failed. Nothing was paid.';
    case 'offer_refused':
      return 'The store no longer offers this product here. Your earlier order is still being checked.';
    case 'sold_out':
      return 'This product is sold out now. Your earlier order is still being checked.';
    case 'other_purchase':
      return 'Another payment for this product is still in progress in this browser. Try again in a few minutes.';
    case 'bad_email':
      return 'That email does not look right. Fix it, or leave the field empty.';
    case 'insufficient_token':
      return `Not enough funds: the price is ${formatAssetAmount(asset, problem.needed)}, the wallet holds ${formatAssetAmount(asset, problem.available)}.`;
    case 'insufficient_sol':
      return `Not enough SOL for the network fees: ${formatAssetAmount(NATIVE_SOL, problem.needed)} needed, ${formatAssetAmount(NATIVE_SOL, problem.available)} held.`;
    case 'earlier_payment': {
      const line = earlierPaymentLine(problem, undefined);
      return `${line.lead}${line.tail}`;
    }
    case 'chain_unreachable':
      return `This wallet cannot pay on ${problem.chain}. Nothing was paid; choose another wallet.`;
    case 'sign_failed':
      return 'The wallet’s signature could not be used. Nothing was paid; try again.';
    case 'no_native':
      return `This wallet holds no ${problem.coin} on ${problem.chain} for the network fee. Add a little, then try again.`;
    case 'insufficient_native':
      return `There may not be enough ${problem.native.symbol} on ${problem.chain} for the network fee: about ${formatAssetAmount(problem.native, problem.needed)} needed, ${formatAssetAmount(problem.native, problem.available)} held. Top up and pay again with the same wallet, or send anyway.`;
    case 'token_blocked':
      return 'The coin’s issuer blocks this payment right now. Nothing was paid; contact the store.';
    case 'payer_unsupported':
      return 'This account cannot sign this payment (its smart-account code is not one known to work). Nothing was paid; use another account.';
    case 'wrong_chain_after_sign':
      return `Your wallet moved to another network after signing. Nothing was sent: send again, and the checkout asks it to switch back to ${problem.chain}.`;
    case 'resign_needed':
      return 'The signature is too close to its deadline to send. Nothing was sent: pay again with the same wallet to sign a new one.';
    case 'send_declined':
      return 'You declined sending. Nothing was sent: send again, or pay again with the same wallet.';
    case 'send_failed':
      return 'The network refused the payment in a test run, so nothing was sent. Pay again with the same wallet.';
    case 'near_expiry':
      return 'The payment was sent close to its deadline and may fail. If it does, pay again with the same wallet.';
    case 'send_uncertain':
      return 'The wallet reported an error while sending; the payment may have been sent and will be found if it lands. You can pay again with the same wallet.';
    case 'retry_blocked':
      // Too late is final for every wallet: no "another wallet can pay" there.
      return problem.cause === 'too_late'
        ? RETRY_BLOCKED.too_late(problem.chain)
        : `${RETRY_BLOCKED[problem.cause](problem.chain)} ${EARLIER_MAY_ARRIVE}`;
  }
}

/** A retry of a live signed attempt was refused: what was paid before still stands. */
export const EARLIER_MAY_ARRIVE =
  'Your earlier payment may still arrive; another wallet can pay only once it provably expired unused.';

/** Why a retry of a live signed attempt signed nothing new (`retry_blocked`), before `EARLIER_MAY_ARRIVE`. */
const RETRY_BLOCKED: Record<RetryBlockedCause, (chain: string) => string> = {
  chain_unreachable: (chain) => `This wallet cannot pay on ${chain}, so nothing new was signed.`,
  payer_unsupported: () =>
    'This account cannot sign this payment (its smart-account code is not one known to work), so nothing new was signed.',
  token_blocked: () =>
    'The coin’s issuer blocks this payment right now, so nothing new was signed.',
  too_late: () =>
    'This order is too old to pay again, so nothing new was signed. Your earlier payment may still arrive; if it does not, contact the store.',
  offer_changed: () => 'The store changed this offer, so nothing new was signed.',
  fee_config_unavailable: () =>
    'The elisym fee terms could not be read, so nothing new was signed. Try again in a moment.',
  fee_config_invalid: () =>
    'The elisym fee configuration cannot be used right now, so nothing new was signed.',
};

/** Which wallet to connect, by the payout's rail. */
const NO_WALLET_HINTS: Record<Rail, string> = {
  solana: 'Connect a Solana wallet, such as Phantom or Solflare.',
  tempo: 'Connect a wallet that can pay on Tempo, such as MetaMask.',
  eip3009: 'Connect an Ethereum wallet, such as MetaMask or Rabby.',
};

/** The press-time line about the buyer's own earlier payment: never "contact the store". */
export const EARLIER_PAYMENT = {
  confirming: 'A payment from earlier is still being confirmed.',
  tempoRequest: 'Your wallet already has a request open.',
  tempoRequestDo: 'Answer or reject it there, or try again',
  waitingStore:
    'Your earlier payment arrived and is waiting for the store. It shows under Your purchases.',
  cancelled:
    'Your earlier payment arrived, but the store cancelled the order. It shows under Your purchases.',
} as const;

/**
 * The earlier-payment line in parts: `countdown` (m:ss) sits between `lead` and
 * `tail` while time is left (`left > 0`); otherwise "in a moment" is in the text.
 */
export function earlierPaymentLine(
  problem: EarlierPayment,
  left: number | undefined,
): { lead: string; countdown?: string; tail: string } {
  const counting = left !== undefined && left > 0;
  switch (problem.phase) {
    case 'waiting_store':
      return {
        lead: problem.cancelled === true ? EARLIER_PAYMENT.cancelled : EARLIER_PAYMENT.waitingStore,
        tail: '',
      };
    case 'confirming':
      return counting
        ? {
            lead: `${EARLIER_PAYMENT.confirming} You can try again in `,
            countdown: formatCountdown(left),
            tail: '.',
          }
        : { lead: `${EARLIER_PAYMENT.confirming} Try again in a moment.`, tail: '' };
    case 'tempo_request':
      return counting
        ? {
            lead: `${EARLIER_PAYMENT.tempoRequest} ${EARLIER_PAYMENT.tempoRequestDo} in `,
            countdown: formatCountdown(left),
            tail: '.',
          }
        : {
            lead: `${EARLIER_PAYMENT.tempoRequest} ${EARLIER_PAYMENT.tempoRequestDo} in a moment.`,
            tail: '',
          };
  }
}

/** What the earlier-payment line's live region says: once per phase, never the ticking number. */
export function earlierPaymentStatus(problem: EarlierPayment): string {
  switch (problem.phase) {
    case 'waiting_store':
      return problem.cancelled === true ? EARLIER_PAYMENT.cancelled : EARLIER_PAYMENT.waitingStore;
    case 'confirming':
      return EARLIER_PAYMENT.confirming;
    case 'tempo_request':
      return EARLIER_PAYMENT.tempoRequest;
  }
}

/** "1:05": a countdown, minutes and seconds. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * After `hintAfterMs` of checking with no answer: what the buyer can do.
 * `cancellable`: the wallet has not answered its connect request yet.
 */
export function slowHint(cancellable = false): string {
  return cancellable
    ? 'Your wallet has not answered. Answer it, or cancel and choose again.'
    : 'This is taking long. Reload the page to try again; no new payment request has been sent to your wallet.';
}

/** The wallet has not answered a payment request: what the checkout does, and when Start over opens. */
export const UNANSWERED = {
  lead: 'Your wallet has not answered.',
  unknown: {
    solana: 'You can start over once the request expires.',
    tempo: 'You can start over once the checkout stops waiting for it.',
    eip3009: 'Another wallet can pay once the signature expires unused.',
  } satisfies Record<Rail, string>,
  /** Around the countdown: "You can start over in m:ss." */
  countingLead: {
    solana: 'You can start over in ',
    tempo: 'You can start over in ',
    eip3009: 'Another wallet can pay in ',
  } satisfies Record<Rail, string>,
  checking: {
    solana: 'Checking whether the request has expired…',
    tempo: 'Checking whether the request was approved…',
    eip3009: 'Checking whether the signature expired unused…',
  } satisfies Record<Rail, string>,
  takingLong: 'This is taking long. If it does not resolve, contact the store.',
  reject: 'If you do not want to pay, reject the request in your wallet.',
  /** Said once, politely, when the hint appears. */
  announce: {
    solana: 'Your wallet has not answered. Start over opens when the request expires.',
    tempo: 'Your wallet has not answered. Start over opens when the checkout stops waiting for it.',
    eip3009:
      'Your wallet has not answered. Another wallet can pay once the signature expires unused.',
  } satisfies Record<Rail, string>,
} as const;

/**
 * Every word the wait says about the current attempt's send, from its send
 * state alone (the session's `eip3009SendState`): the status lead and whether
 * "Confirming on …" follows it, the explorer link's name, the heading, and
 * whether the wallet's part is done (the stepper's stage).
 */
export function eip3009SendWords(send: Eip3009Send): {
  lead: string;
  confirming: boolean;
  link: string;
  heading: string;
  walletDone: boolean;
} {
  switch (send.kind) {
    case 'sent':
      return {
        lead: EIP3009_WAIT.sent,
        confirming: true,
        link: EIP3009_WAIT.viewTransaction,
        heading: 'Confirming payment',
        walletDone: true,
      };
    case 'not_sent':
      return {
        lead: send.earlier ? EIP3009_WAIT.signedEarlierSent : EIP3009_WAIT.signed,
        confirming: false,
        link: EIP3009_WAIT.viewEarlierTransaction,
        heading: 'Payment not sent yet',
        walletDone: false,
      };
    case 'unknown':
      if (send.linked || send.maybe) {
        return {
          lead: send.linked ? EIP3009_WAIT.sentUnknown : EIP3009_WAIT.maybeSent,
          confirming: true,
          link: EIP3009_WAIT.viewSentTransaction,
          heading: 'Confirming payment',
          walletDone: true,
        };
      }
      // No fact either way: no claim about sending.
      return {
        lead: EIP3009_WAIT.waiting,
        confirming: false,
        link: EIP3009_WAIT.viewSentTransaction,
        heading: 'Waiting for the payment',
        walletDone: false,
      };
  }
}

/** "about 5 minutes": a wait in whole minutes, rounded up. */
export function aboutMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Every line of an `eip3009` wait (Ethereum, Arbitrum, Base). */
export const EIP3009_WAIT = {
  /** The order's nonce was used before this checkout asked: no timer, no other wallet, no end. */
  nonceUsed: 'This order may already be paid; waiting for the store.',
  nonceUsedNote:
    'A payment for it was signed outside this checkout. If the store does not complete it, contact the store.',
  over: 'The signature expired unused. Nothing was paid. Pay with another wallet, or start over.',
  /** The same, on a page that only follows the order: no wallet is offered. */
  overFollowOnly: 'The signature expired unused. Nothing was paid. You can start over now.',
  sent: 'Your wallet sent the payment.',
  signed: 'Your wallet signed the payment; it was not sent yet.',
  /** The current attempt signed and not sent, while an earlier attempt's transaction exists. */
  signedEarlierSent:
    'Your wallet signed a new payment; it was not sent yet. A payment sent earlier may still arrive.',
  viewTransaction: 'View the transaction',
  viewEarlierTransaction: 'View the earlier transaction',
  /** A transaction is known for the order, not which attempt sent it (after a reload, say). */
  sentUnknown: 'A payment for this order was sent; it may still arrive.',
  /** The wallet failed while sending: no transaction is known, one may have gone out. */
  maybeSent: 'A payment for this order may have been sent; it will be found if it lands.',
  viewSentTransaction: 'View the sent transaction',
  waiting: 'Waiting for the payment…',
  /** "Confirming on Base Sepolia, about 5 minutes." */
  confirming: (chain: string, creditSecs: number) =>
    `Confirming on ${chain}, ${aboutMinutes(creditSecs)}.`,
  retryLabel: 'Pay again with the same wallet',
  switchLabel: 'Pay with another wallet',
  /** Around the countdown: "Another wallet can pay in about m:ss, once the signature expires unused." */
  switchLead: 'Another wallet can pay in about ',
  switchTail: ', once the signature expires unused.',
  /** On a page that only follows the order: "Start over opens in about m:ss." */
  startOverLead: 'Start over opens in about ',
  startOverTail: '.',
  switchChecking: 'Checking whether the signature expired unused…',
  takingLong: 'This is taking long. If it does not resolve, contact the store.',
  sendAnyway: 'Send anyway',
  sendAgain: 'Send again',
} as const;

/** A start still running after `SLOW_START_MS`: never a refusal. */
export function slowLoading(modal: boolean): string {
  return `This is taking longer than usual. ${
    modal
      ? 'You can close this and come back, or reload the page.'
      : 'Keep this page open, or reload it.'
  }`;
}

/**
 * Code point ranges that could forge a line or reorder text in a copied
 * receipt: C0 and C1 controls, line and paragraph separators, bidi controls.
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function unsafeCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/** No field of a copied receipt is longer than this. */
export const RECEIPT_FIELD_MAX = 200;

/** A field the store or the chain supplied, made safe for one line of plain text. */
export function receiptField(value: string): string {
  return Array.from(value, (character) => (unsafeCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RECEIPT_FIELD_MAX);
}

/** An unfinished purchase's `Status:` line in its receipt. */
export const OPEN_STATUS_LINES: Record<OpenStatus, string> = {
  waiting_store: 'waiting for the store',
  paying: 'payment in progress',
  blocked: 'payment blocked by the recipient',
  cancelled_paid: 'cancelled by the store (no refund stated)',
};

/** A transaction id shortened for the screen: its first 6 and last 4 characters. */
export function shortTx(tx: string): string {
  return tx.length <= 12 ? tx : `${tx.slice(0, 6)}…${tx.slice(-4)}`;
}

/** An order id shortened for the screen, as a transaction is: its first 6 and last 4 characters. */
export function shortId(id: string): string {
  return shortTx(id);
}

/** "1.5 USDC": an order's amount, without its network. */
export function amountText(paying: Paying): string {
  return formatAssetAmount(paying.asset, BigInt(paying.amount));
}

/** "1.5 USDC · Solana": what an order is for. */
export function paidLine(paying: Paying): string {
  return `${amountText(paying)} · ${networkLabel(paying.chain, paying.network)}`;
}

/** "Oct 5, 2026": the day a purchase was placed (`createdAt`, seconds). */
export function purchaseDay(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** A dated line of a receipt: its label, and when (seconds). */
export interface ReceiptMoment {
  label: string;
  at: number;
}

/** When a payment was confirmed, else when the store answered a finished order. */
function finishedMoment(
  receipt: Receipt,
  kind: 'delivered' | 'refunded' | 'open',
): ReceiptMoment | undefined {
  if (receipt.paid?.at !== undefined) {
    return { label: 'Payment confirmed on', at: receipt.paid.at };
  }
  if (receipt.answeredAt !== undefined && kind !== 'open') {
    return { label: kind === 'refunded' ? 'Refunded on' : 'Completed on', at: receipt.answeredAt };
  }
  return undefined;
}

/**
 * The receipt's own moment, as its copied text dates it: the payment's
 * confirmation, else the store's answer to a finished order, else when an
 * unfinished one was placed. Nothing when the receipt has no date.
 */
export function receiptMoment(
  receipt: Receipt,
  kind: 'delivered' | 'refunded' | 'open',
): ReceiptMoment | undefined {
  const finished = finishedMoment(receipt, kind);
  if (finished !== undefined) {
    return finished;
  }
  return kind === 'open' && receipt.orderedAt !== undefined
    ? { label: 'Ordered on', at: receipt.orderedAt }
    : undefined;
}

/**
 * The receipt as plain text, one row per line: what "Copy receipt" copies,
 * with the full transaction id (the screen shows it shortened). "Paid" only when this checkout's
 * verifier found the payment; otherwise the order total, and the transaction
 * this checkout sent once the chain says it went through - last, after the order.
 */
export function receiptText(receipt: Receipt, kind: 'delivered' | 'refunded' | 'open'): string {
  const lines = [
    `Store: ${receiptField(receipt.store)}`,
    `Product: ${receiptField(receipt.product)}`,
  ];
  const amount = receipt.paying === undefined ? undefined : paidLine(receipt.paying);
  const paid = receipt.paid;
  if (amount !== undefined) {
    lines.push(paid === undefined ? `Total: ${amount}` : `Paid: ${amount}`);
  }
  const finished = finishedMoment(receipt, kind);
  if (finished !== undefined) {
    lines.push(`${finished.label}: ${new Date(finished.at * 1000).toLocaleString()}`);
  }
  if (kind === 'refunded') {
    lines.push('Refunded by the store');
  }
  if (kind === 'open') {
    // Never a completion or refund date: this purchase is not finished.
    if (receipt.orderedAt !== undefined) {
      lines.push(`Ordered on: ${new Date(receipt.orderedAt * 1000).toLocaleString()}`);
    }
    if (receipt.openStatus !== undefined) {
      lines.push(`Status: ${OPEN_STATUS_LINES[receipt.openStatus]}`);
    }
  }
  lines.push(`Order: ${receiptField(receipt.orderId)}`);
  if (paid !== undefined) {
    lines.push(`Transaction: ${receiptField(paid.tx)}`);
  } else if (receipt.sent !== undefined) {
    lines.push(`Transaction sent: ${receiptField(receipt.sent.tx)}`);
  }
  return lines.join('\n');
}

/** The payment stepper's stages: the last fills once the payment is complete. */
export const STEPPER_STAGES = ['Order sent', 'Confirm in wallet', 'Payment complete'] as const;

/** "Your purchases": every string it shows. */
export const PURCHASES_TEXT = {
  title: 'Your purchases',
  backToCheckout: 'Back to checkout',
  backToList: 'Your purchases',
  backToListLabel: 'Back to your purchases',
  loading: 'Loading…',
  empty: 'No purchases from this store in this browser yet.',
  downloadCsv: 'Download CSV',
  details: 'Purchase details',
  product: 'Product',
  order: 'Order',
  orderHelp: 'Give this number to the store if you need help.',
  copyOrder: 'Copy order number',
  orderCopied: 'Order number copied.',
  transaction: 'Transaction',
  transactionSent: 'Transaction sent',
  copyReceipt: 'Copy receipt',
  receiptCopied: 'Receipt copied.',
  otherProduct: "Open this product's checkout to follow it.",
} as const;

/** A status badge's color: never the only signal, its text always says it. */
export type BadgeTone = 'success' | 'neutral' | 'pending' | 'problem';

/** A purchase's status as a short badge (the full label stays in its `title` and the export). */
export const PURCHASE_BADGES: Record<PurchaseStatus, { text: string; tone: BadgeTone }> = {
  delivered: { text: 'Completed', tone: 'success' },
  refunded: { text: 'Refunded', tone: 'neutral' },
  waiting_store: { text: 'Waiting for the store', tone: 'pending' },
  paying: { text: 'Payment in progress', tone: 'pending' },
  blocked: { text: 'Payment blocked', tone: 'problem' },
  cancelled_paid: { text: 'Cancelled', tone: 'problem' },
};

/** What a short badge leaves out, said under it in the detail. */
export const PURCHASE_STATUS_NOTES: Partial<Record<PurchaseStatus, string>> = {
  blocked: 'Payment blocked by the recipient.',
  cancelled_paid: 'Cancelled by the store (no refund stated).',
};
