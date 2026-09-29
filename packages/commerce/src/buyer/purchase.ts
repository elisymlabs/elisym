import type { PricedPayout } from './offer';
import type { OrderRecord } from './order-record';
import type { OrderStore } from './order-store';
import { type SolanaPayDeps, endSolanaOrder } from './solana-pay';

/**
 * Decisions a purchase makes about the records it holds, shared by the widget's
 * session and the MCP's tools. Each caller sequences them with its own screens
 * or answers; the rules are the same.
 */

/** The store cancelled an order no payment is known for (the attempt, if any, is over). */
export function cancelledUnpaid(record: OrderRecord): boolean {
  return (
    record.status?.status === 'cancelled' &&
    record.paidTx === undefined &&
    (record.state === 'created' || record.state === 'ordered')
  );
}

/** Ended with no payment found (by this caller or another): no longer this product's purchase. */
export function gone(record: OrderRecord): boolean {
  return record.state === 'ended-unpaid' && record.paidTx === undefined;
}

/**
 * Whether `record` can still be paid on `payout`: an order is placed for one
 * payout and price, so an order on other terms, or one the store cancelled
 * while unpaid, must end before a new one is placed.
 */
export function onOtherTerms(record: OrderRecord, payout: PricedPayout): boolean {
  return (
    cancelledUnpaid(record) ||
    record.payout.caip19 !== payout.target.caip19.id ||
    record.payout.address !== payout.target.address ||
    record.amount !== payout.amount.toString()
  );
}

export type EndDeps = Pick<
  SolanaPayDeps,
  'store' | 'readClient' | 'clientFor' | 'now' | 'canProveOver'
> & {
  /** The order's own network's RPC, or `undefined` when the caller has none for it. */
  rpc: SolanaPayDeps['rpc'] | undefined;
  store: OrderStore;
};

/**
 * End an order that will not be paid, before a new one is placed beside it:
 * - a `created` order was never acknowledged and holds nothing: it counts as
 *   ended at once (it is never moved; `created` only becomes `ordered`);
 * - an acknowledged order with no attempt ends through the store alone;
 * - an order with an attempt ends only once the attempt provably ended, which
 *   needs the order's own RPC and `canProveOver` (see `endSolanaOrder`).
 * `ended: false` means an attempt may still land: follow it, never place a
 * second order beside it.
 */
export async function endOrder(
  record: OrderRecord,
  deps: EndDeps,
): Promise<{ ended: boolean; record: OrderRecord }> {
  if (record.state === 'created') {
    return { ended: true, record };
  }
  if (deps.rpc !== undefined) {
    return await endSolanaOrder(record, { ...deps, rpc: deps.rpc });
  }
  if (record.state === 'ordered' && record.marker === undefined) {
    const written = await deps.store.update(record.orderId, record.version, {
      state: 'ended-unpaid',
    });
    return written.ok ? { ended: true, record: written.record } : { ended: false, record };
  }
  return { ended: false, record };
}
