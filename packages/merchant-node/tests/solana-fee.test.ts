import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
/**
 * The node's paid rule for Solana payments split with an elisym treasury:
 * in full (rule 1), split with a KNOWN treasury and the merchant getting at
 * least the 10% floor (rule 2), split with anything else (rule 3: asked again,
 * never refused), below the floor (rule 4: refused).
 */
import { USDC_SOLANA_DEVNET, composeSolanaPaymentRequest } from '@elisym/pay-core';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { CATCH_UP_SECS, MAX_RECHECKS_PER_SWEEP } from '../src/constants';
import { TREASURY_RETENTION_SECS, paymentFloor, recordTreasuryRead } from '../src/fee';
import { intake } from '../src/intake';
import { type LedgerState, pruneExpiredOrders, recordReport } from '../src/ledger';
import { catchUp, checkPayment } from '../src/solana';
import { publishTerms } from '../src/terms';
import { orderLines } from '../src/webhook-commands';
import {
  D,
  OTHER_TREASURY,
  PAYOUT,
  PRICE,
  T0,
  TREASURY,
  USDC_DEVNET_CAIP19,
  chain,
  key,
  landedPayment,
  landedSplit,
  orderFrom,
  signatureOf,
  world,
} from './fixtures';

const SIG = signatureOf(7);
const NOW = T0 + 600;
const FEE = 30_000n;
const FLOOR = paymentFloor(PRICE);

/** The config named `treasury` at `at` (the last read, unless `latest` is false). */
function knowTreasury(state: LedgerState, treasury: string, at: number, latest = true): void {
  if (latest) {
    recordTreasuryRead(state, 'devnet', { treasury, evmTreasury: undefined }, at);
    return;
  }
  const entry = state.treasuries.devnet ?? { solana: {}, evm: {} };
  entry.solana[treasury] = at;
  state.treasuries.devnet = entry;
}

function placeOrder(orderId = 'b3a7c2d4-0000-4000-8000-000000000001') {
  const setup = world();
  const result = intake(setup.state, orderFrom(key(), setup.store, orderId), setup.identity);
  if (result.kind !== 'order') {
    throw new Error('order not taken');
  }
  knowTreasury(setup.state, TREASURY, NOW);
  return { ...setup, order: result.order };
}

const context = (rpc: ReturnType<typeof chain>['rpc']) => ({
  rpc,
  network: 'devnet' as const,
  now: () => NOW,
});

