import { USDC_SOLANA_DEVNET, composeSolanaPaymentRequest } from '@elisym/pay-core';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  MAX_RECHECKS_PER_SWEEP,
  ORDER_SCAN_MARGIN_SECS,
  TERMS_WINDOW_SECS,
} from '../src/constants';
import { intake } from '../src/intake';
import { pruneExpiredOrders, recordReport } from '../src/ledger';
import { catchUp, checkPayment } from '../src/solana';
import { publishTerms } from '../src/terms';
import {
  PAYOUT,
  PRICE,
  T0,
  USDC_DEVNET_CAIP19,
  chain,
  delivered,
  key,
  landedPayment,
  orderFrom,
  requestFor,
  signatureOf,
  world,
} from './fixtures';

const SIG = signatureOf(7);
const OLD_PAYOUT = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');

function orderIn(setup: ReturnType<typeof world>, orderId: string, createdAt?: number) {
  const buyer = key();
  const message = orderFrom(buyer, setup.store, orderId);
  const taken = intake(
    setup.state,
    createdAt === undefined ? message : { ...message, createdAt },
    setup.identity,
  );
  if (taken.kind !== 'order') {
    throw new Error('order not taken');
  }
  return taken.order;
}

function paidTo(reference: string, recipient: string) {
  return composeSolanaPaymentRequest({
    recipient,
    amount: PRICE,
    asset: USDC_SOLANA_DEVNET,
    network: 'devnet',
    reference,
    createdAt: T0,
  });
}

describe("the payout at the payment's block time", () => {
  it("refuses the old payout paid long after a rotation, whatever the order's date", async () => {
    const setup = world();
    // The payout was OLD_PAYOUT until T0 + 1000, then PAYOUT (same coin, same price).
    setup.state.terms = publishTerms(
      [],
      { caip19: USDC_DEVNET_CAIP19, payout: OLD_PAYOUT, amount: PRICE.toString() },
      T0 - 5000,
    );
    setup.state.terms = publishTerms(
      setup.state.terms,
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
      T0 + 1000,
    );
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a001', T0 + 1000 - 600);
    const late = T0 + 1000 + TERMS_WINDOW_SECS + 7200;
    const { rpc } = chain({
      [SIG]: await landedPayment(paidTo(order.reference, OLD_PAYOUT), { blockTime: late }),
    });
    expect(await checkPayment(setup.state, order, SIG, { rpc, network: 'devnet' })).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
  });

  it('accepts the old payout paid right after an order placed soon after a rotation', async () => {
    const setup = world();
    setup.state.terms = publishTerms(
      [],
      { caip19: USDC_DEVNET_CAIP19, payout: OLD_PAYOUT, amount: PRICE.toString() },
      T0 - 5000,
    );
    setup.state.terms = publishTerms(
      setup.state.terms,
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
      T0 - 40 * 60,
    );
    // Ordered 40 minutes after the rotation, the old payout paid a minute later.
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a002', T0);
    const { rpc } = chain({
      [SIG]: await landedPayment(paidTo(order.reference, OLD_PAYOUT), { blockTime: T0 + 60 }),
    });
    expect(await checkPayment(setup.state, order, SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'paid',
    });
  });
});

describe('the order scan margin', () => {
  it('keeps old terms in reach of an order rumor dated ahead of its payment', async () => {
    const setup = world();
    const rotation = T0 + 10_000;
    setup.state.terms = publishTerms(
      [],
      { caip19: USDC_DEVNET_CAIP19, payout: OLD_PAYOUT, amount: PRICE.toString() },
      T0 - 5000,
    );
    setup.state.terms = publishTerms(
      setup.state.terms,
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
      rotation,
    );
    const paidAt = rotation + 40 * 60;
    // The rumor claims a date 15 minutes after the payment (the skew allowance).
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a007', paidAt + 15 * 60);
    const { rpc } = chain({
      [SIG]: await landedPayment(paidTo(order.reference, OLD_PAYOUT), { blockTime: paidAt }),
    });
    expect(await checkPayment(setup.state, order, SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'paid',
    });
  });
});

describe('what asks again', () => {
  it('asks again on a page it cannot read, and never remembers that as a refusal', async () => {
    const setup = world();
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a003');
    const unreadable = await landedPayment(requestFor(order.reference));
    delete (unreadable as { meta?: unknown }).meta;
    const { rpc } = chain({ [SIG]: unreadable }, [], { account: 'nothing-listed' });
    expect(await checkPayment(setup.state, order, SIG, { rpc, network: 'devnet' })).toEqual({
      kind: 'ask_again',
    });
    order.reportedTxs.push(SIG);
    await catchUp(setup.state, { rpc, network: 'devnet' }, T0 + 600);
    expect(order.refusedTxs ?? []).toEqual([]);
  });
});

describe('two candidate terms', () => {
  it('asks again when one could not be read, even if another refuses', async () => {
    const setup = world();
    setup.state.terms = publishTerms(
      [],
      { caip19: USDC_DEVNET_CAIP19, payout: OLD_PAYOUT, amount: PRICE.toString() },
      T0 - 5000,
    );
    setup.state.terms = publishTerms(
      setup.state.terms,
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
      T0 - 60,
    );
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a009');
    // The first candidate's read fails; the second reads a payment to someone else.
    const { rpc } = chain(
      {
        [SIG]: await landedPayment(
          paidTo(order.reference, address('11111111111111111111111111111112')),
        ),
      },
      [],
      { failingOnce: true },
    );
    expect(await checkPayment(setup.state, order, SIG, { rpc, network: 'devnet' })).toEqual({
      kind: 'ask_again',
    });
  });
});

