import { USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { getBase64Encoder } from '@solana/kit';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { type LoadedOffer, loadOffer } from '../src/core/offer';
import { placeOrder } from '../src/core/order-flow';
import type { OrderRecord } from '../src/core/order-record';
import { OrderStore, openOrderDatabase } from '../src/core/order-store';
import {
  type SolanaPayDeps,
  checkBeforePaying,
  checkSignedTransaction,
  composeOrderPayment,
  endSolanaOrder,
  payWithSolana,
  retryWithSolana,
  storedSolanaRequest,
  watchSolanaPayment,
} from '../src/core/solana-pay';
import { DAY, MemoryRelays, NOW, type Shop, inboxList, makeShop } from './fixtures';
import { EMPTY_ACCOUNT_RENT, FakeSolana, FakeWallet, signatureOf } from './solana-fixtures';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
/** $49 in devnet USDC subunits. */
const PRICE = 49_000_000n;

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(await openOrderDatabase(new IDBFactory()));
});

async function loaded(shop: Shop, relays: MemoryRelays): Promise<Ready> {
  const offer = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['solana'],
    now: NOW,
  });
  if (!offer.ok) {
    throw new Error(offer.message);
  }
  return offer;
}

async function ordered(relays: MemoryRelays, fresh: Ready): Promise<OrderRecord> {
  const payout = fresh.payouts[0];
  if (payout === undefined) {
    throw new Error('no payout');
  }
  const placed = await placeOrder(
    { offer: fresh, payout, chainTime: NOW, deviceTime: NOW },
    { store, readClient: relays, clientFor: () => relays },
  );
  if (!placed.ok) {
    throw new Error(placed.reason);
  }
  const composed = await composeOrderPayment(placed.record, store);
  if (!composed.ok) {
    throw new Error(composed.reason);
  }
  return composed.record;
}

async function setup() {
  const shop = makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const fresh = await loaded(shop, relays);
  const record = await ordered(relays, fresh);
  const wallet = await FakeWallet.create();
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.blockTime = NOW + 60;
  const deps: SolanaPayDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpc: chain.rpc,
    now: () => NOW + 30,
  };
  const input = { fresh, chainTime: NOW + 30 };
  return { shop, relays, fresh, record, wallet, chain, deps, input };
}

async function stored(orderId: string): Promise<OrderRecord> {
  const record = await store.get(orderId);
  if (record === undefined) {
    throw new Error('no record');
  }
  return record;
}

describe('composing the request', () => {
  it('composes the order payment once, from the order, and never again', async () => {
    const { shop, record } = await setup();
    expect(storedSolanaRequest(record)).toMatchObject({
      recipient: shop.payout,
      amount: Number(PRICE),
      reference: record.reference,
      created_at: record.createdAt,
      network: 'devnet',
    });
    const again = await composeOrderPayment(record, store);
    expect(again).toMatchObject({ ok: true, record: { version: record.version } });
  });
});

