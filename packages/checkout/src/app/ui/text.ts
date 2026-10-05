import { type Asset, NATIVE_SOL, type Network, formatAssetAmount } from '@elisym/pay-core';
import type { RefusalReason } from '../controller';
import { REF_NEEDS_VERIFIED_STORE } from '../ref-scope';
import type { Paying, Problem, Rail, Receipt, View } from '../session';

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
export const SOLD_OUT_PAID_LINE = 'An order already paid is still delivered.';

export const WORKING: Record<Extract<View, { kind: 'working' }>['step'], string> = {
  checking: 'Checking…',
  ordering: 'Sending the order to the store…',
  signing: 'Confirm the payment in your wallet…',
};

export const CHAIN_NAMES: Record<Rail, string> = { solana: 'Solana', tempo: 'Tempo' };

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

/** "Solana devnet", "Tempo mainnet": the network a payment runs on, always shown. */
export function networkLabel(chain: Rail, network: Network): string {
  return `${CHAIN_NAMES[chain]} ${network}`;
}

/** A pay-with choice: "USDC · Solana devnet". */
export function payoutLabel(paying: Paying): string {
  return `${paying.asset.symbol} · ${networkLabel(paying.chain, paying.network)}`;
}

/** "Paying 49 USDC · Solana devnet": the exact payment, where it happens. */
export function payingLine(paying: Paying): string {
  return `Paying ${formatAssetAmount(paying.asset, BigInt(paying.amount))} · ${networkLabel(paying.chain, paying.network)}`;
}

/** `asset`: the coin the order is paid in, for amounts of it. */
export function problemText(problem: Problem, asset: Asset): string {
  switch (problem.reason) {
    case 'no_wallet':
      return 'Connect a wallet for this network (Phantom or Solflare on Solana, MetaMask on Tempo).';
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
      return 'Your wallet approved an earlier request after that order had ended: it pays that order. The checkout keeps watching for it; contact the store if nothing arrives.';
    case 'attempt_over':
      return 'The payment was not made. If your wallet still shows the old request, reject it: approving it now would pay that order too.';
    case 'self_payment':
      return 'This wallet is the store’s own payout address; pay from another wallet.';
    case 'too_late':
      return 'This order is too old to pay. Start a new one.';
    case 'order_not_acknowledged':
      return 'The store’s relays did not take the order yet. Try again.';
    case 'no_store_inbox':
      return 'The store names no inbox to send orders to. Contact the store.';
    case 'failed':
      return 'Something went wrong. Try again.';
    case 'wallet_failed':
      return 'The wallet did not sign. If it signed after all, the payment will be found.';
    case 'wallet_unsupported':
      return 'This wallet changed the transaction, which the checkout never sends. Use another wallet once a retry is possible.';
    case 'offer_changed':
      return 'The store changed this offer. Review it before paying.';
    case 'offer_refused':
      return 'The store no longer offers this product here. Your order is still being followed.';
    case 'sold_out':
      return 'This product is sold out now. Your order is still being followed.';
    case 'other_purchase':
      return 'Another purchase of this product is in progress in this browser. Try again in a few minutes.';
    case 'bad_email':
      return 'That email does not look right. Fix it, or leave the field empty.';
    case 'insufficient_token':
      return `Not enough funds: the price is ${formatAssetAmount(asset, problem.needed)}, the wallet holds ${formatAssetAmount(asset, problem.available)}.`;
    case 'insufficient_sol':
      return `Not enough SOL for the network fees: ${formatAssetAmount(NATIVE_SOL, problem.needed)} needed, ${formatAssetAmount(NATIVE_SOL, problem.available)} held.`;
  }
}

/** "1:05": a countdown, minutes and seconds. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * After `hintAfterMs` of an action with no answer: what the buyer can do.
 * `cancellable`: the wallet has not answered its connect request yet.
 */
export function slowHint(step: 'checking' | 'signing', chain: Rail, cancellable = false): string {
  if (step === 'checking') {
    return cancellable
      ? 'Your wallet has not answered. Answer it, or cancel and choose again.'
      : 'This is taking long. Reload the page to try again; no new payment request has been sent to your wallet.';
  }
  return chain === 'tempo'
    ? 'Your wallet has not answered. If you closed its window, reload the page: the checkout keeps checking the request, and once it has lapsed a new order can start after a question about the old request.'
    : 'Your wallet has not answered. If you closed its window, reload the page: the order picks up where it is, and a retry opens once it is safe.';
}

/** A start still running after `SLOW_START_MS`: never a refusal. */
export function slowLoading(modal: boolean): string {
  return `This is taking longer than usual: the checkout is still checking your earlier order with the network. ${
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

/** A transaction id shortened for the screen: its first 6 and last 4 characters. */
export function shortTx(tx: string): string {
  return tx.length <= 12 ? tx : `${tx.slice(0, 6)}…${tx.slice(-4)}`;
}

/** "1.5 USDC · Solana mainnet": what an order is for. */
export function paidLine(paying: Paying): string {
  return `${formatAssetAmount(paying.asset, BigInt(paying.amount))} · ${networkLabel(paying.chain, paying.network)}`;
}

/**
 * The receipt as plain text, one row per line: what "Copy receipt" copies,
 * with the full transaction id (the screen shows it shortened). "Paid" only when this checkout's
 * verifier found the payment; otherwise the order total, and the transaction
 * this checkout sent once the chain says it went through - last, after the order.
 */
export function receiptText(receipt: Receipt, kind: 'delivered' | 'refunded'): string {
  const lines = [
    `Store: ${receiptField(receipt.store)}`,
    `Product: ${receiptField(receipt.product)}`,
  ];
  const amount = receipt.paying === undefined ? undefined : paidLine(receipt.paying);
  const paid = receipt.paid;
  if (amount !== undefined) {
    lines.push(paid === undefined ? `Total: ${amount}` : `Paid: ${amount}`);
  }
  if (paid?.at !== undefined) {
    lines.push(`Payment confirmed on: ${new Date(paid.at * 1000).toLocaleString()}`);
  } else if (receipt.answeredAt !== undefined) {
    const label = kind === 'refunded' ? 'Refunded on' : 'Delivered on';
    lines.push(`${label}: ${new Date(receipt.answeredAt * 1000).toLocaleString()}`);
  }
  if (kind === 'refunded') {
    lines.push('Refunded by the store');
  }
  lines.push(`Order: ${receiptField(receipt.orderId)}`);
  if (paid !== undefined) {
    lines.push(`Transaction: ${receiptField(paid.tx)}`);
  } else if (receipt.sent !== undefined) {
    lines.push(`Transaction sent: ${receiptField(receipt.sent.tx)}`);
  }
  return lines.join('\n');
}
