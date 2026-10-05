import type { OrderRecord, PricedPayout } from '@elisym/commerce/buyer';
import { isTerminal } from '@elisym/commerce/buyer';
import type { Network } from '@elisym/pay-core';
import type { OpenStatus, Paying, Rail, Receipt } from './session';

export function recordRail(record: OrderRecord): Rail {
  return record.payout.caip19.startsWith('eip155:') ? 'tempo' : 'solana';
}

/**
 * The payout target an order was placed to, from the order's own snapshot: a
 * store that lists another network first later must never move the order's
 * chain work (watching, ending, retrying) to that network.
 */
export function recordTarget(record: OrderRecord): PricedPayout['target'] | undefined {
  return record.offer.payouts.find(
    (payout) =>
      payout.caip19.id === record.payout.caip19 && payout.address === record.payout.address,
  );
}

/** What an order is paying, from the order's own snapshot. */
export function recordPaying(record: OrderRecord): Paying | undefined {
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

/** The block explorer page of a Solana transaction. */
export function explorerLink(signature: string, network: Network): string {
  const cluster = network === 'mainnet' ? '' : `?cluster=${network}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${cluster}`;
}

/** The explorer page of a transaction on the record's own chain. */
export function explorerFor(record: OrderRecord, tx: string, network: Network): string {
  if (recordRail(record) === 'solana') {
    return explorerLink(tx, network);
  }
  const template = recordTarget(record)?.caip19.chain.explorerTx;
  return template === undefined ? '' : template.replace('{tx}', encodeURIComponent(tx));
}

/** The order's own network: from its snapshot, else from the medium it was placed on. */
export function recordNetwork(record: OrderRecord): Network {
  return (
    recordTarget(record)?.caip19.chain.network ??
    (record.medium.includes('-') ? 'devnet' : 'mainnet')
  );
}

/** Where an unfinished purchase stands, for its receipt's `Status:` line; none for a finished one. */
export function openStatusOf(record: OrderRecord): OpenStatus | undefined {
  if (isTerminal(record)) {
    return undefined;
  }
  switch (record.state) {
    case 'paying':
      return 'paying';
    case 'blocked':
      return 'blocked';
    case 'paid':
      // The store cancelled a paid order and stated no refund: never "waiting".
      return record.status?.status === 'cancelled' && record.status.refunded !== true
        ? 'cancelled_paid'
        : 'waiting_store';
    default:
      return undefined;
  }
}

/**
 * What an order was, from its own record only: "Paid" only with `paidTx`
 * (this checkout's verifier found the payment), never on the store's word.
 * A sent transaction is never named here: it is added only after its chain check.
 */
export function receiptBase(record: OrderRecord, network: Network): Receipt {
  const paying = recordPaying(record);
  const openStatus = openStatusOf(record);
  const base: Receipt = {
    store: record.offer.profile.name ?? 'Unnamed store',
    product: record.offer.product.title,
    ...(paying === undefined ? {} : { paying }),
    orderId: record.orderId,
    orderedAt: record.createdAt,
    ...(record.status === undefined ? {} : { answeredAt: record.status.at }),
    ...(openStatus === undefined ? {} : { openStatus }),
  };
  const paidTx = record.paidTx;
  if (paidTx === undefined) {
    return base;
  }
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