describe('paying', () => {
  it('records the signature and the bytes before the first broadcast, then sends a receipt', async () => {
    const { record, wallet, chain, deps, input, relays } = await setup();
    let markerAtSend: OrderRecord['marker'];
    chain.onSend = async () => {
      markerAtSend = (await stored(record.orderId)).marker;
    };
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    expect(markerAtSend).toMatchObject({
      rail: 'solana',
      signature: paid.signature,
      signedTransaction: chain.sent[0],
    });
    expect(paid.record.state).toBe('paying');
    const receipt = paid.record.receiptWrap;
    expect(receipt).toBeDefined();
    expect(relays.published.map((entry) => entry.event.id)).toContain(receipt?.id);
    const watched = await watchSolanaPayment(paid.record, deps);
    expect(watched).toMatchObject({
      state: 'paid',
      record: { state: 'paid', paidTx: paid.signature },
    });
  });

  it('opens no wallet when a check fails, and sets no marker', async () => {
    const { record, wallet, chain, deps, input, shop } = await setup();
    const cases: [() => Promise<unknown>, string][] = [
      // An offer older than two minutes.
      [
        () => payWithSolana(record, wallet, input, { ...deps, now: () => NOW + 1000 }),
        'stale_offer',
      ],
      // The price changed since the order.
      [
        () =>
          payWithSolana(
            record,
            wallet,
            {
              ...input,
              fresh: {
                ...input.fresh,
                payouts: input.fresh.payouts.map((payout) => ({
                  ...payout,
                  amount: payout.amount + 1n,
                })),
              },
            },
            deps,
          ),
        'offer_changed',
      ],
      // Within an hour of the end of the merchant's catch-up.
      [
        () => payWithSolana(record, wallet, { ...input, chainTime: NOW + 3 * DAY }, deps),
        'too_late',
      ],
    ];
    for (const [run, reason] of cases) {
      expect(await run()).toMatchObject({ ok: false, reason });
    }
    expect(await checkBeforePaying(record, shop.payout, input, deps)).toMatchObject({
      ok: false,
      reason: 'self_payment',
    });
    chain.tokens = 1n;
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'insufficient_token',
      needed: PRICE,
      available: 1n,
    });
    chain.tokens = PRICE;
    chain.lamports = 1n;
    chain.payeeHasAccount = false;
    const short = await payWithSolana(record, wallet, input, deps);
    // The payee's token account is created by the payer: its rent is part of what is needed.
    expect(short).toMatchObject({ ok: false, reason: 'insufficient_sol', available: 1n });
    expect(short.ok === false && (short.needed ?? 0n) > 2_039_280n).toBe(true);
    chain.lamports = 1_000_000_000n;
    chain.failing = true;
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'rpc_error',
    });
    expect(wallet.requests).toBe(0);
    expect(await stored(record.orderId)).toMatchObject({
      state: 'ordered',
      version: record.version,
    });
  });

  it('reads nothing and opens no wallet for a record that is not waiting to pay', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    const calls = chain.calls.length;
    expect(await payWithSolana(paid.record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(chain.calls.length).toBe(calls);
    expect(wallet.requests).toBe(1);
  });

  it('never sends a transaction paid by another account than the wallet', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    const request = storedSolanaRequest(record);
    if (!paid.ok || request === undefined) {
      throw new Error('not paid');
    }
    const other = await FakeWallet.create();
    const bytes = new Uint8Array(getBase64Encoder().encode(chain.sent[0] ?? ''));
    expect(
      await checkSignedTransaction(bytes, {
        payer: other.address,
        blockhash: String(
          paid.record.marker?.rail === 'solana' ? paid.record.marker.blockhash : '',
        ),
        request,
        asset: USDC_SOLANA_DEVNET,
      }),
    ).toEqual({ ok: false, reason: 'wrong_payer' });
  });

  it('never lets a second order of the product pay while one attempt is live', async () => {
    const { shop, relays, fresh, record, wallet, deps, input, chain } = await setup();
    chain.dropSends = true;
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({ ok: true });
    const second = await ordered(relays, fresh);
    expect(await payWithSolana(second, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'exclusion',
      holder: record.orderId,
    });
    expect(wallet.requests).toBe(1);
  });

  it('sends nothing the wallet changed, and keeps the attempt until it expires', async () => {
    for (const [behaviour, detail] of [
      ['swap_blockhash', 'lifetime_changed'],
      ['change_amount', 'not_bound'],
      ['no_signature', 'unsigned'],
      ['durable_nonce', 'lifetime_changed'],
      ['bad_signature', 'unsigned'],
      ['append_compute_budget', 'duplicate_compute_budget'],
    ] as const) {
      const { record, wallet, chain, deps, input } = await setup();
      wallet.behaviour = behaviour;
      const result = await payWithSolana(record, wallet, input, deps);
      expect(result).toMatchObject({ ok: false, reason: 'wallet_unsupported', detail });
      expect(chain.sent).toEqual([]);
      const after = await stored(record.orderId);
      expect(after.state).toBe('paying');
      expect(after.marker).not.toHaveProperty('signature');
    }
  });

  it('sends nothing whose fee the wallet raised past what the payer holds', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'raise_price';
    // Enough for the widget's own price, not for the wallet's.
    chain.lamports = EMPTY_ACCOUNT_RENT + 100_000n;
    const result = await payWithSolana(record, wallet, input, deps);
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_sol' });
    expect(chain.sent).toEqual([]);
  });

  it("keeps the payer's own rent floor out of what it can spend", async () => {
    const { record, wallet, chain, deps, input } = await setup();
    // Enough for the fees, not for the fees plus the floor.
    chain.lamports = EMPTY_ACCOUNT_RENT;
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'insufficient_sol',
      available: EMPTY_ACCOUNT_RENT,
    });
    expect(wallet.requests).toBe(0);
  });

  it('pays only the request the record was composed with', async () => {
    const { record, wallet, deps, input } = await setup();
    const request = storedSolanaRequest(record);
    const tampered = {
      ...record,
      paymentRequest: JSON.stringify({ ...request, recipient: wallet.address }),
    };
    expect(await checkBeforePaying(tampered, wallet.address, input, deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
  });

  it('writes the signature though the record changed while the wallet was open', async () => {
    const { record, wallet, deps, input, chain } = await setup();
    wallet.duringPrompt = async () => {
      const current = await stored(record.orderId);
      await store.update(current.orderId, current.version, {
        status: { status: 'pending', at: NOW + 40 },
      });
    };
    const paid = await payWithSolana(record, wallet, input, deps);
    expect(paid).toMatchObject({ ok: true });
    expect(chain.sent).toHaveLength(1);
  });

  it('sends nothing when the attempt was ended while the wallet was open', async () => {
    const { record, wallet, deps, input, chain } = await setup();
    wallet.duringPrompt = async () => {
      const current = await stored(record.orderId);
      await store.clearMarker(
        current.orderId,
        current.version,
        current.marker?.attemptId ?? '',
        'ordered',
      );
    };
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(chain.sent).toEqual([]);
  });
});

