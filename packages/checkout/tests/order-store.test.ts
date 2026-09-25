import type { VerifiedOffer } from '@elisym/commerce';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type OrderRecord,
  type OrderState,
  type PaymentMarker,
  holdsPayExclusion,
  recordToShow,
} from '../src/core/order-record';
import { OrderStore, openOrderDatabase } from '../src/core/order-store';

type TempoMarker = Extract<PaymentMarker, { rail: 'tempo' }>;

/** What `created -> ordered` needs: the signed order, acknowledged by the store's inbox. */
const ACKNOWLEDGED = {
  orderWrap: { id: 'order-wrap' } as OrderRecord['orderWrap'],
  acknowledgedRelays: ['wss://inbox.example.com'],
};

const PRODUCT = `30402:${'a'.repeat(64)}:course-101`;
const OTHER_PRODUCT = `30402:${'a'.repeat(64)}:course-202`;
/** A Tempo payout: only a Tempo payment can end `blocked`. */
const TEMPO_PAYOUT = {
  payout: {
    caip19: 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50',
    address: '0xabc',
  },
};

function record(orderId: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId,
    productAddress: PRODUCT,
    storePubkey: 'a'.repeat(64),
    buyerSecretKey: 'b'.repeat(64),
    buyerPubkey: 'c'.repeat(64),
    createdAt: 1_750_000_000,
    version: 1,
    state: 'created',
    payout: { caip19: 'solana:x/token:y', address: 'Payout' },
    amount: '49000000',
    medium: 'solana-devnet',
    reference: 'Reference',
    offer: {} as VerifiedOffer,
    inboxRelays: ['wss://inbox.example.com'],
    acknowledgedRelays: [],
    ...overrides,
  };
}

function solanaMarker(attemptId: string): Extract<PaymentMarker, { rail: 'solana' }> {
  return {
    rail: 'solana',
    attemptId,
    setAt: 1_750_000_100,
    blockhash: 'Blockhash',
    lastValidBlockHeight: '1000',
  };
}

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(await openOrderDatabase(new IDBFactory()));
});

/** Add an order and bring it to `ordered` with its composed request: version 2. */
async function addOrdered(orderId: string, overrides: Partial<OrderRecord> = {}): Promise<void> {
  await store.add(record(orderId, overrides));
  const ordered = await store.update(orderId, 1, {
    state: 'ordered',
    paymentRequest: '{}',
    ...ACKNOWLEDGED,
  });
  if (!ordered.ok) {
    throw new Error(ordered.reason);
  }
}

/** An `ordered` record that now holds the marker `attemptId`: version 3. */
async function addPaying(orderId: string, attemptId: string): Promise<void> {
  await addOrdered(orderId);
  const set = await store.setMarker(orderId, 2, solanaMarker(attemptId));
  if (!set.ok) {
    throw new Error(set.reason);
  }
}

