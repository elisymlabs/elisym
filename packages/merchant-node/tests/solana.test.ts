import { NATIVE_SOL, USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { MAX_RECHECKS_PER_SWEEP, TERMS_WINDOW_SECS } from '../src/constants';
import { intake } from '../src/intake';
import type { MerchantOrder } from '../src/ledger';
import { catchUp, checkPayment, receivingAccount } from '../src/solana';
import { publishTerms } from '../src/terms';
import {
  PAYOUT,
  PRICE,
  T0,
  USDC_DEVNET_CAIP19,
  chain,
  key,
  landedPayment,
  orderFrom,
  requestFor,
  signatureOf,
  world,
} from './fixtures';

const SIG = signatureOf(7);
const OTHER_SIG = signatureOf(9);

function placeOrder(orderId = 'b3a7c2d4-0000-4000-8000-000000000001') {
  const setup = world();
  const buyer = key();
  const result = intake(setup.state, orderFrom(buyer, setup.store, orderId), setup.identity);
  if (result.kind !== 'order') {
    throw new Error('order not taken');
  }
  return { ...setup, buyer, order: result.order };
}

describe('checkPayment', () => {
  it('credits a payment bound to the order, at the price, and claims it', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({ [SIG]: await landedPayment(requestFor(order.reference)) });
    expect(await checkPayment(state, order, SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'paid',
    });
    expect(order.paid).toEqual({
      signature: SIG,
      amount: PRICE.toString(),
      blockTime: T0 + 120,
      caip19: USDC_DEVNET_CAIP19,
      medium: 'solana-devnet',
    });
    expect(state.claims[SIG]).toBe(order.key);
    // Checking the same payment again is harmless.
    expect(await checkPayment(state, order, SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'paid',
    });
  });

  it('never credits one payment to two orders', async () => {
    const { state, identity, store, order } = placeOrder();
    const { rpc } = chain({ [SIG]: await landedPayment(requestFor(order.reference)) });
    await checkPayment(state, order, SIG, { rpc, network: 'devnet' });
    const second = intake(
      state,
      orderFrom(key(), store, 'b3a7c2d4-0000-4000-8000-000000000002'),
      identity,
    );
    if (second.kind !== 'order') {
      throw new Error('second order not taken');
    }
    expect(await checkPayment(state, second.order, SIG, { rpc, network: 'devnet' })).toEqual({
      kind: 'refused',
      reason: 'claimed_by_another_order',
    });
    expect(second.order.paid).toBeUndefined();
  });

  it("refuses a payment under another order's reference, or below the price", async () => {
    const { state, order } = placeOrder();
    const foreign = requestFor(placeOrder('b3a7c2d4-0000-4000-8000-000000000003').order.reference);
    const underpaid = requestFor(order.reference, PRICE - 1n);
    const { rpc } = chain({
      [SIG]: await landedPayment(foreign),
      [OTHER_SIG]: await landedPayment(underpaid),
    });
    for (const signature of [SIG, OTHER_SIG]) {
      expect(await checkPayment(state, order, signature, { rpc, network: 'devnet' })).toEqual({
        kind: 'refused',
        reason: 'not_a_payment_for_this_order',
      });
    }
    expect(state.claims).toEqual({});
  });

  it("judges the price at the payment's block time, not the order's", async () => {
    const { state, order } = placeOrder();
    // The price doubled an hour after the order; the old price paid later is refused.
    state.terms = publishTerms(
      state.terms,
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: (PRICE * 2n).toString() },
      T0 + 3600,
    );
    const late = T0 + 3600 + TERMS_WINDOW_SECS + 1;
    const { rpc } = chain({
      [SIG]: await landedPayment(requestFor(order.reference), { blockTime: late }),
      [OTHER_SIG]: await landedPayment(requestFor(order.reference), { blockTime: T0 + 3600 + 60 }),
    });
    expect(await checkPayment(state, order, SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'refused',
    });
    // Within the window after the change, the old price still counts.
    expect(await checkPayment(state, order, OTHER_SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'paid',
    });
  });

  it('asks again, never refuses, when the chain cannot answer yet', async () => {
    const { state, order } = placeOrder();
    const { rpc: undated } = chain({
      [SIG]: await landedPayment(requestFor(order.reference), { blockTime: null }),
    });
    expect(await checkPayment(state, order, SIG, { rpc: undated, network: 'devnet' })).toEqual({
      kind: 'ask_again',
    });
    for (const { rpc } of [chain({}), chain({}, [], { failing: true })]) {
      expect(await checkPayment(state, order, SIG, { rpc, network: 'devnet' })).toEqual({
        kind: 'ask_again',
      });
    }
    expect(state.claims).toEqual({});
  });

  it('checks nothing against terms of another network', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({ [SIG]: await landedPayment(requestFor(order.reference)) });
    expect(await checkPayment(state, order, SIG, { rpc, network: 'mainnet' })).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
  });
});