describe('watching and retrying', () => {
  it('sends the signed bytes again while they can land', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    expect(chain.sent).toHaveLength(2);
    chain.dropSends = false;
    await watchSolanaPayment(paid.record, deps);
    expect(await watchSolanaPayment(await stored(record.orderId), deps)).toMatchObject({
      state: 'paid',
    });
  });

  it('allows a retry only once the blockhash expired and a full pass found nothing', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'wallet_failed',
    });
    const waiting = await stored(record.orderId);
    wallet.behaviour = 'sign';
    // No error clears a Solana attempt: the wallet may still have sent it.
    expect(await retryWithSolana(waiting, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    chain.expire();
    chain.nextBlockhash();
    const retried = await retryWithSolana(waiting, wallet, input, deps);
    if (!retried.ok) {
      throw new Error(retried.reason);
    }
    expect(retried.record.marker?.attemptId).not.toBe(waiting.marker?.attemptId);
    expect(retried.record.reference).toBe(record.reference);
    expect(await watchSolanaPayment(retried.record, deps)).toMatchObject({ state: 'paid' });
  });

  it('never calls an attempt over while the reference cannot be read in full', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    chain.expire();
    // A failed transaction under the reference is not a payment, and says nothing unsure.
    chain.extraListed = [{ signature: signatureOf(1), failed: true }];
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'over' });
    // Transactions under the reference that pay nothing do not block the verdict ...
    const junk = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        signature: signatureOf(index + 2),
        failed: false,
        junk: true,
      }));
    chain.extraListed = junk(3);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'over' });
    // ... but past what the widget checks, the answer is unsure, never "over".
    chain.extraListed = junk(101);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    // A listing cut short by the page cap (a spammed reference) is not a full pass either.
    chain.extraListed = Array.from({ length: 10_001 }, (_, index) => ({
      signature: signatureOf(index + 200),
      failed: true,
    }));
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
  });

  it('never calls an attempt over from a node behind the one that saw it expire', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    // It landed; the next reads go to a node that has not seen it yet.
    chain.expire();
    chain.lagging = true;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    expect(await retryWithSolana(paid.record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    chain.lagging = false;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'paid' });
  });

  it("never calls an attempt over while the node's index lags what its statuses show", async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    chain.expire();
    chain.indexLag = true;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    expect(await endSolanaOrder(paid.record, deps)).toMatchObject({ ended: false });
    chain.indexLag = false;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'paid' });
  });

  it('never calls an attempt over when the node answering statuses is behind', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    chain.expire();
    chain.indexLag = true;
    chain.statusLag = true;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
  });

  it('never calls an attempt over from an RPC whose ledger no longer reaches it', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    // The buyer comes back a day later to a node that pruned the attempt's slot.
    chain.expire();
    chain.pruned = true;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    expect(await retryWithSolana(paid.record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
  });

  it('calls an attempt over only when the history provably reaches its slot', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    const marker = paid.record?.marker;
    if (!paid.ok || marker?.rail !== 'solana' || marker.slot === undefined) {
      throw new Error('no attempt');
    }
    chain.expire();
    const slot = BigInt(marker.slot);
    chain.firstAvailableBlock = slot + 1n;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    chain.firstAvailableBlock = undefined;
    chain.historyReadFails = true;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    chain.historyReadFails = false;
    const { slot: _dropped, ...withoutSlot } = marker;
    expect(await watchSolanaPayment({ ...paid.record, marker: withoutSlot }, deps)).toMatchObject({
      state: 'waiting',
    });
    chain.firstAvailableBlock = slot;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'over' });
  });

  it('waits past the expiry for the index to settle before calling an attempt over', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    // Just past the last valid height: expired, not yet settled.
    chain.advance(32n + 150n + 1n);
    const sent = chain.sent.length;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    expect(chain.sent).toHaveLength(sent);
    // Exactly 32 blocks past: still settling.
    chain.advance(31n);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
    chain.advance(1n);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'over' });
  });

  it('reads the expiry before the pass: a payment landing during the pass is never missed', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    // While the pass reads, the transaction lands and the blockhash then expires.
    let once = true;
    chain.onList = async () => {
      if (once) {
        once = false;
        chain.dropSends = false;
        await chain.rpc.sendTransaction((chain.sent[0] ?? '') as never).send();
        chain.expire();
      }
    };
    expect(await watchSolanaPayment(paid.record, deps)).not.toMatchObject({ state: 'over' });
    expect(await watchSolanaPayment(await stored(record.orderId), deps)).toMatchObject({
      state: 'paid',
    });
  });

  it('judges expiry at finalized, not at the tip', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    // The tip is past the last valid height; the finalized chain is not yet.
    chain.advance(151n);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'waiting' });
  });

  it('stops sending the bytes once the blockhash expired', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    chain.expire();
    const sent = chain.sent.length;
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'over' });
    expect(chain.sent).toHaveLength(sent);
  });

  it('never retries an order the store cancelled', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    const waiting = await stored(record.orderId);
    const cancelled = await store.update(waiting.orderId, waiting.version, {
      status: { status: 'cancelled', at: NOW + 50 },
    });
    if (!cancelled.ok) {
      throw new Error(cancelled.reason);
    }
    chain.expire();
    wallet.behaviour = 'sign';
    expect(await retryWithSolana(cancelled.record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(wallet.requests).toBe(1);
  });
});

