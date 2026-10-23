/**
 * A store on Base Sepolia for the `eip3009` tests: its terms, its orders taken
 * through intake, receipts, and a context on the fake chain.
 */
import { deriveOrderPaymentReference } from '@elisym/commerce';
import { mediumOf } from '@elisym/commerce/buyer';
import { type Eip3009Context, newScanMemory } from '../src/eip3009';
import { intake, storeIdentity, type StoreIdentity } from '../src/intake';
import { type LedgerState, type MerchantOrder, emptyLedger } from '../src/ledger';
import { publishTerms } from '../src/terms';
import { BLOCK_SECS, type NodeChain, nodeChain, timeOf } from './eip3009-chain';
import { D, type Key, delivered, key, productAt } from './fixtures';

/** The head's time: in the past, as every wrap the tests open must be. */
export const NOW = 1_791_000_000;
export const PRICE = 5_000_000n;
export const EVM_PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
export const OTHER_PAYOUT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

export interface Run {
  store: Key;
  buyer: Key;
  state: LedgerState;
  identity: StoreIdentity;
  fake: NodeChain;
  context: Eip3009Context;
  caip19: string;
  medium: string;
  orders: number;
}

export function setup(
  options: { caip2?: string; providerCap?: number; termsFrom?: number } = {},
): Run {
  const fake = nodeChain({
    headTime: NOW,
    ...(options.caip2 === undefined ? {} : { caip2: options.caip2 }),
    ...(options.providerCap === undefined ? {} : { providerCap: options.providerCap }),
  });
  const store = key();
  const state = emptyLedger();
  const caip19 = `${fake.chain.caip2}/erc20:${fake.mint}`;
  const from = options.termsFrom ?? NOW - 5 * 86_400;
  state.terms = publishTerms(
    [],
    { d: D, caip19, payout: EVM_PAYOUT, amount: PRICE.toString() },
    from,
    from,
  );
  const medium = mediumOf(fake.chain);
  const context: Eip3009Context = {
    client: fake.client,
    chain: fake.chain,
    asset: fake.asset,
    medium,
    storePubkey: store.pubkey,
    rangeCap: fake.chain.logRangeCap ?? 1000,
    samples: new Map(),
    scan: newScanMemory(),
    gate: { kind: 'verified' },
  };
  return {
    store,
    buyer: key(),
    state,
    identity: storeIdentity(store.pubkey, [D], [medium]),
    fake,
    context,
    caip19,
    medium,
    orders: 0,
  };
}

/** An order of `D` by a fresh buyer (or `buyer`), dated `createdAt`, taken through intake. */
export function orderAt(run: Run, createdAt: number, buyer: Key = key()): MerchantOrder {
  run.orders += 1;
  const orderId = `b3a7c2d4-0000-4000-8000-${run.orders.toString().padStart(12, '0')}`;
  const taken = intake(
    run.state,
    delivered(
      {
        type: 'order',
        storePubkey: run.store.pubkey,
        orderId,
        items: [{ product: productAt(run.store), quantity: 1 }],
        total: { amount: '5', currency: 'USD' },
      },
      buyer,
      run.store,
      createdAt,
    ),
    run.identity,
    createdAt,
  );
  if (taken.kind !== 'order') {
    throw new Error(`order not taken: ${JSON.stringify(taken)}`);
  }
  return taken.order;
}

export function nonceOf(run: Run, order: MerchantOrder): string {
  return deriveOrderPaymentReference({
    storePubkey: run.store.pubkey,
    buyerPubkey: order.buyerPubkey,
    orderId: order.orderId,
  }).eip3009;
}

/** Report `hash` for `order` on this chain, as intake records a receipt. */
export function reportOn(run: Run, order: MerchantOrder, hash: string, at = NOW - 60): void {
  order.reportedTxs.push(hash);
  order.recheckedAt = { ...order.recheckedAt, [hash]: at };
  order.reportedMedia = { ...order.reportedMedia, [hash]: run.medium };
}

/** The block at `time` on the fake chain. */
export function blockAt(run: Run, time: number): number {
  return Math.floor((time - run.fake.genesis) / BLOCK_SECS);
}

export function timeAt(run: Run, block: number): number {
  return timeOf(run.fake, block);
}
