import { type Asset, NATIVE_SOL, type Network, formatAssetAmount } from '@elisym/pay-core';
import type { RefusalReason } from '../controller';
import type { Paying, Problem, Rail, View } from '../session';

export const REFUSALS: Record<RefusalReason, string> = {
  not_framed: 'This checkout only works embedded in a store page.',
  no_hello: 'The store page did not start the checkout.',
  no_product: 'This checkout names no product.',
  no_storage:
    'This browser blocks storage for the checkout (private mode?). Payments need it to stay safe.',
  offer_refused: 'This product cannot be bought here.',
  failed: 'The checkout could not start. Reload the page to try again.',
};

export const WORKING: Record<Extract<View, { kind: 'working' }>['step'], string> = {
  checking: 'Checking…',
  ordering: 'Sending the order to the store…',
  signing: 'Confirm the payment in your wallet…',
};

export const CHAIN_NAMES: Record<Rail, string> = { solana: 'Solana', tempo: 'Tempo' };

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

/** After `hintAfterMs` of an action with no answer: what the buyer can do. */
export function slowHint(step: 'checking' | 'signing', chain: Rail): string {
  if (step === 'checking') {
    return 'This is taking long. If a wallet window is open, answer it; otherwise reload the page.';
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
