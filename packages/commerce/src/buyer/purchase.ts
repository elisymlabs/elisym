import type { Eip1193Client } from '@elisym/pay-core/evm';
import { payoutRail } from '../caip';
import { endEip3009Order } from './eip3009-pay';
import type { PricedPayout } from './offer';
import type { OrderRecord } from './order-record';
import type { OrderStore } from './order-store';
import { type SolanaPayDeps, endSolanaOrder } from './solana-pay';
import { endTempoOrder } from './tempo-pay';

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
 * Whether `record` can still be paid on `payout` for `customerRef`: an order is
 * placed for one payout, price and account, so an order on other terms, or one
 * the store cancelled while unpaid, must end before a new one is placed. A
 * missing and an empty reference are the same account. The reference is
 * required so that every caller states the one it pays for.
 */
export function onOtherTerms(
  record: OrderRecord,
  payout: PricedPayout,
  customerRef: string | undefined,
): boolean {
  return (
    cancelledUnpaid(record) ||
    record.payout.caip19 !== payout.target.caip19.id ||
    record.payout.address !== payout.target.address ||
    record.amount !== payout.amount.toString() ||
    (record.customerRef ?? '') !== (customerRef ?? '')
  );
}

export type EndDeps = Pick<
  SolanaPayDeps,
  'store' | 'readClient' | 'clientFor' | 'now' | 'canProveOver'
> & {
  /** The order's own network's RPC, or `undefined` when the caller has none for it. */
  rpc: SolanaPayDeps['rpc'] | undefined;
  /** For a Tempo order: a read RPC of its own chain, or `undefined` when the caller has none. */
  tempo?: Eip1193Client;
  /**
   * For an `eip3009` order (Ethereum, Arbitrum, Base): the caller's RPC of its own
   * chain, which the end proof reads, or `undefined` when the caller has none.
   */
  eip3009?: Eip1193Client;
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
  // A Tempo order ends on its own rail's rules: an attempt only once proven
  // over, and then `over` - its prompt still open.
  // By the payout's `settlement`, never the CAIP-2 prefix: an `eip3009` payout
  // (Base, ...) is EVM too, and no Tempo or Solana rule may end it.
  const rail = payoutRail(record.payout.caip19);
  if (rail === 'tempo' && deps.tempo !== undefined) {
    return await endTempoOrder(record, { ...deps, client: deps.tempo });
  }
  // A signed EIP-3009 attempt ends only through the end proof (`endEip3009Order`).
  if (rail === 'eip3009' && deps.eip3009 !== undefined) {
    return await endEip3009Order(record, { ...deps, client: deps.eip3009 });
  }
  if (deps.rpc !== undefined && rail === 'solana') {
    return await endSolanaOrder(record, { ...deps, rpc: deps.rpc });
  }
  if (record.state === 'ordered' && record.marker === undefined) {
    const written = await deps.store.update(record.orderId, record.version, {
      state: 'ended-unpaid',
      // Nothing was requested: no Tempo prompt can be open for it. The store
      // refuses `endedBy` on any other rail.
      ...(rail === 'tempo' ? { endedBy: 'nothing' as const } : {}),
    });
    return written.ok ? { ended: true, record: written.record } : { ended: false, record };
  }
  return { ended: false, record };
}
