/**
 * The owner's hand answers: which orders may be answered, how the close is
 * kept, and that the signed status reads back as the widget reads it.
 */
import { unwrapOrderMessage } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import { applyHandAnswer, buildHandAnswer, planHandAnswer } from '../src/hand';
import { intake } from '../src/intake';
import { pruneExpiredOrders } from '../src/ledger';
import { T0, USDC_DEVNET_CAIP19, delivered, key, orderFrom, signatureOf, world } from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000d001';
const DELIVERY = { method: 'access' as const, value: 'https://shop.example/course' };
const TEMPO_TX = `0x${'ab'.repeat(32)}`;
const PATHUSD_MODERATO = 'eip155:42431/erc20:0x20c0000000000000000000000000000000000000';
const ONE_PAYOUT = [USDC_DEVNET_CAIP19];
const TWO_PAYOUTS = [USDC_DEVNET_CAIP19, PATHUSD_MODERATO];

function withOrder() {
  const setup = world();
  const buyer = key();
  const taken = intake(setup.state, orderFrom(buyer, setup.store, ORDER_ID), setup.identity);
  if (taken.kind !== 'order') {
    throw new Error('order not taken');
  }
  return { ...setup, buyer, order: taken.order };
}

describe('answering by hand', () => {
  it('delivers an unpaid order, closes its key and keeps what was sent', () => {
    const run = withOrder();
    run.order.reportedTxs.push(TEMPO_TX);
    run.order.noLegTxs = [TEMPO_TX];
    const plan = planHandAnswer(run.state, run.order.key, {
      kind: 'delivered',
      delivery: DELIVERY,
    });
    expect(plan).toMatchObject({ ok: true, rerun: false });
    if (!plan.ok) {
      throw new Error(plan.problem);
    }
    applyHandAnswer(run.state, run.order.key, plan.answer);
    expect(run.state.orders[run.order.key]).toBeUndefined();
    expect(run.state.closedOrders?.[run.order.key]).toBe(true);
    expect(run.state.answeredByHand?.[run.order.key]).toMatchObject({
      kind: 'delivered',
      delivery: DELIVERY,
      reportedTxs: [TEMPO_TX],
      noLegTxs: [TEMPO_TX],
    });
    // The signed status is a delivery the widget reads, with no receipt.
    const wrap = buildHandAnswer(plan, run.store.secretKey, T0 + 100);
    const read = unwrapOrderMessage(wrap.recipientWrap, run.buyer.secretKey);
    expect(read?.message).toMatchObject({
      type: 'status',
      status: 'completed',
      orderId: ORDER_ID,
      delivery: DELIVERY,
    });
    // The id stays used: a new order under the same id is refused, also by today's intake.
    const recreated = delivered(
      {
        type: 'order',
        storePubkey: run.store.pubkey,
        orderId: ORDER_ID,
        items: [{ product: run.identity.productAddress, quantity: 1 }],
        total: { amount: '2', currency: 'USD' },
      },
      run.buyer,
      run.store,
    );
    expect(intake(run.state, recreated, run.identity)).toMatchObject({ reason: 'order_id_reused' });
  });

  it('re-sends the stored answer, and refuses the opposite one', () => {
    const run = withOrder();
    const first = planHandAnswer(run.state, run.order.key, {
      kind: 'delivered',
      delivery: DELIVERY,
    });
    if (!first.ok) {
      throw new Error(first.problem);
    }
    applyHandAnswer(run.state, run.order.key, first.answer);
    const again = planHandAnswer(run.state, run.order.key, {
      kind: 'delivered',
      delivery: { method: 'access', value: 'https://changed.example' },
    });
    expect(again).toMatchObject({ ok: true, rerun: true, answer: { delivery: DELIVERY } });
    expect(
      planHandAnswer(run.state, run.order.key, {
        kind: 'refunded',
        tx: TEMPO_TX,
        amount: '5',
        payoutAssets: ONE_PAYOUT,
      }),
    ).toMatchObject({ ok: false });
  });

  it('refunds with a real refund only, and reads back as a refund', () => {
    const run = withOrder();
    for (const bad of [
      { tx: TEMPO_TX, amount: '0' },
      { tx: TEMPO_TX, amount: '-1' },
      { tx: TEMPO_TX.toUpperCase().replace('0X', '0x'), amount: '5' },
      { tx: 'not-a-tx', amount: '5' },
    ]) {
      expect(
        planHandAnswer(run.state, run.order.key, {
          kind: 'refunded',
          ...bad,
          payoutAssets: [PATHUSD_MODERATO],
        }),
      ).toMatchObject({
        ok: false,
      });
    }
    const plan = planHandAnswer(run.state, run.order.key, {
      kind: 'refunded',
      tx: signatureOf(3),
      amount: '1000000',
      payoutAssets: ONE_PAYOUT,
    });
    if (!plan.ok) {
      throw new Error(plan.problem);
    }
    const read = unwrapOrderMessage(
      buildHandAnswer(plan, run.store.secretKey, T0 + 100).recipientWrap,
      run.buyer.secretKey,
    );
    expect(read?.message).toMatchObject({
      status: 'cancelled',
      refund: { tx: signatureOf(3), amount: '1000000', caip19: USDC_DEVNET_CAIP19 },
    });
  });

  it('names the refunded asset: the only payout by default, --asset when there are several', () => {
    const refund = { kind: 'refunded' as const, tx: signatureOf(5), amount: '7' };
    const single = withOrder();
    expect(
      planHandAnswer(single.state, single.order.key, { ...refund, payoutAssets: ONE_PAYOUT }),
    ).toMatchObject({ ok: true, answer: { caip19: USDC_DEVNET_CAIP19 } });
    const several = withOrder();
    expect(
      planHandAnswer(several.state, several.order.key, { ...refund, payoutAssets: TWO_PAYOUTS }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/--asset/) });
    expect(
      planHandAnswer(several.state, several.order.key, {
        ...refund,
        asset: USDC_DEVNET_CAIP19,
        payoutAssets: TWO_PAYOUTS,
      }),
    ).toMatchObject({ ok: true, answer: { caip19: USDC_DEVNET_CAIP19 } });
    // A coin since removed from the config is still a refund the node can name.
    expect(
      planHandAnswer(several.state, several.order.key, {
        ...refund,
        tx: TEMPO_TX,
        asset: PATHUSD_MODERATO,
        payoutAssets: ONE_PAYOUT,
      }),
    ).toMatchObject({ ok: true, answer: { caip19: PATHUSD_MODERATO } });
    // Not a known asset, or a tx of another chain than the asset's.
    expect(
      planHandAnswer(several.state, several.order.key, {
        ...refund,
        asset: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:Gone',
        payoutAssets: TWO_PAYOUTS,
      }),
    ).toMatchObject({ ok: false });
    expect(
      planHandAnswer(several.state, several.order.key, {
        ...refund,
        asset: PATHUSD_MODERATO,
        payoutAssets: TWO_PAYOUTS,
      }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/Tempo/) });
    expect(
      planHandAnswer(several.state, several.order.key, {
        ...refund,
        tx: TEMPO_TX,
        asset: USDC_DEVNET_CAIP19,
        payoutAssets: TWO_PAYOUTS,
      }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/Solana/) });
  });

  it('re-sends a refund as kept: no default asset, and only a conflicting --asset is refused', () => {
    const refund = { kind: 'refunded' as const, tx: signatureOf(6), amount: '7' };
    const run = withOrder();
    const first = planHandAnswer(run.state, run.order.key, { ...refund, payoutAssets: ONE_PAYOUT });
    if (!first.ok) {
      throw new Error(first.problem);
    }
    applyHandAnswer(run.state, run.order.key, first.answer);
    // The payout rotated since, or there are several now: the kept answer goes again.
    for (const payoutAssets of [[PATHUSD_MODERATO], TWO_PAYOUTS]) {
      expect(planHandAnswer(run.state, run.order.key, { ...refund, payoutAssets })).toMatchObject({
        ok: true,
        rerun: true,
        answer: { caip19: USDC_DEVNET_CAIP19 },
      });
    }
    expect(
      planHandAnswer(run.state, run.order.key, {
        ...refund,
        asset: PATHUSD_MODERATO,
        payoutAssets: TWO_PAYOUTS,
      }),
    ).toMatchObject({ ok: false });
    // An answer kept by a node before 0.4.0 has no asset: it goes again unchanged.
    const old = withOrder();
    const oldFirst = planHandAnswer(old.state, old.order.key, {
      ...refund,
      payoutAssets: ONE_PAYOUT,
    });
    if (!oldFirst.ok) {
      throw new Error(oldFirst.problem);
    }
    const { caip19: _dropped, ...withoutAsset } = oldFirst.answer;
    applyHandAnswer(old.state, old.order.key, withoutAsset);
    const again = planHandAnswer(old.state, old.order.key, { ...refund, payoutAssets: ONE_PAYOUT });
    expect(again).toMatchObject({ ok: true, rerun: true });
    expect(again.ok && again.answer.caip19).toBe(undefined);
    expect(again.ok && again.warning).toBe(undefined);
    const explicit = planHandAnswer(old.state, old.order.key, {
      ...refund,
      asset: USDC_DEVNET_CAIP19,
      payoutAssets: ONE_PAYOUT,
    });
    expect(explicit).toMatchObject({
      ok: true,
      rerun: true,
      warning: expect.stringMatching(/without/),
    });
    expect(explicit.ok && explicit.answer.caip19).toBe(undefined);
  });

  it('answers a pruned order, and refuses an unknown key or a paid order', () => {
    const run = withOrder();
    pruneExpiredOrders(run.state, T0 + 10 * 86_400);
    expect(run.state.orders[run.order.key]).toBeUndefined();
    expect(
      planHandAnswer(run.state, run.order.key, { kind: 'delivered', delivery: DELIVERY }),
    ).toMatchObject({ ok: true });
    expect(
      planHandAnswer(run.state, `${'c'.repeat(64)}:${ORDER_ID}`, {
        kind: 'delivered',
        delivery: DELIVERY,
      }),
    ).toMatchObject({ ok: false });
    const paid = withOrder();
    paid.order.paid = {
      signature: signatureOf(4),
      amount: '1000000',
      blockTime: T0 + 90,
      caip19: 'x',
      medium: 'solana-devnet',
    };
    expect(
      planHandAnswer(paid.state, paid.order.key, { kind: 'delivered', delivery: DELIVERY }),
    ).toMatchObject({ ok: false });
  });
});
