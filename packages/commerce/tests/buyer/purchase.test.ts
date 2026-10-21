import { describe, expect, it } from 'vitest';
import type { PricedPayout } from '../../src/buyer/offer';
import type { OrderRecord } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import { cancelledUnpaid, endOrder, gone, onOtherTerms } from '../../src/buyer/purchase';
import { storedSolanaRequest } from '../../src/buyer/solana-pay';
import { EIP3009_USDC } from './fixtures';
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
    expect(onOtherTerms(record('same'), PAYOUT, undefined)).toBe(false);
    expect(onOtherTerms(record('dearer', { amount: '50000000' }), PAYOUT, undefined)).toBe(true);
    expect(
      onOtherTerms(
        record('moved', { payout: { caip19: 'solana:x/token:y', address: 'X' } }),
        PAYOUT,
        undefined,
      ),
    ).toBe(true);
    const cancelled = record('cancelled', {
      state: 'ordered',
      status: { status: 'cancelled' } as never,
    });
    expect(cancelledUnpaid(cancelled)).toBe(true);
    expect(onOtherTerms(cancelled, PAYOUT, undefined)).toBe(true);
    expect(cancelledUnpaid({ ...cancelled, paidTx: 'Sig' })).toBe(false);
    expect(cancelledUnpaid({ ...cancelled, state: 'paying' })).toBe(false);
  });

  it('knows an order placed for another account as on other terms', () => {
    const forA = record('a', { customerRef: 'user-a' });
    expect(onOtherTerms(forA, PAYOUT, 'user-a')).toBe(false);
    expect(onOtherTerms(forA, PAYOUT, 'user-b')).toBe(true);
    expect(onOtherTerms(forA, PAYOUT, undefined)).toBe(true);
    expect(onOtherTerms(record('none'), PAYOUT, 'user-a')).toBe(true);
    // A missing and an empty reference are the same account.
    expect(onOtherTerms(record('none'), PAYOUT, '')).toBe(false);
    expect(onOtherTerms(record('empty', { customerRef: '' }), PAYOUT, undefined)).toBe(false);
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

  it.each(EIP3009_USDC)(
    'ends a $chain.chainName order nothing was requested for with no endedBy, through no Tempo or Solana rule',
    async ({ caip19 }) => {
      const onEip3009 = { payout: { caip19, address: '0xabc' } };
      const store = await storeWith(record('ordered', onEip3009));
      await store.update('ordered', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
      const ordered = await store.get('ordered');
      if (ordered === undefined) {
        throw new Error('missing');
      }
      // Neither rail's ender is handed this record, whatever clients are given.
      const unusable = {
        request: () => {
          throw new Error('no rail may read for an eip3009 order');
        },
      };
      const ended = await endOrder(ordered, {
        ...DEPS_WITHOUT_RPC,
        store,
        rpc: {} as never,
        tempo: unusable,
      });
      expect(ended).toMatchObject({ ended: true, record: { state: 'ended-unpaid' } });
      expect(ended.record.endedBy).toBeUndefined();
    },
  );

  it.each(EIP3009_USDC)(
    'hands a $chain.chainName attempt to no Solana ender, however many clients are given',
    async ({ caip19 }) => {
      // Built by hand: PR 1's store refuses a marker on these payouts, PR 2 adds them.
      const attempt: OrderRecord = {
        ...record('attempt', { state: 'paying', payout: { caip19, address: '0xabc' } }),
        // A request a Solana watcher would accept, so only the rail keeps it out.
        paymentRequest: JSON.stringify({
          recipient: '11111111111111111111111111111111',
          amount: 1000,
          reference: 'SysvarRent111111111111111111111111111111111',
          created_at: 1_750_000_000,
          expiry_secs: 600,
        }),
        marker: solanaMarker('a'),
      };
      expect(storedSolanaRequest(attempt)).toBeDefined();
      const reads: PropertyKey[] = [];
      const untouchable = new Proxy(
        {},
        {
          get: (_target, key) => {
            reads.push(key);
            throw new Error('no rail may read for an eip3009 attempt');
          },
        },
      ) as never;
      expect(
        await endOrder(attempt, {
          readClient: untouchable,
          clientFor: () => untouchable,
          rpc: untouchable,
          store: await storeWith(),
        }),
      ).toEqual({ ended: false, record: attempt });
      expect(reads).toEqual([]);
    },
  );

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