describe('payments found later', () => {
  it('records a payment under the reference from elsewhere, with a receipt naming it', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    const waiting = await stored(record.orderId);
    const request = storedSolanaRequest(waiting);
    if (request === undefined) {
      throw new Error('no request');
    }
    // Another device paid this order.
    const elsewhere = await chain.injectPayment(request);
    const found = await watchSolanaPayment(waiting, deps);
    expect(found).toMatchObject({ state: 'paid', record: { state: 'paid', paidTx: elsewhere } });
    expect(found.record.receiptWrap).toBeDefined();
  });

  it('records a payment found for an order that already ended unpaid, with a receipt', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    chain.expire();
    const ended = await endSolanaOrder(await stored(record.orderId), deps);
    expect(ended.record.state).toBe('ended-unpaid');
    const request = storedSolanaRequest(ended.record);
    if (request === undefined) {
      throw new Error('no request');
    }
    chain.nextBlockhash();
    const late = await chain.injectPayment(request);
    const found = await watchSolanaPayment(ended.record, deps);
    expect(found).toMatchObject({ state: 'paid', record: { state: 'paid', paidTx: late } });
    expect(found.record.receiptWrap).toBeDefined();
  });

  it('sends the receipt a closed tab lost once the payment is recorded', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    const waiting = await stored(record.orderId);
    const request = storedSolanaRequest(waiting);
    if (request === undefined) {
      throw new Error('no request');
    }
    const elsewhere = await chain.injectPayment(request);
    // Recorded paid with no receipt (the tab closed in between).
    const written = await store.update(waiting.orderId, waiting.version, {
      state: 'paid',
      paidTx: elsewhere,
    });
    if (!written.ok) {
      throw new Error(written.reason);
    }
    expect(written.record.receiptWrap).toBeUndefined();
    const watched = await watchSolanaPayment(written.record, deps);
    expect(watched.record.receiptWrap).toBeDefined();
  });
});

describe('ending an order', () => {
  it('ends at once when nothing was requested, and only after the attempt ended otherwise', async () => {
    const plain = await setup();
    expect(await endSolanaOrder(plain.record, plain.deps)).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid' },
    });

    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    const waiting = await stored(record.orderId);
    expect(await endSolanaOrder(waiting, deps)).toMatchObject({ ended: false });
    chain.expire();
    const ended = await endSolanaOrder(waiting, deps);
    expect(ended).toMatchObject({ ended: true, record: { state: 'ended-unpaid' } });
    // The marker is kept: later reconciliation starts from it.
    expect(ended.record.marker?.attemptId).toBe(waiting.marker?.attemptId);
  });
});
