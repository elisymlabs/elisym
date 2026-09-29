import { describe, expect, it } from 'vitest';
import type { PricedPayout } from '../../src/buyer/offer';
import type { OrderRecord } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import { cancelledUnpaid, endOrder, gone, onOtherTerms } from '../../src/buyer/purchase';
import { ACKNOWLEDGED, record, solanaMarker } from './order-store.contract';

const PAYOUT = {
  target: { caip19: { id: 'solana:x/token:y' }, address: 'Payout' },
  amount: 49_000_000n,
} as unknown as PricedPayout;

async function storeWith(...records: OrderRecord[]): Promise<OrderStore> {
  const store = new OrderStore(new MemoryOrderBackend());
  for (const each of records) {
    await store.add({ ...each, state: 'created', version: 1 });
  }
  return store;
}

const DEPS_WITHOUT_RPC = {
  readClient: {} as never,
  clientFor: () => ({}) as never,
  rpc: undefined,
};

describe('a purchase deciding about its records', () => {
  it('knows an order on other terms, or one the store cancelled unpaid', () => {
    expect(onOtherTerms(record('same'), PAYOUT)).toBe(false);
    expect(onOtherTerms(record('dearer', { amount: '50000000' }), PAYOUT)).toBe(true);
    expect(
      onOtherTerms(
        record('moved', { payout: { caip19: 'solana:x/token:y', address: 'X' } }),
        PAYOUT,
      ),
    ).toBe(true);
    const cancelled = record('cancelled', {
      state: 'ordered',
      status: { status: 'cancelled' } as never,
    });
    expect(cancelledUnpaid(cancelled)).toBe(true);
    expect(onOtherTerms(cancelled, PAYOUT)).toBe(true);
    expect(cancelledUnpaid({ ...cancelled, paidTx: 'Sig' })).toBe(false);
    expect(cancelledUnpaid({ ...cancelled, state: 'paying' })).toBe(false);
  });

  it('knows an order that ended with no payment found', () => {
    expect(gone(record('ended', { state: 'ended-unpaid' }))).toBe(true);
    expect(gone(record('found', { state: 'ended-unpaid', paidTx: 'Sig' }))).toBe(false);
    expect(gone(record('open', { state: 'ordered' }))).toBe(false);
  });

  it('counts a never-acknowledged order as ended, and never moves it', async () => {
    const store = await storeWith(record('created'));
    const created = await store.get('created');
    if (created === undefined) {
      throw new Error('missing');
    }
    expect(await endOrder(created, { ...DEPS_WITHOUT_RPC, store })).toEqual({
      ended: true,
      record: created,
    });
    expect((await store.get('created'))?.state).toBe('created');
  });

  it('ends an acknowledged order with no attempt with no RPC at all', async () => {
    const store = await storeWith(record('ordered'));
    await store.update('ordered', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const ordered = await store.get('ordered');
    if (ordered === undefined) {
      throw new Error('missing');
    }
    expect(await endOrder(ordered, { ...DEPS_WITHOUT_RPC, store })).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid' },
    });
  });

  it('never ends an attempt without an RPC for its network', async () => {
    const store = await storeWith(record('paying'));
    await store.update('paying', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    await store.setMarker('paying', 2, solanaMarker('a'));
    const paying = await store.get('paying');
    if (paying === undefined) {
      throw new Error('missing');
    }
    expect(await endOrder(paying, { ...DEPS_WITHOUT_RPC, store })).toMatchObject({ ended: false });
    expect((await store.get('paying'))?.state).toBe('paying');
  });

  it('ends a Tempo order nothing was requested for as such, and never a Tempo attempt through a Solana RPC', async () => {
    const tempo = {
      payout: {
        caip19: 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50',
        address: '0xabc',
      },
    };
    const store = await storeWith(record('ordered', tempo));
    await store.update('ordered', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const ordered = await store.get('ordered');
    if (ordered === undefined) {
      throw new Error('missing');
    }
    expect(await endOrder(ordered, { ...DEPS_WITHOUT_RPC, store })).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid', endedBy: 'nothing' },
    });
    await store.add(record('paying', { ...tempo, productAddress: 'other-product' }));
    await store.update('paying', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    await store.setMarker('paying', 2, {
      rail: 'tempo',
      attemptId: 'a',
      setAt: 1,
      floorBlock: '1',
    });
    const paying = await store.get('paying');
    if (paying === undefined) {
      throw new Error('missing');
    }
    // A Solana RPC can prove nothing about a Tempo attempt.
    expect(await endOrder(paying, { ...DEPS_WITHOUT_RPC, store, rpc: {} as never })).toMatchObject({
      ended: false,
    });
    expect((await store.get('paying'))?.state).toBe('paying');
  });
});
