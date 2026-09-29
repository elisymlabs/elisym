/**
 * The owner's hand answers: which orders may be answered, how the close is
 * kept, and that the signed status reads back as the widget reads it.
 */
import { unwrapOrderMessage } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import { applyHandAnswer, buildHandAnswer, planHandAnswer } from '../src/hand';
import { intake } from '../src/intake';
import { pruneExpiredOrders } from '../src/ledger';
import { T0, delivered, key, orderFrom, signatureOf, world } from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000d001';
const DELIVERY = { method: 'access' as const, value: 'https://shop.example/course' };
const TEMPO_TX = `0x${'ab'.repeat(32)}`;

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
      planHandAnswer(run.state, run.order.key, { kind: 'refunded', tx: TEMPO_TX, amount: '5' }),
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
      expect(planHandAnswer(run.state, run.order.key, { kind: 'refunded', ...bad })).toMatchObject({
        ok: false,
      });
    }
    const plan = planHandAnswer(run.state, run.order.key, {
      kind: 'refunded',
      tx: signatureOf(3),
      amount: '1000000',
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
      refund: { tx: signatureOf(3), amount: '1000000' },
    });
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