describe('catchUp', () => {
  /** The payout's USDC token account, derived here independently of the code under test. */
  async function payoutAccount(): Promise<string> {
    const [account] = await findAssociatedTokenPda({
      owner: PAYOUT,
      mint: address(USDC_SOLANA_DEVNET.mint ?? ''),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return account;
  }

  it('lands SOL on the wallet itself, a token on its associated account', async () => {
    const terms = { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: PRICE.toString() };
    expect(await receivingAccount(terms, USDC_SOLANA_DEVNET)).toBe(await payoutAccount());
    expect(await receivingAccount(terms, NATIVE_SOL)).toBe(PAYOUT);
  });

  it("finds a payment no receipt reported, on the payout's token account", async () => {
    const { state, order } = placeOrder();
    const account = await payoutAccount();
    const { rpc, log } = chain(
      {
        [SIG]: await landedPayment(requestFor(order.reference)),
        [OTHER_SIG]: await landedPayment(requestFor(order.reference, PRICE - 1n)),
      },
      [OTHER_SIG, SIG],
      { account },
    );
    const result = await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(result.paid.map((entry: MerchantOrder) => entry.key)).toEqual([order.key]);
    expect(result.incomplete).toEqual([]);
    expect(order.paid?.signature).toBe(SIG);
    // It lists the token account, never the wallet, starting from the newest page.
    expect(log.listings.map((listing) => listing.address)).toEqual([account]);
    expect(log.listings[0]?.options.before).toBeUndefined();
  });

  it('reads each landed transaction once, however many orders are open and sweeps run', async () => {
    const { state, identity, store } = world();
    const orders: MerchantOrder[] = [];
    for (let index = 0; index < 20; index += 1) {
      const taken = intake(
        state,
        orderFrom(
          key(),
          store,
          `b3a7c2d4-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
        ),
        identity,
      );
      if (taken.kind === 'order') {
        orders.push(taken.order);
      }
    }
    const target = orders[7];
    if (target === undefined) {
      throw new Error('no order');
    }
    const unrelated = signatureOf(3);
    const { rpc, log } = chain(
      {
        [SIG]: await landedPayment(requestFor(target.reference)),
        [unrelated]: await landedPayment(requestFor(placeOrder().order.reference)),
      },
      [unrelated, SIG],
      { account: await payoutAccount() },
    );
    const first = await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(first.paid.map((entry) => entry.key)).toEqual([target.key]);
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 660);
    // Each fetched once to scan; the match is then checked by pay-core's verifier.
    expect(log.fetched.filter((signature) => signature === unrelated)).toHaveLength(1);
  });

  it('checks again a reported transaction that could not be judged at first', async () => {
    const { state, order } = placeOrder();
    order.reportedTxs.push(SIG);
    const { rpc } = chain({ [SIG]: await landedPayment(requestFor(order.reference)) }, [], {
      account: 'nothing-listed',
    });
    const result = await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(result.paid.map((entry) => entry.key)).toEqual([order.key]);
  });

  it('checks reported transactions under one budget per sweep, and never a refused one again', async () => {
    const { state, identity, store } = world();
    for (let index = 0; index < 10; index += 1) {
      const taken = intake(
        state,
        orderFrom(
          key(),
          store,
          `b3a7c2d4-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        ),
        identity,
      );
      if (taken.kind === 'order') {
        for (let fill = 30; fill < 35; fill += 1) {
          taken.order.reportedTxs.push(signatureOf(fill + index));
        }
      }
    }
    const { rpc, log } = chain({}, [], { account: 'nothing-listed' });
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    const firstSweep = log.fetched.length;
    // 20 rechecks, each one getTransaction per candidate terms (one here).
    expect(firstSweep).toBe(MAX_RECHECKS_PER_SWEEP);

    const { state: other, order } = placeOrder();
    const foreign = await landedPayment(
      requestFor(placeOrder('b3a7c2d4-0000-4000-8000-0000000009ff').order.reference),
    );
    order.reportedTxs.push(SIG);
    const refusing = chain({ [SIG]: foreign }, [], { account: 'nothing-listed' });
    await catchUp(other, { rpc: refusing.rpc, network: 'devnet' }, T0 + 600);
    expect(order.refusedTxs).toEqual([SIG]);
    await catchUp(other, { rpc: refusing.rpc, network: 'devnet' }, T0 + 660);
    expect(refusing.log.fetched).toEqual([SIG]);
  });

  it('never fetches again a scanned transaction already refused for the order', async () => {
    const { state, order } = placeOrder();
    const { rpc, log } = chain(
      { [SIG]: await landedPayment(requestFor(order.reference, PRICE - 1n)) },
      [SIG],
      { account: await payoutAccount() },
    );
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(order.refusedTxs).toEqual([SIG]);
    const after = log.fetched.length;
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 660);
    expect(log.fetched.length).toBe(after);
  });

  it('never reads a listed row older than any open order could need', async () => {
    const { state, order } = placeOrder();
    const old = signatureOf(5);
    const fiveDaysAgo = T0 - 5 * 24 * 60 * 60;
    const { rpc, log } = chain(
      { [old]: await landedPayment(requestFor(order.reference), { blockTime: fiveDaysAgo }) },
      [old],
      { account: await payoutAccount(), listedAt: { [old]: fiveDaysAgo } },
    );
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 660);
    expect(log.fetched).toEqual([]);
  });

  it('never caches a transaction whose block time is not known yet', async () => {
    const { state, order } = placeOrder();
    const account = await payoutAccount();
    const { rpc } = chain(
      { [SIG]: await landedPayment(requestFor(order.reference), { blockTime: null }) },
      [SIG],
      { account },
    );
    const result = await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(result.paid).toEqual([]);
    expect(state.scans).toEqual({});
  });

  it('says when a spammed history was cut short', async () => {
    const { state } = placeOrder();
    const { rpc } = chain({}, [signatureOf(4)], {
      account: await payoutAccount(),
      fullPages: true,
    });
    const result = await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(result.incomplete).toEqual([await payoutAccount()]);
  });

  it('credits what the bound transfer paid, not the price', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain(
      { [SIG]: await landedPayment(requestFor(order.reference, PRICE + 5n)) },
      [SIG],
      { account: await payoutAccount() },
    );
    await catchUp(state, { rpc, network: 'devnet' }, T0 + 600);
    expect(order.paid?.amount).toBe((PRICE + 5n).toString());
  });

  it('scans nothing when no order is open, and forgets old scans', async () => {
    const { state } = world();
    state.scans['acct:old'] = { blockTime: T0 - 10 * 24 * 60 * 60, references: [] };
    const { rpc, log } = chain({}, []);
    expect(await catchUp(state, { rpc, network: 'devnet' }, T0)).toEqual({
      paid: [],
      incomplete: [],
    });
    expect(log.listings).toEqual([]);
    expect(state.scans).toEqual({});
  });
});