describe('the catch-up scan', () => {
  it('finds a payment dated before the order, within the scan margin', async () => {
    const setup = world();
    setup.state.terms = publishTerms(
      [],
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() },
      T0 - 5000,
    );
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a004');
    const [account] = await findAssociatedTokenPda({
      owner: PAYOUT,
      mint: address(USDC_SOLANA_DEVNET.mint ?? ''),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    // The order rumor may be dated up to 15 minutes ahead of the payment.
    const early = order.createdAt - ORDER_SCAN_MARGIN_SECS + 60;
    const { rpc } = chain(
      { [SIG]: await landedPayment(requestFor(order.reference), { blockTime: early }) },
      [SIG],
      { account, listedAt: { [SIG]: early } },
    );
    const result = await catchUp(setup.state, { rpc, network: 'devnet' }, T0 + 600);
    expect(result.paid.map((entry) => entry.key)).toEqual([order.key]);
  });

  it('reaches every reported transaction within a few sweeps, the longest unchecked first', async () => {
    const setup = world();
    const orders = Array.from({ length: MAX_RECHECKS_PER_SWEEP + 5 }, (_, index) => {
      const order = orderIn(
        setup,
        `b3a7c2d4-0000-4000-8000-0000000b${String(index).padStart(4, '0')}`,
        T0 + index,
      );
      order.reportedTxs.push(signatureOf(40 + index));
      return order;
    });
    const { rpc, log } = chain({}, [], { account: 'nothing-listed' });
    await catchUp(setup.state, { rpc, network: 'devnet' }, T0 + 600);
    expect(log.fetched).toHaveLength(MAX_RECHECKS_PER_SWEEP);
    await catchUp(setup.state, { rpc, network: 'devnet' }, T0 + 660);
    // The second sweep starts with the five the first one could not reach.
    const all = orders.map((order) => order.reportedTxs[0]);
    expect(new Set(log.fetched)).toEqual(new Set(all));
  });
});

describe('the recheck queue', () => {
  it('reaches an older report again however many fresh ones arrive after it', async () => {
    const setup = world();
    const first = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000e000');
    const original = signatureOf(90);
    recordReport(first, original, T0);
    const { rpc, log } = chain({}, [], { account: 'nothing-listed' });
    await catchUp(setup.state, { rpc, network: 'devnet' }, T0 + 60);
    let reached = 0;
    for (let sweep = 1; sweep <= 4; sweep += 1) {
      for (let index = 0; index < MAX_RECHECKS_PER_SWEEP; index += 1) {
        const order = orderIn(
          setup,
          `b3a7c2d4-0000-4000-8000-0000000e${String(sweep * 100 + index).padStart(4, '0')}`,
        );
        recordReport(order, signatureOf(100 + sweep * 30 + index), T0 + 60 + sweep * 60);
      }
      const before = log.fetched.filter((signature) => signature === original).length;
      await catchUp(setup.state, { rpc, network: 'devnet' }, T0 + 120 + sweep * 60);
      reached += log.fetched.filter((signature) => signature === original).length - before;
    }
    expect(reached).toBeGreaterThan(0);
  });
});

describe('pruning', () => {
  it('keeps an unpaid order through the window and the skew allowance', () => {
    const setup = world();
    const order = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a008');
    pruneExpiredOrders(setup.state, order.createdAt + 3 * 24 * 60 * 60 + 60);
    expect(setup.state.orders[order.key]).toBeDefined();
    pruneExpiredOrders(setup.state, order.createdAt + 3 * 24 * 60 * 60 + 15 * 60 + 1);
    expect(setup.state.orders[order.key]).toBeUndefined();
  });

  it('drops unpaid orders past the window, and their ids stay used', () => {
    const setup = world();
    const buyer = key();
    const orderId = 'b3a7c2d4-0000-4000-8000-00000000a005';
    const order = intake(setup.state, orderFrom(buyer, setup.store, orderId), setup.identity);
    const paid = orderIn(setup, 'b3a7c2d4-0000-4000-8000-00000000a006');
    paid.paid = {
      signature: SIG,
      amount: '1',
      blockTime: T0,
      caip19: 'x',
      medium: 'solana-devnet',
    };
    pruneExpiredOrders(setup.state, T0 + 4 * 24 * 60 * 60);
    expect(Object.keys(setup.state.orders)).toEqual([paid.key]);
    expect(order.kind).toBe('order');
    // A new rumor under the pruned order's id is still dropped.
    const again = delivered(
      {
        type: 'order',
        storePubkey: setup.store.pubkey,
        orderId,
        items: [{ product: setup.identity.productAddress, quantity: 1 }],
        total: { amount: '2', currency: 'USD' },
      },
      buyer,
      setup.store,
    );
    expect(intake(setup.state, again, setup.identity)).toEqual({
      kind: 'ignored',
      reason: 'order_id_reused',
    });
  });
});
