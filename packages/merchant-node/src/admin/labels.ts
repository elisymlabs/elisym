/**
 * The admin's wording, shared by the local page and the hosted admin: state and
 * claim-check labels, shortened ids, amounts and dates. DOM-free.
 */
import type { ClaimCheck, NodeAmount, OrderState } from './history';
import { wholeUnits } from './history';

export const STATE_LABELS: Readonly<Record<OrderState, string>> = {
  ordered: 'ordered',
  expired:
    'expired (no payment credited within 3 days; the orders command lists any payment the node left unresolved)',
  payment_reported: 'payment reported (not confirmed by your node)',
  delivered: 'completed',
  released: 'released by hand',
  refunded: 'refunded',
};

export const CLAIM_LABELS: Readonly<Record<ClaimCheck, string>> = {
  matches: 'matches the listing',
  differs: 'differs from the listing',
  not_checked: 'listing changed around this order (not checked)',
};

/** Characters kept at each end of a shortened key or transaction. */
const SHORT_EDGE = 8;

/** A key or transaction shortened to its two ends. */
export function short(value: string): string {
  return value.length <= SHORT_EDGE * 2 + 1
    ? value
    : `${value.slice(0, SHORT_EDGE)}...${value.slice(-SHORT_EDGE)}`;
}

/** An amount the node named: whole units of its asset, else raw subunits. */
export function amountText(amount: NodeAmount, medium?: string): string {
  if (amount.asset !== undefined) {
    return `${wholeUnits(amount.amount, amount.asset)} ${amount.asset.asset.symbol}`;
  }
  return medium === undefined
    ? `${amount.amount} subunits, asset unknown`
    : `${amount.amount} subunits (${medium}), asset unknown`;
}

/** A rumor date as `YYYY-MM-DD HH:MM UTC`. */
export function dateText(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
