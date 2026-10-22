import type { VerifiedOffer } from '@elisym/commerce';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type OrderRecord,
  type OrderState,
  type PaymentMarker,
  holdsPayExclusion,
  recordToShow,
} from '../../src/buyer/order-record';
import { type OrderBackend, OrderStore } from '../../src/buyer/order-store';
import { EIP3009_USDC, nostrKey, sign } from './fixtures';

/** A genuine signed event standing in for an order's gift wrap. */
function signedWrap(label: string): NonNullable<OrderRecord['orderWrap']> {
  return sign({ kind: 1059, created_at: 1_750_000_000, tags: [], content: label }, nostrKey());
}

type TempoMarker = Extract<PaymentMarker, { rail: 'tempo' }>;
type Eip3009Marker = Extract<PaymentMarker, { rail: 'eip3009' }>;

/** What `created -> ordered` needs: the signed order, acknowledged by the store's inbox. */
export const ACKNOWLEDGED = {
  orderWrap: signedWrap('order-wrap'),
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

export function record(orderId: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
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

export function solanaMarker(attemptId: string): Extract<PaymentMarker, { rail: 'solana' }> {
  return {
    rail: 'solana',
    attemptId,
    setAt: 1_750_000_100,
    blockhash: 'Blockhash',
    lastValidBlockHeight: '1000',
    slot: '900',
  };
}

let store: OrderStore;

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

/**
 * The order store's contract: every rule the buyer core relies on, run against
 * a backend. Each backend (memory here, IndexedDB in the checkout, the MCP's
 * file) runs this same suite.
 */
export function orderStoreContract(makeBackend: () => Promise<OrderBackend>): void {
  beforeEach(async () => {
    store = new OrderStore(await makeBackend());
  });

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
            await store.update(id, 2, { state: 'ended-unpaid', endedBy: 'nothing' });
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
      const wrap = signedWrap('w');
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

    it('refuses a forged order wrap, and counts two URLs of one relay server once', async () => {
      const forged = { ...signedWrap('real'), content: 'tampered' };
      await store.add(record('forged'));
      expect(
        await store.update('forged', 1, {
          state: 'ordered',
          orderWrap: forged,
          acknowledgedRelays: ['wss://inbox.example.com'],
        }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      const inboxRelays = [
        'wss://r.example.com',
        'wss://r.example.com/inbox',
        'wss://s.example.com',
      ];
      await store.add(record('hosts', { inboxRelays }));
      expect(
        await store.update('hosts', 1, {
          state: 'ordered',
          orderWrap: signedWrap('o'),
          acknowledgedRelays: ['wss://r.example.com', 'wss://r.example.com/inbox'],
        }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      expect(
        await store.update('hosts', 1, {
          state: 'ordered',
          orderWrap: signedWrap('o'),
          acknowledgedRelays: ['wss://r.example.com', 'wss://s.example.com'],
        }),
      ).toMatchObject({ ok: true });
      // A store listing one server twice needs just that one.
      await store.add(record('one-server', { inboxRelays: inboxRelays.slice(0, 2) }));
      expect(
        await store.update('one-server', 1, {
          state: 'ordered',
          orderWrap: signedWrap('o'),
          acknowledgedRelays: ['wss://r.example.com/inbox'],
        }),
      ).toMatchObject({ ok: true });
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
      expect(
        await store.update('unsigned', 1, { state: 'ordered', ...ACKNOWLEDGED }),
      ).toMatchObject({
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
      await store.update('one', 1, {
        state: 'ordered',
        paymentRequest: '{"a":1}',
        ...ACKNOWLEDGED,
      });
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
      expect(
        await store.updateMarker('tempo', 3, 't', { ...tempo, attemptId: 't2' }),
      ).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(
        await store.updateMarker('tempo', 3, 't', { ...tempo, floorBlock: '200' }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      expect(
        await store.updateMarker('tempo', 3, 't', { ...tempo, txHash: '0xhash' }),
      ).toMatchObject({ ok: true });
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
      expect(
        await store.updateMarker('retrying', 3, 'first', solanaMarker('second')),
      ).toMatchObject({
        ok: false,
        reason: 'exclusion',
        holder: 'late',
      });
      expect((await store.get('retrying'))?.marker?.attemptId).toBe('first');
    });

    it("fixes a Solana attempt's blockhash, last valid height and slot", async () => {
      await addPaying('one', 'mine');
      const { slot: _dropped, ...withoutSlot } = solanaMarker('mine');
      for (const moved of [
        { ...solanaMarker('mine'), blockhash: 'Other' },
        { ...solanaMarker('mine'), lastValidBlockHeight: '5' },
        { ...solanaMarker('mine'), slot: '901' },
        withoutSlot,
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

    // Settlement gating: an `eip3009` payout is EVM, but neither Tempo's nor
    // Solana's - no marker of either rail, no `blocked`, no `endedBy`.
    // Every eip3009 USDC (three chains, mainnet and devnet): a gate narrowed to one
    // chain must fail here.
    it.each(EIP3009_USDC)(
      'sets no marker, no blocked state and no endedBy on a $chain.chainName payout',
      async ({ caip19 }) => {
        const id = 'eip3009';
        await store.add(record(id, { payout: { caip19, address: '0xabc' } }));
        await store.update(id, 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
        const tempo: TempoMarker = { rail: 'tempo', attemptId: 't', setAt: 1, floorBlock: '1' };
        for (const marker of [solanaMarker('s'), tempo]) {
          expect(await store.setMarker(id, 2, marker)).toMatchObject({
            ok: false,
            reason: 'not_ready',
          });
        }
        expect(await store.update(id, 2, { state: 'blocked' })).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
        expect(
          await store.update(id, 2, { state: 'ended-unpaid', endedBy: 'nothing' }),
        ).toMatchObject({ ok: false, reason: 'not_ready' });
        expect(await store.update(id, 2, { state: 'ended-unpaid' })).toMatchObject({ ok: true });
        expect(await store.update(id, 3, { state: 'blocked' })).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
      },
    );

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
      expect(
        await store.updateMarker('retrying', 4, 'first', solanaMarker('second')),
      ).toMatchObject({
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
      expect(
        await store.update('late', 3, { status: { status: 'completed', at: 2 } }),
      ).toMatchObject({ ok: true });
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

  describe('old Tempo prompts', () => {
    const NOW = 1_750_000_000 + 60;

    function tempoMarker(attemptId: string, extra: Partial<TempoMarker> = {}): TempoMarker {
      return { rail: 'tempo', attemptId, setAt: 1_750_000_050, floorBlock: '100', ...extra };
    }

    /** A Tempo order paying under `attemptId`: version 3. */
    async function tempoPaying(
      orderId: string,
      attemptId: string,
      overrides: Partial<OrderRecord> = {},
    ): Promise<void> {
      await addOrdered(orderId, { ...TEMPO_PAYOUT, ...overrides });
      const set = await store.setMarker(orderId, 2, tempoMarker(attemptId), NOW);
      if (!set.ok) {
        throw new Error(set.reason);
      }
    }

    /** A Tempo order that ended `over`: version 4. */
    async function tempoOver(orderId: string, overrides: Partial<OrderRecord> = {}): Promise<void> {
      await tempoPaying(orderId, `${orderId}-a`, overrides);
      const ended = await store.clearMarker(orderId, 3, `${orderId}-a`, 'ended-unpaid', 'over');
      if (!ended.ok) {
        throw new Error(ended.reason);
      }
    }

    it('never ends a Tempo attempt that holds a sent hash or an approved bundle', async () => {
      for (const evidence of [{ txHash: `0x${'1'.repeat(64)}` }, { bundleId: 'bundle' }]) {
        const id = Object.keys(evidence)[0] ?? 'x';
        await tempoPaying(id, 'a', { productAddress: `${PRODUCT}-${id}` });
        const current = await store.get(id);
        const withEvidence = { ...tempoMarker('a'), ...evidence };
        expect(await store.updateMarker(id, 3, 'a', withEvidence)).toMatchObject({ ok: true });
        for (const endedBy of ['over', 'rejected'] as const) {
          expect(
            await store.clearMarker(id, (current?.version ?? 0) + 1, 'a', 'ended-unpaid', endedBy),
          ).toMatchObject({ ok: false, reason: 'not_ready' });
        }
      }
    });

    it('marks only a stored bundle with no hash failed, and never takes that back', async () => {
      const bundle = { bundleId: 'bundle', bundleWallet: 'io.metamask' };
      const hash = `0x${'1'.repeat(64)}`;
      // No bundle stored: nothing for the wallet's word to be about.
      await tempoPaying('no-bundle', 'a', {
        productAddress: `${PRODUCT}-no-bundle`,
      });
      expect(
        await store.updateMarker('no-bundle', 3, 'a', {
          ...tempoMarker('a'),
          bundleFailed: true,
        }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      // A hash is evidence of its own: a failed bundle says nothing about it.
      await tempoPaying('hashed', 'a', { productAddress: `${PRODUCT}-hashed` });
      await store.updateMarker('hashed', 3, 'a', {
        ...tempoMarker('a'),
        ...bundle,
        txHash: hash,
      });
      expect(
        await store.updateMarker('hashed', 4, 'a', {
          ...tempoMarker('a', { ...bundle, txHash: hash }),
          bundleFailed: true,
        }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      // Nor may the failure and a hash arrive in one write.
      await tempoPaying('both', 'a', { productAddress: `${PRODUCT}-both` });
      await store.updateMarker('both', 3, 'a', tempoMarker('a', bundle));
      expect(
        await store.updateMarker(
          'both',
          4,
          'a',
          tempoMarker('a', { ...bundle, txHash: hash, bundleFailed: true }),
        ),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      expect(
        await store.updateMarker(
          'both',
          4,
          'a',
          tempoMarker('a', { ...bundle, bundleFailed: true }),
        ),
      ).toMatchObject({ ok: true, record: { marker: { bundleFailed: true } } });
      for (const takenBack of [
        tempoMarker('a', { ...bundle, bundleFailed: false }),
        tempoMarker('a', bundle),
      ]) {
        expect(await store.updateMarker('both', 5, 'a', takenBack)).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
      }
    });

    it('ends a failed bundle only over: never back to ordered, never rejected', async () => {
      const failed = tempoMarker('a', {
        bundleId: 'bundle',
        bundleFailed: true,
      });
      await tempoPaying('failed', 'a');
      await store.updateMarker('failed', 3, 'a', tempoMarker('a', { bundleId: 'bundle' }));
      await store.updateMarker('failed', 4, 'a', failed);
      expect(await store.clearMarker('failed', 5, 'a', 'ordered')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(await store.clearMarker('failed', 5, 'a', 'ended-unpaid', 'rejected')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(await store.clearMarker('failed', 5, 'a', 'ended-unpaid', 'over')).toMatchObject({
        ok: true,
        record: {
          state: 'ended-unpaid',
          endedBy: 'over',
          marker: { bundleFailed: true },
        },
      });
      // A hash that arrives after the failure holds the order again.
      await tempoPaying('late-hash', 'b', {
        productAddress: `${PRODUCT}-late-hash`,
      });
      await store.updateMarker('late-hash', 3, 'b', tempoMarker('b', { bundleId: 'bundle' }));
      await store.updateMarker('late-hash', 4, 'b', {
        ...failed,
        attemptId: 'b',
      });
      expect(
        await store.updateMarker('late-hash', 5, 'b', {
          ...failed,
          attemptId: 'b',
          txHash: `0x${'2'.repeat(64)}`,
        }),
      ).toMatchObject({ ok: true });
      expect(await store.clearMarker('late-hash', 6, 'b', 'ended-unpaid', 'over')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    });

    it('records why a Tempo order ended, once, and only on Tempo', async () => {
      await tempoPaying('reasonless', 'a');
      expect(await store.clearMarker('reasonless', 3, 'a', 'ended-unpaid')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(
        await store.clearMarker('reasonless', 3, 'a', 'ended-unpaid', 'rejected'),
      ).toMatchObject({ ok: true, record: { state: 'ended-unpaid', endedBy: 'rejected' } });
      expect(await store.update('reasonless', 4, { endedBy: 'nothing' })).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      // Solana records carry no reason.
      await addPaying('solana', 's');
      expect(await store.clearMarker('solana', 3, 's', 'ordered', 'over')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      await addOrdered('solana-ordered');
      expect(
        await store.update('solana-ordered', 2, { state: 'ended-unpaid', endedBy: 'nothing' }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      // A plain update ends a Tempo order only as "nothing requested".
      await addOrdered('tempo-ordered', TEMPO_PAYOUT);
      expect(await store.update('tempo-ordered', 2, { state: 'ended-unpaid' })).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(
        await store.update('tempo-ordered', 2, { state: 'ended-unpaid', endedBy: 'over' }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      expect(
        await store.update('tempo-ordered', 2, { state: 'ended-unpaid', endedBy: 'nothing' }),
      ).toMatchObject({ ok: true, record: { endedBy: 'nothing' } });
    });

    it('asks for confirmation before paying beside a recent Tempo order that ended over', async () => {
      for (const [id, payout] of [
        ['on-solana', {}],
        ['on-tempo', TEMPO_PAYOUT],
      ] as const) {
        const productAddress = `${PRODUCT}-${id}`;
        await tempoOver(`old-${id}`, { productAddress });
        await addOrdered(id, { ...payout, productAddress });
        const marker = id === 'on-solana' ? solanaMarker('n') : tempoMarker('n');
        expect(await store.setMarker(id, 2, marker, NOW)).toEqual({
          ok: false,
          reason: 'needs_confirmation',
          unconfirmed: [`old-${id}`],
        });
        // Without a clock every such order counts as recent (fail closed).
        expect(await store.setMarker(id, 2, marker)).toMatchObject({
          reason: 'needs_confirmation',
        });
        expect(await store.update(id, 2, { confirmedOverIds: [`old-${id}`] })).toMatchObject({
          ok: true,
        });
        expect(await store.setMarker(id, 3, marker, NOW)).toMatchObject({ ok: true });
      }
    });

    it('does not ask past the catch-up, nor for orders nothing was requested for', async () => {
      await tempoPaying('rejected', 'r');
      await store.clearMarker('rejected', 3, 'r', 'ended-unpaid', 'rejected');
      await addOrdered('nothing', TEMPO_PAYOUT);
      await store.update('nothing', 2, { state: 'ended-unpaid', endedBy: 'nothing' });
      await tempoOver('old');
      await addOrdered('fresh');
      // Only the `over` order is named.
      expect(await store.setMarker('fresh', 2, solanaMarker('f'), NOW)).toMatchObject({
        reason: 'needs_confirmation',
        unconfirmed: ['old'],
      });
      const later = 1_750_000_000 + 3 * 24 * 60 * 60 + 5 * 60 + 1;
      expect(await store.setMarker('fresh', 2, solanaMarker('f'), later)).toMatchObject({
        ok: true,
      });
    });

    it('asks before a Solana retry too', async () => {
      await tempoOver('old');
      // The first attempt was made when the old order was past the catch-up.
      await addOrdered('retrying');
      const later = 1_750_000_000 + 3 * 24 * 60 * 60 + 5 * 60 + 1;
      expect(await store.setMarker('retrying', 2, solanaMarker('first'), later)).toMatchObject({
        ok: true,
      });
      expect(
        await store.updateMarker('retrying', 3, 'first', solanaMarker('second'), NOW),
      ).toMatchObject({ ok: false, reason: 'needs_confirmation', unconfirmed: ['old'] });
    });

    it('keeps confirmations growing and a found time only with its payment', async () => {
      await addOrdered('one');
      expect(await store.update('one', 2, { confirmedOverIds: ['a', 'b'] })).toMatchObject({
        ok: true,
      });
      expect(await store.update('one', 3, { confirmedOverIds: ['a'] })).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(await store.update('one', 3, { paidAt: 5 })).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(
        await store.update('one', 3, { state: 'paid', paidTx: 'Tx', paidAt: 5 }),
      ).toMatchObject({ ok: true, record: { paidAt: 5 } });
    });
  });

  describe('the eip3009 marker', () => {
    const NOW = 1_750_000_000 + 60;
    const PAYER = `0x${'11'.repeat(20)}`;
    const OTHER = `0x${'22'.repeat(20)}`;
    const SIGNATURE = `0x${'5a'.repeat(65)}`;
    const HASH = `0x${'ab'.repeat(32)}`;
    const PROOF_PAST = { blockHash: `0x${'cd'.repeat(32)}`, timestamp: 1001 };
    const PROOF_AT = { blockHash: `0x${'cd'.repeat(32)}`, timestamp: 1000 };
    const BASE_SEPOLIA = EIP3009_USDC.find(({ chain }) => chain.caip2 === 'eip155:84532');
    const EIP3009_PAYOUT = {
      payout: { caip19: BASE_SEPOLIA?.caip19 ?? '', address: `0x${'33'.repeat(20)}` },
    };

    function eip3009Marker(attemptId: string, extra: Partial<Eip3009Marker> = {}): Eip3009Marker {
      return {
        rail: 'eip3009',
        attemptId,
        setAt: 1_750_000_050,
        authorizer: PAYER,
        floorBlock: '100',
        validBefore: '1000',
        ...extra,
      };
    }

    /** An `eip3009` order paying under `attemptId` (unsigned): version 3. */
    async function eip3009Paying(
      orderId: string,
      attemptId: string,
      overrides: Partial<OrderRecord> = {},
    ): Promise<void> {
      await addOrdered(orderId, { ...EIP3009_PAYOUT, ...overrides });
      const set = await store.setMarker(orderId, 2, eip3009Marker(attemptId), NOW);
      if (!set.ok) {
        throw new Error(set.reason);
      }
    }

    /** The same, its signature stored with `signed`: version 4. */
    async function eip3009Signed(
      orderId: string,
      attemptId: string,
      overrides: Partial<OrderRecord> = {},
    ): Promise<Eip3009Marker> {
      await eip3009Paying(orderId, attemptId, overrides);
      const marker = eip3009Marker(attemptId, { signed: true, signature: SIGNATURE });
      const written = await store.updateMarker(orderId, 3, attemptId, marker);
      if (!written.ok) {
        throw new Error(written.reason);
      }
      return marker;
    }

    it('sets an eip3009 marker only on an eip3009 payout', async () => {
      await eip3009Paying('one', 'a');
      expect((await store.get('one'))?.state).toBe('paying');
      await addOrdered('solana', { productAddress: OTHER_PRODUCT });
      expect(await store.setMarker('solana', 2, eip3009Marker('b'))).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      await addOrdered('tempo', { ...TEMPO_PAYOUT, productAddress: `${PRODUCT}-tempo` });
      expect(await store.setMarker('tempo', 2, eip3009Marker('c'))).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    });

    it('clears a marker that never held a signature, and never one that did', async () => {
      await eip3009Paying('unsigned', 'a');
      expect(await store.clearMarker('unsigned', 3, 'a', 'ordered')).toMatchObject({
        ok: true,
        record: { state: 'ordered' },
      });
      expect((await store.get('unsigned'))?.marker).toBeUndefined();
      await store.update('unsigned', 4, { state: 'ended-unpaid' });
      await eip3009Signed('signed', 'b');
      expect(await store.clearMarker('signed', 4, 'b', 'ordered')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      // `signed` alone is the evidence: no signature or hash needed.
      await store.add(record('flag', { ...EIP3009_PAYOUT, productAddress: OTHER_PRODUCT }));
      await store.update('flag', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
      await store.setMarker('flag', 2, eip3009Marker('c'), NOW);
      await store.updateMarker('flag', 3, 'c', eip3009Marker('c', { signed: true }));
      expect(await store.clearMarker('flag', 4, 'c', 'ordered')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    });

    it('retries only a signed marker, in place, keeping its evidence', async () => {
      await eip3009Paying('unsigned', 'a');
      expect(
        await store.updateMarker('unsigned', 3, 'a', eip3009Marker('a2', { validBefore: '2000' })),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      const signed = await eip3009Signed('one', 'b', { productAddress: OTHER_PRODUCT });
      const withHash = { ...signed, txHash: HASH };
      expect(await store.updateMarker('one', 4, 'b', withHash)).toMatchObject({ ok: true });
      const retry = { ...withHash, attemptId: 'b2', validBefore: '2000' };
      expect(await store.updateMarker('one', 5, 'b', retry)).toMatchObject({
        ok: true,
        record: { state: 'paying', marker: { attemptId: 'b2', signed: true, txHash: HASH } },
      });
      // A retry REPLACES the signature and the hash, never removes them.
      const replaced = {
        ...retry,
        signature: `0x${'6b'.repeat(65)}`,
        txHash: `0x${'ef'.repeat(32)}`,
      };
      expect(await store.updateMarker('one', 6, 'b2', replaced)).toMatchObject({ ok: true });
      const losses: Partial<Eip3009Marker>[] = [
        { signed: undefined },
        { signature: undefined },
        { txHash: undefined },
      ];
      for (const loss of losses) {
        for (const attemptId of ['b2', 'b3']) {
          expect(
            await store.updateMarker('one', 7, 'b2', { ...replaced, ...loss, attemptId }),
          ).toMatchObject({ ok: false, reason: 'not_ready' });
        }
      }
    });

    it('never moves the floor, never lowers validBefore, and fixes the window within an attempt', async () => {
      const signed = await eip3009Signed('one', 'a');
      const refused: Eip3009Marker[] = [
        { ...signed, attemptId: 'a2', floorBlock: '101' },
        { ...signed, attemptId: 'a2', validBefore: '999' },
        { ...signed, attemptId: 'a2', validBefore: 'later' },
        // Within the attempt, neither the window nor the authorizer moves.
        { ...signed, validBefore: '2000' },
        { ...signed, floorBlock: '99' },
        { ...signed, authorizer: OTHER, switchProof: PROOF_PAST },
        // No end proof, and no `usedAtStart`, through a marker write.
        { ...signed, attemptId: 'a2', endProof: PROOF_PAST },
        { ...signed, attemptId: 'a2', usedAtStart: true },
      ];
      for (const next of refused) {
        expect(await store.updateMarker('one', 4, 'a', next)).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
      }
      expect(
        await store.updateMarker('one', 4, 'a', {
          ...signed,
          attemptId: 'a2',
          validBefore: '1000',
        }),
      ).toMatchObject({ ok: true });
    });

    it('changes the authorizer only with a switch proof past the CURRENT validBefore', async () => {
      const signed = await eip3009Signed('one', 'a');
      const switched = { ...signed, attemptId: 'a2', authorizer: OTHER, validBefore: '2000' };
      for (const switchProof of [undefined, PROOF_AT, { ...PROOF_PAST, timestamp: 1000.5 }]) {
        expect(
          await store.updateMarker('one', 4, 'a', {
            ...switched,
            ...(switchProof === undefined ? {} : { switchProof }),
          }),
        ).toMatchObject({ ok: false, reason: 'not_ready' });
      }
      expect(
        await store.updateMarker('one', 4, 'a', { ...switched, switchProof: PROOF_PAST }),
      ).toMatchObject({
        ok: true,
        record: { marker: { authorizer: OTHER, signed: true, floorBlock: '100' } },
      });
      // The proof is judged against the marker as it is NOW: 1001 is not past 2000.
      expect(
        await store.updateMarker('one', 5, 'a2', {
          ...switched,
          attemptId: 'a3',
          authorizer: PAYER,
          switchProof: PROOF_PAST,
        }),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
    });

    it('ends a signed marker only with an end proof past its current validBefore, and keeps it', async () => {
      const signed = await eip3009Signed('one', 'a');
      for (const proof of [undefined, PROOF_AT, { ...PROOF_PAST, timestamp: Number.NaN }]) {
        expect(
          await store.clearMarker('one', 4, 'a', 'ended-unpaid', undefined, proof),
        ).toMatchObject({ ok: false, reason: 'not_ready' });
      }
      // A retry raised validBefore: the old proof no longer covers it.
      await store.updateMarker('one', 4, 'a', { ...signed, attemptId: 'a2', validBefore: '1500' });
      expect(
        await store.clearMarker('one', 5, 'a2', 'ended-unpaid', undefined, PROOF_PAST),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      const late = { blockHash: PROOF_PAST.blockHash, timestamp: 1501 };
      expect(
        await store.clearMarker('one', 5, 'a2', 'ended-unpaid', undefined, late),
      ).toMatchObject({
        ok: true,
        record: { state: 'ended-unpaid', marker: { endProof: late, signed: true } },
      });
      expect((await store.get('one'))?.endedBy).toBeUndefined();
    });

    it('ends an unsigned marker without a proof, and takes a proof on no other end', async () => {
      await eip3009Paying('unsigned', 'a');
      expect(
        await store.clearMarker('unsigned', 3, 'a', 'ordered', undefined, PROOF_PAST),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
      expect(await store.clearMarker('unsigned', 3, 'a', 'ended-unpaid', 'over')).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
      expect(await store.clearMarker('unsigned', 3, 'a', 'ended-unpaid')).toMatchObject({
        ok: true,
        record: { state: 'ended-unpaid' },
      });
      await addPaying('solana', 's');
      await store.update('solana', 3, {});
      expect(
        await store.clearMarker('solana', 4, 's', 'ended-unpaid', undefined, PROOF_PAST),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
    });

    it('rewrites an unsigned marker in place while it stays unsigned', async () => {
      await eip3009Paying('unsigned', 'a');
      expect(
        await store.updateMarker('unsigned', 3, 'a', eip3009Marker('a', { setAt: 1_750_000_060 })),
      ).toMatchObject({ ok: true, record: { marker: { attemptId: 'a' } } });
    });

    it('takes no write on a marker whose stored validBefore is not a decimal', async () => {
      await addOrdered('odd', EIP3009_PAYOUT);
      const set = await store.setMarker('odd', 2, eip3009Marker('o', { validBefore: 'soon' }), NOW);
      if (!set.ok) {
        throw new Error(set.reason);
      }
      for (const next of [
        eip3009Marker('o', { validBefore: 'soon', signed: true, signature: SIGNATURE }),
        eip3009Marker('o2', { validBefore: '2000' }),
      ]) {
        expect(await store.updateMarker('odd', 3, 'o', next)).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
      }
    });

    it('neither retries, switches nor ends a signed marker whose validBefore is not a decimal', async () => {
      await addOrdered('odd-signed', EIP3009_PAYOUT);
      const odd = eip3009Marker('s', { validBefore: 'soon', signed: true, signature: SIGNATURE });
      const set = await store.setMarker('odd-signed', 2, odd, NOW);
      if (!set.ok) {
        throw new Error(set.reason);
      }
      for (const next of [
        { ...odd, attemptId: 's2', validBefore: '2000' },
        {
          ...odd,
          attemptId: 's2',
          validBefore: '2000',
          authorizer: OTHER,
          switchProof: PROOF_PAST,
        },
      ]) {
        expect(await store.updateMarker('odd-signed', 3, 's', next)).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
      }
      expect(
        await store.clearMarker('odd-signed', 3, 's', 'ended-unpaid', undefined, PROOF_PAST),
      ).toMatchObject({ ok: false, reason: 'not_ready' });
    });

    it('counts a stored signature or hash as evidence on its own, without signed', async () => {
      for (const [id, extra] of [
        ['sig', { signature: SIGNATURE }],
        ['hash', { txHash: HASH }],
      ] as const) {
        await addOrdered(id, { ...EIP3009_PAYOUT, productAddress: `${PRODUCT}-${id}` });
        await store.setMarker(id, 2, eip3009Marker(id), NOW);
        expect(await store.updateMarker(id, 3, id, eip3009Marker(id, extra))).toMatchObject({
          ok: true,
        });
        expect(await store.clearMarker(id, 4, id, 'ordered')).toMatchObject({
          ok: false,
          reason: 'not_ready',
        });
      }
    });

    describe('a usedAtStart marker', () => {
      const frozen = (attemptId: string): Eip3009Marker =>
        eip3009Marker(attemptId, { usedAtStart: true, signed: true, validBefore: '0' });

      it('is set only frozen: signed, with validBefore 0', async () => {
        for (const [index, bad] of [
          eip3009Marker('x', { usedAtStart: true, validBefore: '0' }),
          eip3009Marker('y', { usedAtStart: true, signed: true }),
          eip3009Marker('z', { switchProof: PROOF_PAST }),
          eip3009Marker('w', { endProof: PROOF_PAST }),
        ].entries()) {
          const id = `bad-${index}`;
          await addOrdered(id, { ...EIP3009_PAYOUT, productAddress: `${PRODUCT}-${id}` });
          expect(await store.setMarker(id, 2, bad, NOW)).toMatchObject({
            ok: false,
            reason: 'not_ready',
          });
        }
        await addOrdered('frozen', EIP3009_PAYOUT);
        expect(await store.setMarker('frozen', 2, frozen('f'), NOW)).toMatchObject({
          ok: true,
          record: { state: 'paying' },
        });
      });

      it('takes no retry, switch or end, even with a proof past its validBefore', async () => {
        await addOrdered('frozen', EIP3009_PAYOUT);
        await store.setMarker('frozen', 2, frozen('f'), NOW);
        const marker = frozen('f');
        for (const next of [
          { ...marker, attemptId: 'f2', validBefore: '2000' },
          { ...marker, attemptId: 'f2', authorizer: OTHER, switchProof: PROOF_PAST },
          { ...marker, txHash: HASH },
        ]) {
          expect(await store.updateMarker('frozen', 3, 'f', next)).toMatchObject({
            ok: false,
            reason: 'not_ready',
          });
        }
        for (const [state, proof] of [
          ['ended-unpaid', PROOF_PAST],
          ['ended-unpaid', undefined],
          ['ordered', undefined],
        ] as const) {
          expect(await store.clearMarker('frozen', 3, 'f', state, undefined, proof)).toMatchObject({
            ok: false,
            reason: 'not_ready',
          });
        }
        expect((await store.get('frozen'))?.state).toBe('paying');
      });

      it('stays frozen when a write drops usedAtStart: no retry, switch or in-place write', async () => {
        await addOrdered('frozen', EIP3009_PAYOUT);
        await store.setMarker('frozen', 2, frozen('f'), NOW);
        const { usedAtStart: _dropped, ...unfrozen } = frozen('f');
        for (const next of [
          { ...unfrozen, attemptId: 'f2' },
          { ...unfrozen, attemptId: 'f2', validBefore: '2000' },
          { ...unfrozen, attemptId: 'f2', authorizer: OTHER, switchProof: PROOF_PAST },
          { ...unfrozen, txHash: HASH },
          unfrozen,
        ]) {
          expect(await store.updateMarker('frozen', 3, 'f', next)).toMatchObject({
            ok: false,
            reason: 'not_ready',
          });
        }
        expect((await store.get('frozen'))?.marker).toMatchObject({ usedAtStart: true });
      });

      it('is moved by a store delivery or a refund', async () => {
        for (const state of ['completed', 'refunded'] as const) {
          await addOrdered(state, { ...EIP3009_PAYOUT, productAddress: `${PRODUCT}-${state}` });
          await store.setMarker(state, 2, frozen(state), NOW);
          expect(await store.update(state, 3, { state })).toMatchObject({
            ok: true,
            record: { state },
          });
        }
      });

      it('asks for no old-prompt confirmation: it asks no wallet for anything', async () => {
        await tempoOverSibling();
        await addOrdered('frozen', EIP3009_PAYOUT);
        expect(await store.setMarker('frozen', 2, frozen('f'), NOW)).toMatchObject({ ok: true });
      });
    });

    /** A Tempo order of the same product that ended `over`. */
    async function tempoOverSibling(): Promise<void> {
      await addOrdered('tempo-over', TEMPO_PAYOUT);
      await store.setMarker(
        'tempo-over',
        2,
        { rail: 'tempo', attemptId: 't', setAt: 1, floorBlock: '1' },
        NOW,
      );
      const ended = await store.clearMarker('tempo-over', 3, 't', 'ended-unpaid', 'over');
      if (!ended.ok) {
        throw new Error(ended.reason);
      }
    }

    // The "over" confirmation stays Tempo-only: an ended eip3009 order (no
    // `endedBy`, which would count as `over` on Tempo) asks for none; an old
    // Tempo prompt still asks it of an eip3009 request, first or retry.
    it('keeps the old-prompt confirmation Tempo-only', async () => {
      await eip3009Paying('ended', 'e');
      await store.clearMarker('ended', 3, 'e', 'ended-unpaid');
      await addOrdered('fresh', EIP3009_PAYOUT);
      expect(await store.setMarker('fresh', 2, eip3009Marker('f'), NOW)).toMatchObject({
        ok: true,
      });
      await store.add(record('late', { ...EIP3009_PAYOUT, productAddress: OTHER_PRODUCT }));
      await store.update('late', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
      await store.add(record('tempo-over', { ...TEMPO_PAYOUT, productAddress: OTHER_PRODUCT }));
      await store.update('tempo-over', 1, {
        state: 'ordered',
        paymentRequest: '{}',
        ...ACKNOWLEDGED,
      });
      await store.setMarker(
        'tempo-over',
        2,
        { rail: 'tempo', attemptId: 't', setAt: 1, floorBlock: '1' },
        NOW,
      );
      await store.clearMarker('tempo-over', 3, 't', 'ended-unpaid', 'over');
      expect(await store.setMarker('late', 2, eip3009Marker('l'), NOW)).toMatchObject({
        ok: false,
        reason: 'needs_confirmation',
        unconfirmed: ['tempo-over'],
      });
    });

    // The general retry rules hold for an eip3009 retry too (review round 2).
    function retryOf(signed: Eip3009Marker): Eip3009Marker {
      return { ...signed, attemptId: `${signed.attemptId}-again`, validBefore: '2000' };
    }

    it('refuses an eip3009 retry while another order of the product holds the exclusion', async () => {
      const signed = await eip3009Signed('retrying', 'a');
      // Another order of the product was found paid late, meanwhile.
      await addOrdered('late');
      await store.update('late', 2, { state: 'paid' });
      expect(await store.updateMarker('retrying', 4, 'a', retryOf(signed))).toMatchObject({
        ok: false,
        reason: 'exclusion',
        holder: 'late',
      });
      expect((await store.get('retrying'))?.marker?.attemptId).toBe('a');
    });

    it('refuses an eip3009 retry on an order the store cancelled', async () => {
      const signed = await eip3009Signed('retrying', 'a');
      expect(
        await store.update('retrying', 4, { status: { status: 'cancelled', at: 1 } }),
      ).toMatchObject({ ok: true });
      expect(await store.updateMarker('retrying', 5, 'a', retryOf(signed))).toMatchObject({
        ok: false,
        reason: 'not_ready',
      });
    });

    it('asks before an eip3009 retry beside a Tempo order that ended over, as before a Solana one', async () => {
      await tempoOverSibling();
      // The first attempt was made when the old order was past the catch-up.
      await addOrdered('retrying', EIP3009_PAYOUT);
      const later = 1_750_000_000 + 3 * 24 * 60 * 60 + 5 * 60 + 1;
      expect(await store.setMarker('retrying', 2, eip3009Marker('a'), later)).toMatchObject({
        ok: true,
      });
      const signed = eip3009Marker('a', { signed: true, signature: SIGNATURE });
      expect(await store.updateMarker('retrying', 3, 'a', signed, later)).toMatchObject({
        ok: true,
      });
      expect(await store.updateMarker('retrying', 4, 'a', retryOf(signed), NOW)).toMatchObject({
        ok: false,
        reason: 'needs_confirmation',
        unconfirmed: ['tempo-over'],
      });
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
      // Cancelled without a refund while an attempt holds the marker: still live news.
      const cancelled = record('cancelled', {
        state: 'paying',
        createdAt: 1,
        status: { status: 'cancelled', at: 2 },
        marker: {
          rail: 'solana',
          attemptId: 'a',
          setAt: 1,
          blockhash: 'B',
          lastValidBlockHeight: '100',
        },
      });
      expect(recordToShow([newer, cancelled])?.orderId).toBe('cancelled');
      // Cancelled with no attempt: nothing holds it, the newer order shows.
      const dropped = record('dropped', {
        state: 'ordered',
        createdAt: 2,
        status: { status: 'cancelled', at: 3 },
      });
      expect(recordToShow([dropped, newer])?.orderId).toBe('newer');
      // An order that ended unpaid stays last, whatever the store said about it.
      const endedWithNews = record('ended-news', {
        state: 'ended-unpaid',
        createdAt: 3,
        status: { status: 'pending', at: 4 },
      });
      expect(recordToShow([endedWithNews, newer])?.orderId).toBe('newer');
      // A store answer on a live order still comes first.
      const pending = record('pending', {
        state: 'ordered',
        createdAt: 4,
        status: { status: 'pending', at: 5 },
      });
      expect(recordToShow([newer, pending])?.orderId).toBe('pending');
      // Same time: the lower order id, whichever order they come in.
      const twinA = record('a-twin', { createdAt: 30 });
      const twinB = record('b-twin', { createdAt: 30 });
      expect(recordToShow([twinB, twinA])?.orderId).toBe('a-twin');
      expect(recordToShow([twinA, twinB])?.orderId).toBe('a-twin');
      expect(recordToShow([])).toBeUndefined();
    });
  });
}