describe('an order paid once', () => {
  it('never credits a second payment to an order already paid', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({
      [SIG]: await landedPayment(requestFor(order.reference)),
      [OTHER_SIG]: await landedPayment(requestFor(order.reference)),
    });
    await checkPayment(state, order, SIG, { rpc, network: 'devnet' });
    expect(await checkPayment(state, order, OTHER_SIG, { rpc, network: 'devnet' })).toEqual({
      kind: 'refused',
      reason: 'order_already_paid',
    });
    expect(order.paid?.signature).toBe(SIG);
    expect(state.claims[OTHER_SIG]).toBeUndefined();
  });

  it('accepts the old price paid just after an order placed right after a price change', async () => {
    const { state, identity, store } = world();
    state.terms = publishTerms(
      state.terms,
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: (PRICE * 2n).toString() },
      T0 + 100,
    );
    const taken = intake(
      state,
      orderFrom(key(), store, 'b3a7c2d4-0000-4000-8000-00000000abcd'),
      identity,
    );
    if (taken.kind !== 'order') {
      throw new Error('order not taken');
    }
    const { rpc } = chain({
      [SIG]: await landedPayment(requestFor(taken.order.reference), { blockTime: T0 + 200 }),
    });
    expect(await checkPayment(state, taken.order, SIG, { rpc, network: 'devnet' })).toMatchObject({
      kind: 'paid',
    });
  });
});
