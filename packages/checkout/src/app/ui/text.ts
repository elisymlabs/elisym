import type { OfferWarning } from '@elisym/commerce';
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

export const WARNINGS: Record<OfferWarning, string> = {
  domain_unverified: 'The store names a domain that does not confirm it.',
  origin_mismatch: 'This page is not on the store’s domain.',
  origin_unverifiable: 'No domain vouches for this store: check you trust this page.',
  payout_recently_changed: 'The store changed where it is paid very recently.',
  payout_changed: 'The store is paid to a different address than on your last purchase.',
  payout_unsigned: 'The payout address carries no wallet proof.',
  owner_unpinned: 'First purchase from this store on this site.',
};

/** The longer "why this matters", under the always-shown list. */
export const WARNING_DETAILS: Record<OfferWarning, string> = {
  domain_unverified:
    'The store profile claims a website, but that website does not list the store’s keys. Treat the store as unverified.',
  origin_mismatch:
    'The checkout is embedded on a page the store’s domain does not cover. Someone else may be reselling or imitating it.',
  origin_unverifiable:
    'Nothing ties this store to a website, so the checkout cannot tell whether this page belongs to it. Pay only if you trust the page.',
  payout_recently_changed:
    'A new payout address published minutes ago can mean the store’s keys changed hands. If you did not expect a change, ask the store first.',
  payout_changed:
    'Your earlier purchase from this store paid another address. Stores rarely change it; ask the store if you are unsure.',
  payout_unsigned:
    'The wallet that receives the payment did not sign for this store. The store’s owner key still vouches for it.',
  owner_unpinned:
    'This browser has no earlier purchase from this store to compare with, so changes of its keys cannot be noticed yet.',
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
      return 'The wallet did not sign. If it did after all, the payment is found; otherwise you can retry in about a minute and a half.';
    case 'wallet_unsupported':
      return 'This wallet changed the transaction, which the checkout never sends. You can retry in about a minute and a half, or use another wallet.';
    case 'offer_changed':
      return 'The store changed this offer. Review it before paying.';
    case 'offer_refused':
      return 'The store no longer offers this product here. Your order is still being followed.';
    case 'confirm_first':
      return 'Read the warnings and tick the box before paying.';
    case 'bad_email':
      return 'That email does not look right. Fix it, or leave the field empty.';
    case 'insufficient_token':
      return `Not enough funds: the price is ${formatAssetAmount(asset, problem.needed)}, the wallet holds ${formatAssetAmount(asset, problem.available)}.`;
    case 'insufficient_sol':
      return `Not enough SOL for the network fees: ${formatAssetAmount(NATIVE_SOL, problem.needed)} needed, ${formatAssetAmount(NATIVE_SOL, problem.available)} held.`;
  }
}