describe('OrderStore records', () => {
  it('finds records by product address, oldest first', async () => {
    await store.add(record('late', { createdAt: 20 }));
    await store.add(record('early', { createdAt: 10 }));
    await store.add(record('elsewhere', { productAddress: OTHER_PRODUCT }));
    expect((await store.forProduct(PRODUCT)).map((entry) => entry.orderId)).toEqual([
      'early',
      'late',
    ]);
    await expect(store.add(record('early'))).rejects.toBeDefined();
  });

  it('adds only a fresh order, never one that claims a later state or a marker', async () => {
    await expect(store.add(record('paying', { state: 'paying' }))).rejects.toThrow(/created/);
    await expect(store.add(record('marked', { marker: solanaMarker('m') }))).rejects.toThrow(
      /created/,
    );
    await expect(store.add(record('late', { version: 5 }))).rejects.toThrow(/created/);
    expect(await store.get('paying')).toBeUndefined();
  });

  it('updates only the version the caller judged', async () => {
    await store.add(record('one'));
    expect(await store.update('one', 0, { state: 'ordered' })).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(await store.update('missing', 1, {})).toMatchObject({ ok: false, reason: 'missing' });
    const updated = await store.update('one', 1, { acknowledgedRelays: ['wss://a.example.com'] });
    expect(updated).toMatchObject({ ok: true, record: { version: 2 } });
    expect((await store.get('one'))?.version).toBe(2);
  });

  it('moves a record only forward, and never out of a terminal state', async () => {
    const refused: [OrderState, OrderState][] = [
      ['created', 'paid'],
      ['created', 'paying'],
      ['ordered', 'paying'],
      ['ordered', 'created'],
      ['ended-unpaid', 'ordered'],
      ['blocked', 'ordered'],
      ['paid', 'ordered'],
      ['paid', 'ended-unpaid'],
      ['completed', 'ordered'],
      ['refunded', 'paid'],
    ];
    for (const [from, to] of refused) {
      const id = `${from}-${to}`;
      await store.add(record(id, from === 'blocked' ? TEMPO_PAYOUT : {}));
      await store.update(id, 1, { state: 'ordered', ...ACKNOWLEDGED });
      if (from !== 'created' && from !== 'ordered') {
        if (from === 'blocked') {
          await store.update(id, 2, { state: 'ended-unpaid' });
          await store.update(id, 3, { state: 'blocked' });
        } else {
          await store.update(id, 2, { state: from });
        }
      }
      if (from === 'created') {
        await store.add(record(`${id}-fresh`));
        expect(await store.update(`${id}-fresh`, 1, { state: to })).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
        continue;
      }
      const current = await store.get(id);
      expect(current?.state).toBe(from);
      expect(await store.update(id, current?.version ?? 0, { state: to })).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    }
  });

  it('ignores a key set to undefined rather than wiping the field', async () => {
    await store.add(record('one'));
    const wrap = { id: 'w' } as OrderRecord['orderWrap'];
    await store.update('one', 1, {
      state: 'ordered',
      paymentRequest: '{}',
      orderWrap: wrap,
      acknowledgedRelays: ['wss://inbox.example.com'],
    });
    const written = await store.update('one', 2, {
      state: undefined,
      paymentRequest: undefined,
      orderWrap: undefined,
    });
    expect(written).toMatchObject({
      ok: true,
      record: { state: 'ordered', paymentRequest: '{}', orderWrap: wrap },
    });
  });

  it('changes only the patchable fields, whatever else a spread record carries', async () => {
    await addOrdered('one');
    // A wider object than the patch type: TypeScript does not stop extra keys here.
    const smuggled = {
      amount: '1',
      payout: { caip19: 'solana:x/token:y', address: 'Evil' },
      marker: solanaMarker('smuggled'),
      version: 99,
      state: 'paid' as const,
      paidTx: 'Tx',
    };
    const written = await store.update('one', 2, smuggled);
    expect(written).toMatchObject({ ok: true, record: { paidTx: 'Tx', amount: '49000000' } });
    const stored = await store.get('one');
    expect(stored?.payout.address).toBe('Payout');
    expect(stored?.marker).toBeUndefined();
  });

  it('never changes a terminal record at all', async () => {
    await addOrdered('done');
    await store.update('done', 2, { state: 'completed' });
    expect(await store.update('done', 3, { paidTx: 'Other' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('counts an order as acknowledged only with its signed wrap and an acknowledging relay', async () => {
    await store.add(record('unsigned'));
    expect(
      await store.update('unsigned', 1, {
        state: 'ordered',
        acknowledgedRelays: ['wss://inbox.example.com'],
      }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(
      await store.update('unsigned', 1, { state: 'ordered', orderWrap: ACKNOWLEDGED.orderWrap }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await store.update('unsigned', 1, { state: 'ordered', ...ACKNOWLEDGED })).toMatchObject({
      ok: true,
    });
  });

  it('needs two acknowledging inbox relays when the store lists two or more', async () => {
    const inboxRelays = ['wss://a.example.com', 'wss://b.example.com', 'wss://c.example.com'];
    await store.add(record('two', { inboxRelays }));
    const orderWrap = ACKNOWLEDGED.orderWrap;
    for (const acknowledgedRelays of [
      ['wss://a.example.com'],
      ['wss://a.example.com', 'wss://a.example.com'],
      ['wss://a.example.com', 'wss://elsewhere.example.com'],
    ]) {
      expect(
        await store.update('two', 1, { state: 'ordered', orderWrap, acknowledgedRelays }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
    }
    expect(
      await store.update('two', 1, {
        state: 'ordered',
        orderWrap,
        acknowledgedRelays: ['wss://c.example.com', 'wss://a.example.com'],
      }),
    ).toMatchObject({ ok: true });
    await store.add(record('none', { inboxRelays: [] }));
    expect(
      await store.update('none', 1, { state: 'ordered', orderWrap, acknowledgedRelays: [] }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
  });

  it('counts acknowledgements against the inbox list written with them', async () => {
    await store.add(record('moved', { inboxRelays: ['wss://old.example.com'] }));
    expect(
      await store.update('moved', 1, {
        state: 'ordered',
        orderWrap: ACKNOWLEDGED.orderWrap,
        inboxRelays: ['wss://a.example.com', 'wss://b.example.com'],
        acknowledgedRelays: ['wss://old.example.com', 'wss://a.example.com'],
      }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(
      await store.update('moved', 1, {
        state: 'ordered',
        orderWrap: ACKNOWLEDGED.orderWrap,
        inboxRelays: ['wss://a.example.com', 'wss://b.example.com'],
        acknowledgedRelays: ['wss://a.example.com', 'wss://b.example.com'],
      }),
    ).toMatchObject({ ok: true });
  });

  it('writes the payment request once, and the order wrap once', async () => {
    await store.add(record('one'));
    expect(await store.update('one', 1, { paymentRequest: '{}' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await store.update('one', 1, { state: 'ordered', paymentRequest: '{"a":1}', ...ACKNOWLEDGED });
    expect(await store.update('one', 2, { paymentRequest: '{"b":2}' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(
      await store.update('one', 2, { orderWrap: { id: 'x' } as OrderRecord['orderWrap'] }),
    ).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect((await store.get('one'))?.paymentRequest).toBe('{"a":1}');
  });
});

describe('the payment marker', () => {
  it('is set only on an acknowledged record with its request, and moves it to paying', async () => {
    await store.add(record('created'));
    expect(await store.setMarker('created', 1, solanaMarker('m1'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await store.add(record('bare', { productAddress: OTHER_PRODUCT }));
    await store.update('bare', 1, { state: 'ordered', ...ACKNOWLEDGED });
    expect(await store.setMarker('bare', 2, solanaMarker('m1'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await addOrdered('ready', { productAddress: 'p3' });
    expect(await store.setMarker('ready', 1, solanaMarker('m1'))).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    const set = await store.setMarker('ready', 2, solanaMarker('m1'));
    expect(set).toMatchObject({ ok: true, record: { state: 'paying', version: 3 } });
    expect(await store.setMarker('ready', 3, solanaMarker('m2'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('never pays an order again once it ended, was paid or was blocked', async () => {
    for (const state of ['ended-unpaid', 'paid', 'blocked'] as const) {
      const id = `order-${state}`;
      await addOrdered(id, {
        productAddress: `p-${state}`,
        ...(state === 'blocked' ? TEMPO_PAYOUT : {}),
      });
      if (state === 'blocked') {
        await store.update(id, 2, { state: 'ended-unpaid' });
        await store.update(id, 3, { state: 'blocked' });
      } else {
        await store.update(id, 2, { state });
      }
      const current = await store.get(id);
      expect(current?.marker).toBeUndefined();
      expect(await store.setMarker(id, current?.version ?? 0, solanaMarker('x'))).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    }
  });

  it('lets only one order of a product pay at a time, even from two tabs at once', async () => {
    await addOrdered('first');
    await addOrdered('second');
    const outcomes = await Promise.all([
      store.setMarker('first', 2, solanaMarker('a')),
      store.setMarker('second', 2, solanaMarker('b')),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
      ok: false,
      reason: 'exclusion',
    });
    await addOrdered('elsewhere', { productAddress: OTHER_PRODUCT });
    expect(await store.setMarker('elsewhere', 2, solanaMarker('c'))).toMatchObject({ ok: true });
  });

  it('keeps the exclusion while a found payment waits, and releases it on a delivery', async () => {
    await addOrdered('paid');
    await store.update('paid', 2, { state: 'paid' });
    await addOrdered('next');
    expect(await store.setMarker('next', 2, solanaMarker('n'))).toMatchObject({
      ok: false,
      reason: 'exclusion',
      holder: 'paid',
    });
    await store.update('paid', 3, { state: 'completed' });
    expect(await store.setMarker('next', 2, solanaMarker('n'))).toMatchObject({ ok: true });
  });

  it('changes or clears a marker only for its own attempt at the judged version', async () => {
    await addPaying('one', 'mine');
    expect(
      await store.updateMarker('one', 3, 'stale', { ...solanaMarker('stale'), signature: 'Sig' }),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      await store.updateMarker('one', 3, 'mine', {
        rail: 'tempo',
        attemptId: 'mine',
        setAt: 1,
        floorBlock: '1',
      }),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      await store.updateMarker('one', 3, 'mine', { ...solanaMarker('mine'), signature: 'Sig' }),
    ).toMatchObject({ ok: true, record: { version: 4, marker: { signature: 'Sig' } } });
    expect(await store.clearMarker('one', 4, 'stale', 'ordered')).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(await store.update('one', 4, { state: 'ordered' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(await store.update('one', 4, { state: 'ended-unpaid' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('never overruns a signature recorded after the caller read the record', async () => {
    await addPaying('one', 'mine');
    // Tab 2 read the record at version 3 (no signature); tab 1 then records the signature.
    await store.updateMarker('one', 3, 'mine', { ...solanaMarker('mine'), signature: 'Sig' });
    expect(await store.clearMarker('one', 3, 'mine', 'ended-unpaid')).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(await store.updateMarker('one', 3, 'mine', solanaMarker('mine'))).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    await addOrdered('second');
    expect(await store.setMarker('second', 2, solanaMarker('b'))).toMatchObject({
      ok: false,
      reason: 'exclusion',
    });
    expect((await store.get('one'))?.marker).toMatchObject({ signature: 'Sig' });
  });

  it('never reopens an attempt whose marker proves a request, nor drops that proof', async () => {
    await addPaying('one', 'mine');
    await store.updateMarker('one', 3, 'mine', { ...solanaMarker('mine'), signature: 'Sig' });
    expect(await store.clearMarker('one', 4, 'mine', 'ordered')).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(await store.updateMarker('one', 4, 'mine', solanaMarker('mine'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(
      await store.updateMarker('one', 4, 'mine', { ...solanaMarker('mine'), signature: 'Other' }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    // A Solana retry (after its checks) replaces the expired attempt.
    expect(await store.updateMarker('one', 4, 'mine', solanaMarker('retry'))).toMatchObject({
      ok: true,
      record: { marker: { attemptId: 'retry' } },
    });
  });

  it('keeps a Tempo attempt as it is: no retry, the floor fixed, the hash only added', async () => {
    await store.add(record('tempo', TEMPO_PAYOUT));
    await store.update('tempo', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const tempo = { rail: 'tempo' as const, attemptId: 't', setAt: 1, floorBlock: '100' };
    await store.setMarker('tempo', 2, tempo);
    expect(await store.updateMarker('tempo', 3, 't', { ...tempo, attemptId: 't2' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(
      await store.updateMarker('tempo', 3, 't', { ...tempo, floorBlock: '200' }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await store.updateMarker('tempo', 3, 't', { ...tempo, txHash: '0xhash' })).toMatchObject(
      { ok: true },
    );
    expect(await store.updateMarker('tempo', 4, 't', tempo)).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(await store.update('tempo', 4, { state: 'blocked' })).toMatchObject({ ok: true });
  });

  it('refuses a retry while another order of the product holds the exclusion', async () => {
    await addPaying('retrying', 'first');
    // Another order of the product was found paid late, meanwhile.
    await addOrdered('late');
    await store.update('late', 2, { state: 'paid' });
    expect(await store.updateMarker('retrying', 3, 'first', solanaMarker('second'))).toMatchObject({
      ok: false,
      reason: 'exclusion',
      holder: 'late',
    });
    expect((await store.get('retrying'))?.marker?.attemptId).toBe('first');
  });

  it("fixes a Solana attempt's blockhash and last valid height", async () => {
    await addPaying('one', 'mine');
    for (const moved of [
      { ...solanaMarker('mine'), blockhash: 'Other' },
      { ...solanaMarker('mine'), lastValidBlockHeight: '5' },
    ]) {
      expect(await store.updateMarker('one', 3, 'mine', moved)).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    }
  });

  it("sets only a marker of the payout's own rail", async () => {
    await store.add(record('tempo', TEMPO_PAYOUT));
    await store.update('tempo', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    expect(await store.setMarker('tempo', 2, solanaMarker('s'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await addOrdered('solana', { productAddress: OTHER_PRODUCT });
    const tempo: TempoMarker = { rail: 'tempo', attemptId: 't', setAt: 1, floorBlock: '1' };
    expect(await store.setMarker('solana', 2, tempo)).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('never ends an approved Tempo bundle unpaid', async () => {
    await store.add(record('tempo', TEMPO_PAYOUT));
    await store.update('tempo', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const tempo: TempoMarker = { rail: 'tempo', attemptId: 't', setAt: 1, floorBlock: '1' };
    await store.setMarker('tempo', 2, tempo);
    await store.updateMarker('tempo', 3, 't', { ...tempo, bundleId: 'bundle' });
    expect(await store.clearMarker('tempo', 4, 't', 'ended-unpaid')).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('keeps the transaction that paid, and the receipt once the payment is found', async () => {
    await addPaying('one', 'mine');
    const receipt = (id: string) => ({ id }) as OrderRecord['receiptWrap'];
    await store.update('one', 3, { receiptWrap: receipt('first') });
    // A Solana retry sends a new receipt for its own transaction while still paying.
    expect(await store.update('one', 4, { receiptWrap: receipt('retry') })).toMatchObject({
      ok: true,
    });
    await store.update('one', 5, { state: 'paid', paidTx: 'Sig' });
    expect(await store.update('one', 6, { paidTx: 'Other' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(await store.update('one', 6, { receiptWrap: receipt('late') })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    const stored = await store.get('one');
    expect(stored?.paidTx).toBe('Sig');
    expect(stored?.receiptWrap).toEqual(receipt('retry'));
  });

  it('records a found payment only with a paid state, and never leaves it open to pay', async () => {
    await addOrdered('ordered');
    expect(await store.update('ordered', 2, { paidTx: 'Sig' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await addPaying('paying', 'mine');
    expect(await store.update('paying', 3, { paidTx: 'Sig' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(await store.update('paying', 3, { state: 'paid', paidTx: 'Sig' })).toMatchObject({
      ok: true,
    });
    // Found late on an ended order: it holds the product again until the store answers.
    expect(holdsPayExclusion({ state: 'ended-unpaid', paidTx: 'Sig' })).toBe(true);
    expect(holdsPayExclusion({ state: 'blocked', paidTx: 'Sig' })).toBe(true);
    expect(holdsPayExclusion({ state: 'completed', paidTx: 'Sig' })).toBe(false);
  });

  it("keeps an ended or blocked record's receipt as it was sent", async () => {
    const receipt = (id: string) => ({ id }) as OrderRecord['receiptWrap'];
    await addPaying('ended', 'e');
    await store.updateMarker('ended', 3, 'e', { ...solanaMarker('e'), signature: 'Sig' });
    await store.update('ended', 4, { receiptWrap: receipt('first') });
    await store.clearMarker('ended', 5, 'e', 'ended-unpaid');
    expect(await store.update('ended', 6, { receiptWrap: receipt('other') })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });

    await store.add(record('tempo', { ...TEMPO_PAYOUT, productAddress: OTHER_PRODUCT }));
    await store.update('tempo', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const tempo: TempoMarker = { rail: 'tempo', attemptId: 't', setAt: 1, floorBlock: '1' };
    await store.setMarker('tempo', 2, tempo);
    await store.update('tempo', 3, { receiptWrap: receipt('first') });
    await store.update('tempo', 4, { state: 'blocked' });
    expect(await store.update('tempo', 5, { receiptWrap: receipt('other') })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('never opens a wallet for an order the store cancelled', async () => {
    await addOrdered('cancelled');
    await store.update('cancelled', 2, { status: { status: 'cancelled', at: 1 } });
    expect(await store.setMarker('cancelled', 3, solanaMarker('m'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await addPaying('retrying', 'first');
    await store.update('retrying', 3, { status: { status: 'cancelled', at: 1 } });
    expect(await store.updateMarker('retrying', 4, 'first', solanaMarker('second'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    // What the buyer already signed is still recorded on a cancelled order.
    expect(
      await store.updateMarker('retrying', 4, 'first', {
        ...solanaMarker('first'),
        signature: 'S',
      }),
    ).toMatchObject({ ok: true });
    // A stale `pending` never reopens it.
    expect(
      await store.update('cancelled', 3, { status: { status: 'pending', at: 2 } }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await store.setMarker('cancelled', 3, solanaMarker('m'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it("moves a store's answer only forward", async () => {
    await addOrdered('one');
    await store.update('one', 2, { status: { status: 'confirmed', at: 1 } });
    expect(await store.update('one', 3, { status: { status: 'pending', at: 2 } })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    await store.update('one', 3, { status: { status: 'completed', at: 3 } });
    for (const status of ['pending', 'confirmed', 'cancelled'] as const) {
      expect(await store.update('one', 4, { status: { status, at: 4 } })).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    }
    // A delivery after a cancellation (the store recovered the funds) is kept.
    await addOrdered('late', { productAddress: OTHER_PRODUCT });
    await store.update('late', 2, { status: { status: 'cancelled', at: 1 } });
    expect(await store.update('late', 3, { status: { status: 'completed', at: 2 } })).toMatchObject(
      { ok: true },
    );
  });

  it('follows the status table exactly, for every pair', async () => {
    type Status = NonNullable<OrderRecord['status']>['status'];
    const table: Record<Status, Status[]> = {
      pending: ['pending', 'confirmed', 'completed', 'cancelled'],
      confirmed: ['confirmed', 'completed', 'cancelled'],
      cancelled: ['cancelled', 'completed'],
      completed: ['completed'],
    };
    const statuses: Status[] = ['pending', 'confirmed', 'cancelled', 'completed'];
    for (const from of statuses) {
      for (const to of statuses) {
        const id = `status-${from}-${to}`;
        await addOrdered(id, { productAddress: id });
        await store.update(id, 2, { status: { status: from, at: 1 } });
        const outcome = await store.update(id, 3, { status: { status: to, at: 2 } });
        expect({ from, to, ok: outcome.ok }).toEqual({ from, to, ok: table[from].includes(to) });
      }
    }
  });

  it('never retries an order the store delivered, and keeps the first signature', async () => {
    await addPaying('one', 'a1');
    await store.updateMarker('one', 3, 'a1', { ...solanaMarker('a1'), signature: 'S1' });
    await store.update('one', 4, { status: { status: 'completed', at: 1 } });
    expect(
      await store.updateMarker('one', 5, 'a1', { ...solanaMarker('a2'), blockhash: 'B2' }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect((await store.get('one'))?.marker).toMatchObject({ attemptId: 'a1', signature: 'S1' });
  });

  it('keeps a refund once seen, and never opens a wallet after a delivery', async () => {
    await addOrdered('refunded');
    await store.update('refunded', 2, { status: { status: 'cancelled', at: 1, refunded: true } });
    expect(
      await store.update('refunded', 3, { status: { status: 'cancelled', at: 2 } }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    await addOrdered('delivered', { productAddress: OTHER_PRODUCT });
    await store.update('delivered', 2, { status: { status: 'completed', at: 1 } });
    expect(await store.setMarker('delivered', 3, solanaMarker('m'))).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('never ends a Solana payment blocked', async () => {
    await addPaying('one', 'mine');
    expect(await store.update('one', 3, { state: 'blocked' })).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('never clears a marker over a payment found in between', async () => {
    await addPaying('one', 'mine');
    await store.update('one', 3, { state: 'paid', paidTx: 'Sig' });
    expect(await store.clearMarker('one', 4, 'mine', 'ended-unpaid')).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(
      await store.updateMarker('one', 4, 'mine', { ...solanaMarker('mine'), signature: 'X' }),
    ).toMatchObject({ ok: false, reason: 'not_ready' });
    expect((await store.get('one'))?.state).toBe('paid');
  });

  it('removes the marker when nothing was requested, and keeps it on an ended attempt', async () => {
    await addPaying('unsent', 'u');
    const reopened = await store.clearMarker('unsent', 3, 'u', 'ordered');
    expect(reopened).toMatchObject({ ok: true, record: { state: 'ordered' } });
    expect(reopened.ok && reopened.record.marker).toBeUndefined();

    await addPaying('ended', 'e');
    await store.updateMarker('ended', 3, 'e', { ...solanaMarker('e'), signature: 'Sig' });
    const ended = await store.clearMarker('ended', 4, 'e', 'ended-unpaid');
    expect(ended).toMatchObject({
      ok: true,
      record: { state: 'ended-unpaid', marker: { signature: 'Sig' } },
    });
    // Kept for reconciliation, but no longer excluding a new order.
    await addOrdered('fresh');
    expect(await store.setMarker('fresh', 2, solanaMarker('f'))).toMatchObject({ ok: true });
  });
});

describe('opening the database', () => {
  it('refuses, rather than throws, where there is no IndexedDB at all', async () => {
    const opening = openOrderDatabase();
    expect(opening).toBeInstanceOf(Promise);
    await expect(opening).rejects.toBeDefined();
  });
});

describe('a write that does not commit', () => {
  /** A database whose readwrite transactions abort right after a put succeeds (quota, a closing database). */
  function abortingAfterPut(database: IDBDatabase): IDBDatabase {
    return new Proxy(database, {
      get(target, property) {
        if (property !== 'transaction') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...parameters: Parameters<IDBDatabase['transaction']>) => {
          const transaction = target.transaction(...parameters);
          const objectStore = transaction.objectStore.bind(transaction);
          transaction.objectStore = (name: string) => {
            const objects = objectStore(name);
            const put = objects.put.bind(objects);
            objects.put = (...values: Parameters<IDBObjectStore['put']>) => {
              const request = put(...values);
              request.addEventListener('success', () => transaction.abort());
              return request;
            };
            return objects;
          };
          return transaction;
        };
      },
    });
  }

  it('is never reported as done', async () => {
    const database = await openOrderDatabase(new IDBFactory());
    const healthy = new OrderStore(database);
    await healthy.add(record('one'));
    await healthy.update('one', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    const failing = new OrderStore(abortingAfterPut(database));
    await expect(failing.setMarker('one', 2, solanaMarker('m'))).rejects.toBeDefined();
    const stored = await healthy.get('one');
    expect(stored?.state).toBe('ordered');
    expect(stored?.marker).toBeUndefined();
  });
});

describe('store pins', () => {
  it('pins the owner and keeps the union of delivered payouts', async () => {
    const first = [{ caip19: 'solana:x/token:y', address: 'A' }];
    const second = [{ caip19: 'eip155:1/erc20:z', address: 'B' }];
    await store.rememberDelivery('s'.repeat(64), 'o'.repeat(64), first);
    const pins = await store.rememberDelivery('s'.repeat(64), 'o'.repeat(64), [
      ...second,
      ...first,
    ]);
    expect(pins.knownPayouts).toEqual([...first, ...second]);
    const unchanged = await store.rememberDelivery('s'.repeat(64), 'x'.repeat(64), [
      { caip19: 'solana:x/token:y', address: 'C' },
    ]);
    expect(unchanged).toEqual(pins);
    expect(await store.pins('s'.repeat(64))).toEqual(pins);
  });
});

describe('record rules', () => {
  it('holds the exclusion for a live marker or a found payment only', () => {
    const marker = solanaMarker('m');
    expect(holdsPayExclusion({ state: 'paying', marker })).toBe(true);
    expect(holdsPayExclusion({ state: 'paid' })).toBe(true);
    expect(holdsPayExclusion({ state: 'ordered' })).toBe(false);
    expect(holdsPayExclusion({ state: 'ended-unpaid', marker })).toBe(false);
    expect(holdsPayExclusion({ state: 'blocked', marker })).toBe(false);
    expect(holdsPayExclusion({ state: 'completed', marker })).toBe(false);
    expect(holdsPayExclusion({ state: 'refunded' })).toBe(false);
  });

  it('shows a record with an outcome ahead of a newer unpaid one', () => {
    const paid = record('paid', { state: 'paid', createdAt: 10 });
    const newer = record('newer', { state: 'ordered', createdAt: 20 });
    const ended = record('ended', { state: 'ended-unpaid', createdAt: 5 });
    expect(recordToShow([newer, paid, ended])?.orderId).toBe('paid');
    expect(recordToShow([ended, newer])?.orderId).toBe('newer');
    const cancelled = record('cancelled', {
      state: 'paying',
      createdAt: 1,
      status: { status: 'cancelled', at: 2 },
    });
    expect(recordToShow([newer, cancelled])?.orderId).toBe('cancelled');
    // Same time: the lower order id, whichever order they come in.
    const twinA = record('a-twin', { createdAt: 30 });
    const twinB = record('b-twin', { createdAt: 30 });
    expect(recordToShow([twinB, twinA])?.orderId).toBe('a-twin');
    expect(recordToShow([twinA, twinB])?.orderId).toBe('a-twin');
    expect(recordToShow([])).toBeUndefined();
  });
});