describe('the paid rule on Solana', () => {
  it('rule 1: the full price with no fee leg is paid with no fee, whatever the fee is', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({
      [SIG]: await landedPayment(
        composeSolanaPaymentRequest({
          recipient: PAYOUT,
          amount: PRICE,
          asset: USDC_SOLANA_DEVNET,
          network: 'devnet',
          reference: order.reference,
          createdAt: T0,
        }),
      ),
    });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
    expect(order.paid).toMatchObject({ amount: PRICE.toString(), fee: '0' });
  });

  it('rule 2: a split to the current treasury is paid, recording the total and the fee', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({ [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
    expect(order.paid).toEqual({
      signature: SIG,
      amount: PRICE.toString(),
      fee: FEE.toString(),
      blockTime: T0 + 120,
      caip19: USDC_DEVNET_CAIP19,
      medium: 'solana-devnet',
    });
    expect(state.claims[SIG]).toBe(order.key);
  });

  it('rule 2 with a treasury excess records the fee as the price less the payee leg', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({ [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE * 3n) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
    expect(order.paid).toMatchObject({ amount: PRICE.toString(), fee: FEE.toString() });
  });

  it('rule 2: the treasury leg must cover the price less the payee leg', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({ [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE - 1n) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    expect(order.paid).toBeUndefined();
  });

  it('pays a split to a recently rotated-out treasury, still known', async () => {
    const { state, order } = placeOrder();
    knowTreasury(state, OTHER_TREASURY, NOW - 86_400, false);
    const { rpc } = chain({
      [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY),
    });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
    expect(order.paid?.fee).toBe(FEE.toString());
  });

  it('keeps a treasury exactly the retention window, and drops it a second later', async () => {
    for (const [age, paid] of [
      [TREASURY_RETENTION_SECS, true],
      [TREASURY_RETENTION_SECS + 1, false],
    ] as const) {
      const { state, order } = placeOrder();
      knowTreasury(state, OTHER_TREASURY, NOW - age, false);
      const { rpc } = chain({
        [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY),
      });
      const check = await checkPayment(state, order, SIG, context(rpc));
      expect(`${age}: ${check.kind}`).toBe(`${age}: ${paid ? 'paid' : 'ask_again'}`);
    }
  });

  it('pays the last-read treasury after a config outage longer than the catch-up window', async () => {
    const { state, order } = placeOrder();
    knowTreasury(state, OTHER_TREASURY, NOW - 10 * 86_400);
    const { rpc } = chain({
      [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY),
    });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
  });

  it('a fresh home with no treasury read asks again, then pays once the treasury is read', async () => {
    const { state, order } = placeOrder();
    state.treasuries = {};
    const { rpc } = chain({ [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    knowTreasury(state, TREASURY, NOW);
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
  });

  it('a split to an unknown address is asked again and marked, never refused', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({
      [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY),
    });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    expect(state.claims).toEqual({});
  });

  it('an unresolved term keeps the answer open, whatever a later term says', async () => {
    const { state, order } = placeOrder();
    // A split of 0.97 paid with 0.03 to TREASURY, whose balance row is unreadable.
    const landed = await landedSplit(order.reference, PRICE - FEE, FEE, TREASURY, {
      rows: [
        { owner: PAYOUT, pre: '0', post: (PRICE - FEE).toString() },
        { owner: TREASURY, pre: '0', post: 'not a number' },
      ],
    });
    // First a dearer term: 0.97 is above its floor, and its fee (0.08) is more
    // than any treasury got - unresolved. Then the order's own term, whose split
    // cannot be read - an ask with nothing unresolved, judged last.
    const dearer = (PRICE + 50_000n).toString();
    state.terms = [
      {
        terms: { d: D, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: dearer },
        from: T0 - 10,
      },
      ...state.terms,
    ];
    const { rpc } = chain({ [SIG]: landed });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
  });

  it('never uses a known treasury that is the payout itself', async () => {
    const { state, order } = placeOrder();
    knowTreasury(state, PAYOUT, NOW);
    const short = composeSolanaPaymentRequest({
      recipient: PAYOUT,
      amount: PRICE - FEE,
      asset: USDC_SOLANA_DEVNET,
      network: 'devnet',
      reference: order.reference,
      createdAt: T0,
    });
    const { rpc } = chain({ [SIG]: await landedPayment(short) });
    expect(await checkPayment(state, order, SIG, context(rpc))).not.toMatchObject({
      kind: 'paid',
    });
    expect(order.paid).toBeUndefined();
  });

  it('the floor at a 1000 bps fee: the floor is paid, one subunit less is refused', async () => {
    expect(FLOOR).toBe(900_000n);
    const atFloor = placeOrder();
    const paid = chain({
      [SIG]: await landedSplit(atFloor.order.reference, FLOOR, PRICE - FLOOR),
    });
    expect(await checkPayment(atFloor.state, atFloor.order, SIG, context(paid.rpc))).toMatchObject({
      kind: 'paid',
    });
    expect(atFloor.order.paid).toMatchObject({
      amount: PRICE.toString(),
      fee: (PRICE - FLOOR).toString(),
    });
    const below = placeOrder();
    const refused = chain({
      [SIG]: await landedSplit(below.order.reference, FLOOR - 1n, PRICE - FLOOR + 1n),
    });
    expect(await checkPayment(below.state, below.order, SIG, context(refused.rpc))).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
  });

  it('a one-subunit price with only a treasury leg is not paid', async () => {
    const setup = world();
    setup.state.terms = publishTerms(
      [],
      { d: D, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: '1' },
      T0,
      T0,
    );
    const taken = intake(
      setup.state,
      orderFrom(key(), setup.store, 'b3a7c2d4-0000-4000-8000-0000000000aa'),
      setup.identity,
    );
    if (taken.kind !== 'order') {
      throw new Error('order not taken');
    }
    knowTreasury(setup.state, TREASURY, NOW);
    expect(paymentFloor(1n)).toBe(0n);
    const toTreasury = composeSolanaPaymentRequest({
      recipient: TREASURY,
      amount: 1n,
      asset: USDC_SOLANA_DEVNET,
      network: 'devnet',
      reference: taken.order.reference,
      createdAt: T0,
    });
    const { rpc } = chain({ [SIG]: await landedPayment(toTreasury) });
    expect(await checkPayment(setup.state, taken.order, SIG, context(rpc))).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
  });

  it('a treasury balance that did not rise to match is not paid, and stays open', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({
      [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, TREASURY, {
        rows: [
          { owner: PAYOUT, pre: '0', post: (PRICE - FEE).toString() },
          { owner: TREASURY, pre: '0', post: (FEE - 1n).toString() },
        ],
      }),
    });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
  });

  it('an unreadable treasury balance asks again without marking the payment unresolved', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain({
      [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, TREASURY, {
        rows: [
          { owner: PAYOUT, pre: '0', post: (PRICE - FEE).toString() },
          { owner: TREASURY, pre: '0', post: 'not a number' },
        ],
      }),
    });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({ kind: 'ask_again' });
  });

  it('the full price that cannot be read yet asks again, never refused and never unresolved', async () => {
    const unreadablePayee = async (reference: string) => {
      const landed = await landedPayment(
        composeSolanaPaymentRequest({
          recipient: PAYOUT,
          amount: PRICE,
          asset: USDC_SOLANA_DEVNET,
          network: 'devnet',
          reference,
          createdAt: T0,
        }),
      );
      const meta = landed.meta as { postTokenBalances: { uiTokenAmount: { amount: string } }[] };
      for (const row of meta.postTokenBalances) {
        row.uiTokenAmount.amount = 'not a number';
      }
      return landed;
    };
    const noMeta = async (reference: string) => {
      const { meta: _meta, ...landed } = await landedPayment(
        composeSolanaPaymentRequest({
          recipient: PAYOUT,
          amount: PRICE,
          asset: USDC_SOLANA_DEVNET,
          network: 'devnet',
          reference,
          createdAt: T0,
        }),
      );
      return landed;
    };
    for (const [name, landedFor] of [
      ['unreadable payee balance', unreadablePayee],
      ['no meta', noMeta],
    ] as const) {
      const { state, order } = placeOrder();
      const landed = await landedFor(order.reference);
      const check = await checkPayment(state, order, SIG, context(chain({ [SIG]: landed }).rpc));
      expect({ name, check }).toEqual({ name, check: { kind: 'ask_again' } });
      // Through the catch-up: neither refused nor marked unresolved.
      recordReport(order, SIG, NOW - 60);
      const { rpc } = chain({ [SIG]: landed }, [], { account: 'nothing-listed' });
      const swept = await catchUp(state, context(rpc), NOW);
      expect({
        name,
        logged: swept.unresolved,
        marked: order.feeUnresolved,
        refused: order.refusedTxs,
        claims: state.claims,
      }).toEqual({ name, logged: undefined, marked: undefined, refused: undefined, claims: {} });
    }
  });

  it('the full price with a payee balance that did not rise to match is refused, as before fees', async () => {
    const { state, order } = placeOrder();
    const full = composeSolanaPaymentRequest({
      recipient: PAYOUT,
      amount: PRICE,
      asset: USDC_SOLANA_DEVNET,
      network: 'devnet',
      reference: order.reference,
      createdAt: T0,
    });
    const { rpc } = chain({ [SIG]: await landedPayment(full, { received: PRICE - FEE }) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
  });

  it('a signature that can never land is refused without a read', async () => {
    const { state, order } = placeOrder();
    const { rpc, log } = chain({});
    expect(await checkPayment(state, order, 'not-a-signature', context(rpc))).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
    expect(log.fetched).toEqual([]);
  });

  it('reads the transaction once per check, however many terms and treasuries', async () => {
    const { state, order } = placeOrder();
    knowTreasury(state, OTHER_TREASURY, NOW - 60, false);
    // A second term of the same product (a price change after the order).
    state.terms = publishTerms(
      state.terms,
      { d: D, caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: (PRICE * 2n).toString() },
      T0 + 100,
      T0 + 100,
    );
    const { rpc, log } = chain({ [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
    expect(log.fetched).toEqual([SIG]);
  });

  it('a term whose request cannot be composed is skipped, never aborting the check', async () => {
    const { state, order } = placeOrder();
    // A broken term first (no Solana address as its payout), then the real one.
    state.terms = [
      {
        terms: { d: D, caip19: USDC_DEVNET_CAIP19, payout: 'not-an-address', amount: '5' },
        from: T0 - 10,
      },
      ...state.terms,
    ];
    const { rpc } = chain({ [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE) });
    expect(await checkPayment(state, order, SIG, context(rpc))).toMatchObject({ kind: 'paid' });
  });
});

async function payoutAccount(): Promise<string> {
  const [account] = await findAssociatedTokenPda({
    owner: address(PAYOUT),
    mint: address(USDC_SOLANA_DEVNET.mint ?? ''),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return account;
}

describe('rule 3 in the catch-up', () => {
  it('a scanned split to an unknown address is marked unresolved, never refused, and paid once known', async () => {
    const { state, order } = placeOrder();
    const { rpc } = chain(
      { [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY) },
      [SIG],
      { account: await payoutAccount() },
    );
    const first = await catchUp(state, context(rpc), NOW);
    expect(first.paid).toEqual([]);
    expect(first.unresolved).toEqual([`${order.key} ${SIG}`]);
    expect(order.feeUnresolved).toEqual({ [SIG]: NOW });
    expect(order.refusedTxs).toBeUndefined();
    // Seen again: still open, not logged again.
    const second = await catchUp(state, context(rpc), NOW + 60);
    expect(second.unresolved).toBeUndefined();
    expect(order.feeUnresolved).toEqual({ [SIG]: NOW });
    // The next treasury read names it: paid, and the mark is gone.
    knowTreasury(state, OTHER_TREASURY, NOW + 100);
    const third = await catchUp(state, context(rpc), NOW + 120);
    expect(third.paid).toEqual([order]);
    expect(order.paid?.fee).toBe(FEE.toString());
    expect(order.feeUnresolved).toBeUndefined();
  });

  it('a payment asked again for another reason is never marked unresolved', async () => {
    const { state, order } = placeOrder();
    order.reportedTxs.push(SIG);
    const { rpc } = chain({}, [], { failing: true, account: 'nothing-listed' });
    const swept = await catchUp(state, context(rpc), NOW);
    expect(swept.unresolved).toBeUndefined();
    expect(order.feeUnresolved).toBeUndefined();
  });

  it('an unresolved payment both reported and scanned is rechecked once per sweep', async () => {
    const { state, order } = placeOrder();
    recordReport(order, SIG, NOW - 60);
    const { rpc, log } = chain(
      { [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY) },
      [SIG],
      { account: await payoutAccount() },
    );
    await catchUp(state, context(rpc), NOW);
    expect(order.feeUnresolved).toEqual({ [SIG]: NOW });
    for (const at of [NOW + 60, NOW + 120]) {
      const before = log.fetched.length;
      await catchUp(state, context(rpc), at);
      // The scan is remembered: the one read is the recheck, never two for one payment.
      expect(log.fetched.slice(before)).toEqual([SIG]);
      expect(order.recheckedAt?.[SIG]).toBe(at);
    }
  });

  it('rechecks scanned unresolved payments under the sweep budget, oldest check first', async () => {
    const setup = world();
    const orders = Array.from({ length: MAX_RECHECKS_PER_SWEEP + 5 }, (_, index) => {
      const taken = intake(
        setup.state,
        orderFrom(key(), setup.store, `b3a7c2d4-0000-4000-8000-${String(index).padStart(12, '0')}`),
        setup.identity,
      );
      if (taken.kind !== 'order') {
        throw new Error('order not taken');
      }
      return taken.order;
    });
    knowTreasury(setup.state, TREASURY, NOW);
    const transactions: Record<string, unknown> = {};
    const signatures: string[] = [];
    for (const [index, order] of orders.entries()) {
      const signature = signatureOf(index + 1);
      signatures.push(signature);
      transactions[signature] = await landedSplit(
        order.reference,
        PRICE - FEE,
        FEE,
        OTHER_TREASURY,
      );
    }
    const { rpc, log } = chain(transactions, signatures, { account: await payoutAccount() });
    await catchUp(setup.state, context(rpc), NOW);
    expect(orders.every((order) => order.feeUnresolved !== undefined)).toBe(true);
    const before = log.fetched.length;
    await catchUp(setup.state, context(rpc), NOW + 60);
    // Scans are remembered: only the budgeted rechecks read a transaction.
    expect(log.fetched.length - before).toBe(MAX_RECHECKS_PER_SWEEP);
    const rechecked = orders.filter((order) =>
      Object.values(order.recheckedAt ?? {}).includes(NOW + 60),
    );
    expect(rechecked).toHaveLength(MAX_RECHECKS_PER_SWEEP);
    // The next sweep reaches the ones left behind first.
    const after = log.fetched.length;
    await catchUp(setup.state, context(rpc), NOW + 120);
    const reached = orders.filter((order) =>
      Object.values(order.recheckedAt ?? {}).includes(NOW + 120),
    );
    expect(log.fetched.length - after).toBe(MAX_RECHECKS_PER_SWEEP);
    expect(reached.filter((order) => !rechecked.includes(order))).toHaveLength(5);
  });
});

describe('a payment set aside for good drops its unresolved mark', () => {
  it('unresolved, then the treasury is known but the block-time guard refuses it: no mark left anywhere', async () => {
    const { state, order, store } = placeOrder();
    const { rpc } = chain(
      { [SIG]: await landedSplit(order.reference, PRICE - FEE, FEE, OTHER_TREASURY) },
      [SIG],
      { account: await payoutAccount() },
    );
    await catchUp(state, context(rpc), NOW);
    expect(order.feeUnresolved).toEqual({ [SIG]: NOW });
    // The treasury is read, and rule 2 verifies the split - but the terms it
    // pays started after its block time (T0 + 120): the guard refuses it.
    knowTreasury(state, OTHER_TREASURY, NOW + 30);
    state.terms = state.terms.map((period) => ({ ...period, from: T0 + 200 }));
    const swept = await catchUp(state, context(rpc), NOW + 60);
    expect(swept.paid).toEqual([]);
    expect(order.refusedTxs).toEqual([SIG]);
    expect(order.feeUnresolved).toBeUndefined();
    expect(orderLines(state, store.pubkey).join('\n')).not.toContain('feeUnresolved');
    // Closed by the window: no unresolved payment is kept for the owner.
    const closed = pruneExpiredOrders(
      state,
      order.createdAt + CATCH_UP_SECS + MAX_FUTURE_SKEW_SECS + 1,
    );
    expect(closed).toEqual([]);
    expect(state.unresolvedPayments).toEqual([]);
    expect(state.orders[order.key]).toBeUndefined();
  });

  it('a reported payment refused later drops only its own mark', async () => {
    const { state, order } = placeOrder();
    const other = signatureOf(8);
    order.feeUnresolved = { [SIG]: NOW - 60, [other]: NOW - 60 };
    recordReport(order, SIG, NOW - 60);
    // Below the floor: refused whatever is known.
    const { rpc } = chain({
      [SIG]: await landedSplit(order.reference, FLOOR - 1n, PRICE - FLOOR + 1n),
    });
    await catchUp(state, context(rpc), NOW);
    expect(order.refusedTxs).toEqual([SIG]);
    expect(order.feeUnresolved).toEqual({ [other]: NOW - 60 });
  });
});

describe('the queue place of a newly unresolved scanned payment', () => {
  it('is the sweep that found it: reports waiting since before go first', async () => {
    const setup = world();
    const takeOrder = (orderId: string) => {
      const taken = intake(setup.state, orderFrom(key(), setup.store, orderId), setup.identity);
      if (taken.kind !== 'order') {
        throw new Error('order not taken');
      }
      return taken.order;
    };
    const scanned = takeOrder('b3a7c2d4-0000-4000-8000-0000000000a1');
    const reporter = takeOrder('b3a7c2d4-0000-4000-8000-0000000000a2');
    knowTreasury(setup.state, TREASURY, NOW);
    // Twice the budget of reports, all arrived before the first sweep and never
    // landing: the first sweep checks half of them, the rest keep their arrival.
    const reports = Array.from({ length: 2 * MAX_RECHECKS_PER_SWEEP }, (_, index) =>
      signatureOf(100 + index),
    );
    for (const report of reports) {
      recordReport(reporter, report, NOW - 30);
    }
    const { rpc } = chain(
      { [SIG]: await landedSplit(scanned.reference, PRICE - FEE, FEE, OTHER_TREASURY) },
      [SIG],
      { account: await payoutAccount() },
    );
    await catchUp(setup.state, context(rpc), NOW);
    expect(scanned.feeUnresolved).toEqual({ [SIG]: NOW });
    expect(scanned.recheckedAt?.[SIG]).toBe(NOW);
    const waiting = reports.filter((report) => reporter.recheckedAt?.[report] === NOW - 30);
    expect(waiting).toHaveLength(MAX_RECHECKS_PER_SWEEP);
    // The next sweep reaches the reports still waiting since before it found the payment.
    await catchUp(setup.state, context(rpc), NOW + 60);
    expect(waiting.every((report) => reporter.recheckedAt?.[report] === NOW + 60)).toBe(true);
    expect(scanned.recheckedAt?.[SIG]).toBe(NOW);
  });
});
