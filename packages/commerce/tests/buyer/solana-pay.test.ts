import { USDC_SOLANA_DEVNET, USDC_SOLANA_MAINNET } from '@elisym/pay-core';
import { getBase64Encoder } from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { type LoadedOffer, loadOffer } from '../../src/buyer/offer';
import { placeOrder } from '../../src/buyer/order-flow';
import type { OrderRecord } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore, storeClosed } from '../../src/buyer/order-store';
import {
  type SolanaPayDeps,
  checkBeforePaying,
  checkSignedTransaction,
  composeOrderPayment,
  endSolanaOrder,
  isSolanaUserRejection,
  payWithSolana,
  retryWithSolana,
  signAgainWithSolana,
  storedSolanaRequest,
  watchSolanaPayment,
} from '../../src/buyer/solana-pay';
import {
  DAY,
  MemoryRelays,
  NO_FEE_TERMS,
  NOW,
  type Shop,
  inboxList,
  makeShop,
  solanaAddress,
} from './fixtures';
import { ACKNOWLEDGED, record as contractRecord } from './order-store.contract';
import { EMPTY_ACCOUNT_RENT, FakeSolana, FakeWallet, signatureOf } from './solana-fixtures';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
/** $49 in devnet USDC subunits. */
const PRICE = 49_000_000n;

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;
/** The store's backend: a test may write a record directly, past every rule. */
let backend: MemoryOrderBackend;

beforeEach(async () => {
  backend = new MemoryOrderBackend();
  store = new OrderStore(backend);
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
  const composed = await composeOrderPayment(placed.record, store, {
    offer: fresh.offer,
    feeTerms: NO_FEE_TERMS,
  });
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
    feeTerms: NO_FEE_TERMS,
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
    const again = await composeOrderPayment(record, store, {
      offer: { feeSupport: false },
      feeTerms: NO_FEE_TERMS,
    });
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
    const { relays, fresh, record, wallet, deps, input, chain } = await setup();
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

describe('a delivered order', () => {
  it('reads nothing more once the store delivered or refunded, and claims no payment', async () => {
    for (const [state, status] of [
      ['completed', { status: 'completed', at: NOW + 60, delivery: 'https://shop.example/course' }],
      ['refunded', { status: 'cancelled', at: NOW + 60, refunded: true }],
    ] as const) {
      const { record, wallet, chain, deps, input } = await setup();
      chain.dropSends = true;
      const paid = await payWithSolana(record, wallet, input, deps);
      if (!paid.ok) {
        throw new Error(paid.reason);
      }
      const answered = await store.update(paid.record.orderId, paid.record.version, {
        state,
        status,
      });
      if (!answered.ok) {
        throw new Error(answered.reason);
      }
      const calls = chain.calls.length;
      const watched = await watchSolanaPayment(answered.record, deps);
      expect(watched).toMatchObject({ state: 'closed', record: { state } });
      expect(watched.record.paidTx).toBeUndefined();
      expect(chain.calls).toHaveLength(calls);
    }
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

describe('a caller whose RPC cannot prove an attempt over', () => {
  it('never retries or ends an expired attempt, and keeps watching it', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const limited: SolanaPayDeps = { ...deps, canProveOver: false };
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, limited);
    const waiting = await stored(record.orderId);
    chain.expire();
    chain.nextBlockhash();
    expect(await watchSolanaPayment(waiting, limited)).toMatchObject({ state: 'waiting' });
    wallet.behaviour = 'sign';
    expect(await retryWithSolana(waiting, wallet, input, limited)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    expect(await endSolanaOrder(waiting, limited)).toMatchObject({ ended: false });
    expect((await stored(record.orderId)).state).toBe('paying');
    // The same chain, with proof: over.
    expect(await watchSolanaPayment(waiting, deps)).toMatchObject({ state: 'over' });
  });

  it('still ends an acknowledged order that never had an attempt', async () => {
    const { record, deps } = await setup();
    expect(await endSolanaOrder(record, { ...deps, canProveOver: false })).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid' },
    });
  });
});

describe("the caller's spend limits", () => {
  function limits(allow = true) {
    const reserved: { attemptId: string; tokenAmount: bigint; lamports: bigint }[] = [];
    const released: string[] = [];
    return {
      reserved,
      released,
      reserve: (costs: { tokenAmount: bigint; lamports: bigint }, attemptId: string) => {
        if (!allow) {
          throw new Error('over the limit');
        }
        reserved.push({ attemptId, tokenAmount: costs.tokenAmount, lamports: costs.lamports });
      },
      release: (attemptId: string) => {
        released.push(attemptId);
      },
    };
  }

  it('reserves the price and the SOL it spends before the marker, and keeps it once sent', async () => {
    const { record, wallet, deps, input } = await setup();
    const spend = limits();
    const calls: string[] = [];
    const spied = Object.create(store) as OrderStore;
    spied.setMarker = (...args: Parameters<OrderStore['setMarker']>) => {
      calls.push('setMarker');
      return store.setMarker(...args);
    };
    const paid = await payWithSolana(record, wallet, input, {
      ...deps,
      store: spied,
      reserve: (costs, attemptId) => {
        calls.push('reserve');
        spend.reserve(costs, attemptId);
      },
      release: spend.release,
    });
    expect(paid).toMatchObject({ ok: true });
    expect(calls).toEqual(['reserve', 'setMarker']);
    expect(spend.reserved).toHaveLength(1);
    expect(spend.reserved[0]?.tokenAmount).toBe(PRICE);
    // The fee at least, and the payee's token-account rent when it is missing.
    expect(spend.reserved[0]?.lamports).toBeGreaterThan(0n);
    expect(spend.reserved[0]?.attemptId).toBe(paid.ok ? paid.record.marker?.attemptId : '');
    expect(spend.released).toEqual([]);
  });

  it('gives the reservation back when writing the attempt throws', async () => {
    const { record, wallet, deps, input } = await setup();
    const spend = limits();
    const failing = Object.create(store) as OrderStore;
    failing.setMarker = async () => {
      throw new Error('the order file is locked');
    };
    await expect(
      payWithSolana(record, wallet, input, {
        ...deps,
        store: failing,
        reserve: spend.reserve,
        release: spend.release,
      }),
    ).rejects.toThrow('locked');
    expect(spend.released).toEqual([spend.reserved[0]?.attemptId]);
    expect(wallet.requests).toBe(0);
  });

  it('asks for confirmation beside a recent Tempo order whose prompt may still be approved', async () => {
    const { record, wallet, deps, input } = await setup();
    const tempo = contractRecord('old-tempo', {
      productAddress: record.productAddress,
      createdAt: NOW,
      payout: {
        caip19: 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50',
        address: '0xabc',
      },
    });
    await store.add(tempo);
    await store.update('old-tempo', 1, { state: 'ordered', paymentRequest: '{}', ...ACKNOWLEDGED });
    await store.setMarker(
      'old-tempo',
      2,
      { rail: 'tempo', attemptId: 'a', setAt: NOW, floorBlock: '1' },
      NOW,
    );
    await store.clearMarker('old-tempo', 3, 'a', 'ended-unpaid', 'over');
    const spend = limits();
    expect(
      await payWithSolana(record, wallet, input, {
        ...deps,
        reserve: spend.reserve,
        release: spend.release,
      }),
    ).toMatchObject({ ok: false, reason: 'needs_confirmation', unconfirmed: ['old-tempo'] });
    expect(spend.released).toEqual([spend.reserved[0]?.attemptId]);
    expect(wallet.requests).toBe(0);
    expect((await stored(record.orderId)).marker).toBeUndefined();
  });

  it('refuses before anything is recorded when the limits say no', async () => {
    const { record, wallet, deps, input } = await setup();
    const spend = limits(false);
    expect(
      await payWithSolana(record, wallet, input, {
        ...deps,
        reserve: spend.reserve,
        release: spend.release,
      }),
    ).toMatchObject({ ok: false, reason: 'spend_limit' });
    const after = await stored(record.orderId);
    expect(after.state).toBe('ordered');
    expect(after.marker).toBeUndefined();
    expect(wallet.requests).toBe(0);
  });

  it('gives back what an attempt refused before any broadcast reserved', async () => {
    const { relays, fresh, record, wallet, chain, deps, input } = await setup();
    chain.dropSends = true;
    await payWithSolana(record, wallet, input, deps);
    // Another order of the product holds the exclusion: the marker is refused.
    const second = await ordered(relays, fresh);
    const spend = limits();
    expect(
      await payWithSolana(second, wallet, input, {
        ...deps,
        reserve: spend.reserve,
        release: spend.release,
      }),
    ).toMatchObject({ ok: false, reason: 'exclusion' });
    expect(spend.released).toEqual(spend.reserved.map((entry) => entry.attemptId));
    expect(spend.released).toHaveLength(1);
  });

  it('gives back a reservation when the fee the wallet signed cannot be covered', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'raise_price';
    chain.lamports = EMPTY_ACCOUNT_RENT + 100_000n;
    const spend = limits();
    const result = await payWithSolana(record, wallet, input, {
      ...deps,
      reserve: spend.reserve,
      release: spend.release,
    });
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_sol' });
    expect(spend.released).toHaveLength(1);
  });

  it('keeps the reservation while an attempt the wallet failed may still land', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'throw';
    const spend = limits();
    expect(
      await payWithSolana(record, wallet, input, {
        ...deps,
        reserve: spend.reserve,
        release: spend.release,
      }),
    ).toMatchObject({ ok: false, reason: 'wallet_failed' });
    expect(spend.reserved).toHaveLength(1);
    expect(spend.released).toEqual([]);
  });

  it('gives back a first ask’s reservation when its signature cannot be written', async () => {
    const cases: [string, (run: Awaited<ReturnType<typeof setup>>) => OrderStore][] = [
      [
        'another tab replaced the attempt while the wallet was open',
        ({ record, wallet }) => {
          wallet.duringPrompt = async () => {
            const current = await stored(record.orderId);
            if (current.marker === undefined) {
              throw new Error('no marker');
            }
            await store.updateMarker(current.orderId, current.version, current.marker.attemptId, {
              ...current.marker,
              attemptId: 'other-tab-attempt',
            });
          };
          return store;
        },
      ],
      [
        'the store refused the write outright',
        () => {
          const refusing = Object.create(store) as OrderStore;
          refusing.updateMarker = async () => ({ ok: false, reason: 'not_ready' });
          return refusing;
        },
      ],
      [
        'every write lost its race',
        () => {
          const losing = Object.create(store) as OrderStore;
          losing.updateMarker = async () => ({ ok: false, reason: 'conflict' });
          return losing;
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const run = await setup();
      const spend = limits();
      const result = await payWithSolana(run.record, run.wallet, run.input, {
        ...run.deps,
        store: arrange(run),
        reserve: spend.reserve,
        release: spend.release,
      });
      expect({
        name,
        reason: result.ok ? 'paid' : result.reason,
        signedNotSent: result.ok ? undefined : result.signedNotSent,
        afterMarker: result.ok ? undefined : result.afterMarker,
      }).toEqual({ name, reason: 'conflict', signedNotSent: true, afterMarker: undefined });
      expect({ name, released: spend.released }).toEqual({
        name,
        released: spend.reserved.map((entry) => entry.attemptId),
      });
      expect({ name, count: spend.released.length }).toEqual({ name, count: 1 });
      expect({ name, sent: run.chain.sent }).toEqual({ name, sent: [] });
    }
  });

  it('reserves again for a retry, before its marker replaces the old one', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    const waiting = await stored(record.orderId);
    chain.expire();
    chain.nextBlockhash();
    wallet.behaviour = 'sign';
    const spend = limits();
    const refused = await retryWithSolana(waiting, wallet, input, {
      ...deps,
      reserve: limits(false).reserve,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'spend_limit' });
    expect((await stored(record.orderId)).marker?.attemptId).toBe(waiting.marker?.attemptId);
    const retried = await retryWithSolana(waiting, wallet, input, {
      ...deps,
      reserve: spend.reserve,
      release: spend.release,
    });
    expect(retried).toMatchObject({ ok: true });
    expect(spend.reserved).toHaveLength(1);
  });
});

describe('a decline in the wallet', () => {
  function spendLimits() {
    const reserved: string[] = [];
    const released: string[] = [];
    return {
      reserved,
      released,
      reserve: (_costs: { tokenAmount: bigint; lamports: bigint }, attemptId: string) => {
        reserved.push(attemptId);
      },
      release: (attemptId: string) => {
        released.push(attemptId);
      },
    };
  }

  it('releases the attempt at once: the order is ordered again, nothing was sent', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'reject';
    const spend = spendLimits();
    const result = await payWithSolana(record, wallet, input, {
      ...deps,
      reserve: spend.reserve,
      release: spend.release,
    });
    expect(result).toMatchObject({ ok: false, reason: 'rejected', record: { state: 'ordered' } });
    const after = await stored(record.orderId);
    expect(after.state).toBe('ordered');
    expect(after.marker).toBeUndefined();
    expect(spend.released).toEqual(spend.reserved);
    expect(spend.released).toHaveLength(1);
    expect(chain.sent).toEqual([]);
  });

  it('pays the same order anew right after a decline, with a new attempt', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'reject';
    const declined = await payWithSolana(record, wallet, input, deps);
    if (declined.ok || declined.record === undefined) {
      throw new Error('expected a decline');
    }
    wallet.behaviour = 'sign';
    const paid = await payWithSolana(declined.record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    expect(paid.record.orderId).toBe(record.orderId);
    expect(paid.record.reference).toBe(record.reference);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'paid' });
  });

  it('releases a declined retry too, and the order can be paid again', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'throw';
    await payWithSolana(record, wallet, input, deps);
    const waiting = await stored(record.orderId);
    chain.expire();
    chain.nextBlockhash();
    wallet.behaviour = 'reject';
    const declined = await retryWithSolana(waiting, wallet, input, deps);
    expect(declined).toMatchObject({ ok: false, reason: 'rejected', record: { state: 'ordered' } });
    expect((await stored(record.orderId)).marker).toBeUndefined();
    wallet.behaviour = 'sign';
    const paid = await payWithSolana(await stored(record.orderId), wallet, input, deps);
    expect(paid).toMatchObject({ ok: true });
  });

  it('still releases when the record changed while the wallet was open', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'reject';
    wallet.duringPrompt = async () => {
      const current = await stored(record.orderId);
      await store.update(current.orderId, current.version, {
        status: { status: 'pending', at: NOW + 40 },
      });
    };
    const result = await payWithSolana(record, wallet, input, deps);
    expect(result).toMatchObject({ ok: false, reason: 'rejected', record: { state: 'ordered' } });
    expect((await stored(record.orderId)).marker).toBeUndefined();
  });

  it("never clears another tab's attempt", async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'reject';
    let otherAttempt: string | undefined;
    wallet.duringPrompt = async () => {
      const current = await stored(record.orderId);
      const attemptId = current.marker?.attemptId ?? '';
      const cleared = await store.clearMarker(
        current.orderId,
        current.version,
        attemptId,
        'ordered',
      );
      if (!cleared.ok || current.marker === undefined) {
        throw new Error('could not clear');
      }
      otherAttempt = 'other-tab-attempt';
      const set = await store.setMarker(cleared.record.orderId, cleared.record.version, {
        ...current.marker,
        attemptId: otherAttempt,
      });
      if (!set.ok) {
        throw new Error(set.reason);
      }
    };
    const result = await payWithSolana(record, wallet, input, deps);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    // A decline: nothing was signed.
    expect(result).not.toHaveProperty('signedNotSent');
    expect((await stored(record.orderId)).marker?.attemptId).toBe(otherAttempt);
  });

  it('keeps the attempt when every write conflicts', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'reject';
    const conflicting = Object.create(store) as OrderStore;
    conflicting.clearMarker = async () => ({ ok: false, reason: 'conflict' });
    const result = await payWithSolana(record, wallet, input, { ...deps, store: conflicting });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await stored(record.orderId)).marker).toBeDefined();
  });

  it('counts only an own code 4001 as a decline', () => {
    expect(isSolanaUserRejection({ code: 4001 })).toBe(true);
    expect(isSolanaUserRejection({ code: '4001' })).toBe(true);
    for (const error of [
      new Error('User rejected the request.'),
      { code: 4100 },
      { code: '0xfa1' },
      { code: [4001] },
      { code: ' 4001 ' },
      { code: 4001n },
      { message: 'User rejected the request.' },
      Object.create({ code: 4001 }),
      null,
      'User rejected the request.',
    ]) {
      expect(isSolanaUserRejection(error)).toBe(false);
    }
  });

  it('keeps the attempt live on any other wallet failure', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'throw';
    expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
      ok: false,
      reason: 'wallet_failed',
    });
    expect((await stored(record.orderId)).marker).toBeDefined();
  });
});

describe('asking the same wallet again', () => {
  /** A first ask the wallet failed: the attempt is live, with its handle. */
  async function failedOnce(options: { lamports?: bigint } = {}) {
    const run = await setup();
    if (options.lamports !== undefined) {
      run.chain.lamports = options.lamports;
    }
    run.wallet.behaviour = 'throw';
    const failed = await payWithSolana(run.record, run.wallet, run.input, run.deps);
    if (failed.ok || failed.again === undefined) {
      throw new Error('expected a wallet failure with a handle');
    }
    run.wallet.behaviour = 'sign';
    const waiting = await stored(run.record.orderId);
    if (waiting.marker?.rail !== 'solana') {
      throw new Error('no Solana marker');
    }
    return { ...run, failed, again: failed.again, waiting, marker: waiting.marker };
  }

  /** Write `change` of the stored record straight to the backend, past every rule. */
  async function tamper(orderId: string, change: (record: OrderRecord) => OrderRecord) {
    const current = await stored(orderId);
    await backend.transactProduct(current.productAddress, () => ({
      write: [change(current)],
      result: undefined,
    }));
  }

  /** The store, with every marker write and release counted. */
  function counted() {
    const calls = { updateMarker: 0, clearMarker: 0, released: [] as string[], reserved: 0 };
    const spied = Object.create(store) as OrderStore;
    spied.updateMarker = (...args: Parameters<OrderStore['updateMarker']>) => {
      calls.updateMarker += 1;
      return store.updateMarker(...args);
    };
    spied.clearMarker = (...args: Parameters<OrderStore['clearMarker']>) => {
      calls.clearMarker += 1;
      return store.clearMarker(...args);
    };
    return {
      calls,
      store: spied,
      release: (attemptId: string) => {
        calls.released.push(attemptId);
      },
      reserve: () => {
        calls.reserved += 1;
      },
    };
  }

  it('hands back a handle on a first ask and a retry the wallet failed, with only its ids', async () => {
    const { again, marker, wallet, record } = await failedOnce();
    expect(Object.keys(again).sort()).toEqual(['attemptId', 'orderId', 'payer']);
    expect(Object.isFrozen(again)).toBe(true);
    expect(again).toEqual({
      orderId: record.orderId,
      attemptId: marker.attemptId,
      payer: wallet.address,
    });
    const retry = await setup();
    retry.wallet.behaviour = 'throw';
    await payWithSolana(retry.record, retry.wallet, retry.input, retry.deps);
    retry.chain.expire();
    retry.chain.nextBlockhash();
    const retried = await retryWithSolana(
      await stored(retry.record.orderId),
      retry.wallet,
      retry.input,
      retry.deps,
    );
    expect(retried).toMatchObject({ ok: false, reason: 'wallet_failed' });
    expect(retried.ok === false && retried.again !== undefined).toBe(true);
    expect(retried.ok === false ? retried.again?.attemptId : undefined).toBe(
      (await stored(retry.record.orderId)).marker?.attemptId,
    );
  });

  it('keeps the attempt’s own message though the wallet wrote over what it was handed', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const scribbler = {
      address: wallet.address,
      signTransaction: async (bytes: Uint8Array): Promise<Uint8Array> => {
        bytes.fill(0);
        throw new Error('wallet failed');
      },
    };
    const failed = await payWithSolana(record, scribbler, input, deps);
    if (failed.ok || failed.again === undefined) {
      throw new Error('expected a wallet failure with a handle');
    }
    const paid = await signAgainWithSolana(failed.again, wallet, deps);
    expect(paid).toMatchObject({ ok: true });
    expect(await watchSolanaPayment(await stored(record.orderId), deps)).toMatchObject({
      state: 'paid',
    });
    expect(chain.sent).toHaveLength(1);
  });

  it('pays in the same attempt: the signature recorded before the broadcast', async () => {
    const { again, wallet, chain, deps, marker, record } = await failedOnce();
    let markerAtSend: OrderRecord['marker'];
    chain.onSend = async () => {
      markerAtSend = (await stored(record.orderId)).marker;
    };
    const paid = await signAgainWithSolana(again, wallet, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    expect(wallet.requests).toBe(2);
    expect(markerAtSend).toMatchObject({
      attemptId: marker.attemptId,
      blockhash: marker.blockhash,
      signature: paid.signature,
      signedTransaction: chain.sent[0],
    });
    expect(chain.sent).toHaveLength(1);
    expect(await watchSolanaPayment(paid.record, deps)).toMatchObject({ state: 'paid' });
  });

  it('accepts a message the wallet changed but kept valid, on again and on a first ask', async () => {
    const first = await setup();
    first.wallet.behaviour = 'raise_price';
    expect(await payWithSolana(first.record, first.wallet, first.input, first.deps)).toMatchObject({
      ok: true,
    });
    const { again, wallet, deps } = await failedOnce();
    wallet.behaviour = 'raise_price';
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({ ok: true });
  });

  it('checks what the wallet returned before it lists the reference again', async () => {
    for (const listing of ['shows a row', 'throws'] as const) {
      const { again, wallet, chain, deps, marker } = await failedOnce();
      wallet.behaviour = 'swap_blockhash';
      let atAnswer = 0;
      wallet.duringPrompt = async () => {
        if (listing === 'throws') {
          chain.listingFails = true;
        } else {
          chain.extraListed = [
            { signature: signatureOf(1), failed: false, slot: BigInt(marker.slot ?? '0') },
          ];
        }
        atAnswer = chain.calls.length;
      };
      const result = await signAgainWithSolana(again, wallet, deps);
      expect({ listing, reason: result.ok ? 'paid' : result.reason }).toEqual({
        listing,
        reason: 'wallet_unsupported',
      });
      expect({
        listing,
        listed: chain.calls.slice(atAnswer).includes('getSignaturesForAddress'),
      }).toEqual({ listing, listed: false });
    }
  });

  it('sends nothing the wallet returned for another blockhash, and hands no handle back', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    wallet.behaviour = 'swap_blockhash';
    const result = await signAgainWithSolana(again, wallet, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'wallet_unsupported',
      detail: 'lifetime_changed',
      attemptId: marker.attemptId,
    });
    expect(result).not.toHaveProperty('again');
    expect(result).not.toHaveProperty('afterMarker');
    expect(chain.sent).toEqual([]);
    const first = await setup();
    first.wallet.behaviour = 'swap_blockhash';
    const unsupported = await payWithSolana(first.record, first.wallet, first.input, first.deps);
    expect(unsupported).toMatchObject({ ok: false, reason: 'wallet_unsupported' });
    expect(unsupported).not.toHaveProperty('again');
  });

  it('keeps the attempt on a decline: nothing cleared or released, and a handle back', async () => {
    const { again, wallet, deps, marker, record } = await failedOnce();
    wallet.behaviour = 'reject';
    const spy = counted();
    const result = await signAgainWithSolana(again, wallet, {
      ...deps,
      store: spy.store,
      release: spy.release,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'wallet_failed',
      declined: true,
      record: { orderId: record.orderId, state: 'paying' },
      attemptId: marker.attemptId,
    });
    expect(result).not.toHaveProperty('afterMarker');
    expect(result.ok === false && result.again !== undefined).toBe(true);
    expect(spy.calls.clearMarker).toBe(0);
    expect(spy.calls.released).toEqual([]);
    expect((await stored(record.orderId)).marker?.attemptId).toBe(marker.attemptId);
    // Asked again at once, the same wallet pays the same attempt.
    wallet.behaviour = 'sign';
    if (result.ok || result.again === undefined) {
      throw new Error('no handle');
    }
    expect(await signAgainWithSolana(result.again, wallet, deps)).toMatchObject({ ok: true });
  });

  it('still releases a decline on a first ask, with no handle', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'reject';
    const spy = counted();
    const result = await payWithSolana(record, wallet, input, {
      ...deps,
      store: spy.store,
      release: spy.release,
    });
    expect(spy.calls.released).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      reason: 'rejected',
      attemptId: spy.calls.released[0],
    });
    expect(result).not.toHaveProperty('again');
    expect(result).not.toHaveProperty('declined');
    expect(spy.calls.clearMarker).toBe(1);
  });

  it('hands a handle back when the wallet fails again', async () => {
    const { again, wallet, deps, marker } = await failedOnce();
    wallet.behaviour = 'throw';
    const result = await signAgainWithSolana(again, wallet, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'wallet_failed',
      attemptId: marker.attemptId,
    });
    expect(result).not.toHaveProperty('declined');
    expect(result.ok === false ? result.again?.attemptId : undefined).toBe(marker.attemptId);
  });

  it('sends nothing when the reference shows a transaction once the wallet answered', async () => {
    const { again, wallet, chain, deps, marker, record } = await failedOnce();
    const spy = counted();
    wallet.duringPrompt = async () => {
      chain.extraListed = [
        { signature: signatureOf(1), failed: false, slot: BigInt(marker.slot ?? '0') },
      ];
    };
    const result = await signAgainWithSolana(again, wallet, { ...deps, store: spy.store });
    expect(result).toMatchObject({
      ok: false,
      reason: 'still_waiting',
      record: { orderId: record.orderId, state: 'paying' },
      afterMarker: true,
      signedNotSent: true,
      attemptId: marker.attemptId,
    });
    expect(result).not.toHaveProperty('again');
    expect(spy.calls.updateMarker).toBe(0);
    expect(chain.sent).toEqual([]);
    expect((await stored(record.orderId)).marker).not.toHaveProperty('signature');
  });

  it('sends nothing when the reference cannot be read once the wallet answered', async () => {
    const { again, wallet, chain, deps, marker, record } = await failedOnce();
    const spy = counted();
    wallet.duringPrompt = async () => {
      chain.listingFails = true;
    };
    const result = await signAgainWithSolana(again, wallet, { ...deps, store: spy.store });
    expect(result).toMatchObject({
      ok: false,
      reason: 'rpc_error',
      record: { orderId: record.orderId, state: 'paying' },
      afterMarker: true,
      signedNotSent: true,
      attemptId: marker.attemptId,
    });
    expect(result).not.toHaveProperty('again');
    expect(spy.calls.updateMarker).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it('names its attempt when every write of the answer lost, and sends nothing', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    const spy = counted();
    spy.store.updateMarker = async () => ({ ok: false, reason: 'conflict' });
    const result = await signAgainWithSolana(again, wallet, { ...deps, store: spy.store });
    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      record: { orderId: again.orderId },
      attemptId: marker.attemptId,
    });
    expect(chain.sent).toEqual([]);
  });

  it('judges the whole page, newest first: a new row above an older one holds the ask', async () => {
    const before = await failedOnce();
    const beforeSlot = BigInt(before.marker.slot ?? '0');
    before.chain.extraListed = [
      { signature: signatureOf(1), failed: false, slot: beforeSlot },
      { signature: signatureOf(2), failed: false, slot: beforeSlot - 1n },
    ];
    expect(await signAgainWithSolana(before.again, before.wallet, before.deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    expect(before.wallet.requests).toBe(1);
    const after = await failedOnce();
    const afterSlot = BigInt(after.marker.slot ?? '0');
    after.wallet.duringPrompt = async () => {
      after.chain.extraListed = [
        { signature: signatureOf(1), failed: false, slot: afterSlot },
        { signature: signatureOf(2), failed: false, slot: afterSlot - 1n },
      ];
    };
    expect(await signAgainWithSolana(after.again, after.wallet, after.deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
      signedNotSent: true,
    });
    expect(after.chain.sent).toEqual([]);
  });

  it('lists the reference at confirmed: a row not finalized yet still holds the ask', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    chain.extraListed = [
      {
        signature: signatureOf(1),
        failed: false,
        slot: BigInt(marker.slot ?? '0'),
        unfinalized: true,
      },
    ];
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    expect(wallet.requests).toBe(1);
  });

  it('refuses a closed order as not payable before it looks at the account', async () => {
    const { again, deps, record } = await failedOnce();
    await tamper(record.orderId, (current) => ({
      ...current,
      status: { status: 'cancelled', at: NOW + 40 },
    }));
    const other = await FakeWallet.create();
    const result = await signAgainWithSolana(again, other, deps);
    expect(result).toMatchObject({ ok: false, reason: 'not_payable' });
    expect(result).not.toHaveProperty('again');
    expect(result).not.toHaveProperty('afterMarker');
    expect(other.requests).toBe(0);
  });

  it('lists the reference before the fee check: a landed transaction is no funds note', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce({
      lamports: EMPTY_ACCOUNT_RENT + 100_000n,
    });
    wallet.behaviour = 'raise_price';
    wallet.duringPrompt = async () => {
      chain.extraListed = [
        { signature: signatureOf(1), failed: false, slot: BigInt(marker.slot ?? '0') },
      ];
    };
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
  });

  it('never releases in again mode: a fee it cannot cover, a lost write', async () => {
    const short = await failedOnce({ lamports: EMPTY_ACCOUNT_RENT + 100_000n });
    short.wallet.behaviour = 'raise_price';
    const spy = counted();
    const result = await signAgainWithSolana(short.again, short.wallet, {
      ...short.deps,
      store: spy.store,
      release: spy.release,
      reserve: spy.reserve,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'insufficient_sol',
      afterMarker: true,
      signedNotSent: true,
      attemptId: short.marker.attemptId,
    });
    expect(result).not.toHaveProperty('again');
    expect(short.chain.sent).toEqual([]);
    const lost = await failedOnce();
    const conflicting = counted();
    conflicting.store.updateMarker = async () => ({ ok: false, reason: 'not_ready' });
    expect(
      await signAgainWithSolana(lost.again, lost.wallet, {
        ...lost.deps,
        store: conflicting.store,
        release: conflicting.release,
        reserve: conflicting.reserve,
      }),
    ).toMatchObject({ ok: false, reason: 'conflict', attemptId: lost.marker.attemptId });
    expect([...spy.calls.released, ...conflicting.calls.released]).toEqual([]);
    expect(spy.calls.reserved + conflicting.calls.reserved).toBe(0);
    expect(lost.chain.sent).toEqual([]);
  });

  it('marks a first ask whose wallet signed a fee it cannot cover as live and not sent', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    wallet.behaviour = 'raise_price';
    chain.lamports = EMPTY_ACCOUNT_RENT + 100_000n;
    const result = await payWithSolana(record, wallet, input, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'insufficient_sol',
      afterMarker: true,
      signedNotSent: true,
      attemptId: (await stored(record.orderId)).marker?.attemptId,
    });
    // Refused before the marker: nothing live, nothing to say about it.
    const before = await setup();
    before.chain.lamports = 1n;
    const refused = await payWithSolana(before.record, before.wallet, before.input, before.deps);
    expect(refused).toMatchObject({ ok: false, reason: 'insufficient_sol' });
    expect(refused).not.toHaveProperty('afterMarker');
    expect(refused).not.toHaveProperty('signedNotSent');
    expect(refused).not.toHaveProperty('attemptId');
  });

  it('never records the answer on an attempt another tab started meanwhile', async () => {
    const { again, wallet, chain, deps, record } = await failedOnce();
    wallet.duringPrompt = async () => {
      const current = await stored(record.orderId);
      if (current.marker === undefined) {
        throw new Error('no marker');
      }
      const replaced = await store.updateMarker(
        current.orderId,
        current.version,
        current.marker.attemptId,
        { ...current.marker, attemptId: 'other-tab-attempt' },
      );
      if (!replaced.ok) {
        throw new Error(replaced.reason);
      }
    };
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'conflict',
      // The attempt this call worked on, never the one read back.
      attemptId: again.attemptId,
      signedNotSent: true,
    });
    const after = await stored(record.orderId);
    expect(after.marker?.attemptId).toBe('other-tab-attempt');
    expect(after.marker).not.toHaveProperty('signature');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing for an order found paid while the wallet was open', async () => {
    const { again, wallet, chain, deps, record } = await failedOnce();
    wallet.duringPrompt = async () => {
      const current = await stored(record.orderId);
      await store.update(current.orderId, current.version, {
        state: 'paid',
        paidTx: signatureOf(9),
        paidAt: NOW + 40,
      });
    };
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(chain.sent).toEqual([]);
  });

  it('asks nothing for a handle it did not give out, or a copy of one', async () => {
    const { again, wallet, deps } = await failedOnce();
    for (const handle of [{ ...again }, { orderId: again.orderId, attemptId: 'x', payer: 'y' }]) {
      expect(await signAgainWithSolana(handle, wallet, deps)).toEqual({
        ok: false,
        reason: 'not_payable',
      });
    }
    expect(wallet.requests).toBe(1);
  });

  it('asks nothing unless the stored attempt is still exactly the handle’s', async () => {
    const otherPayee = solanaAddress();
    const otherReference = solanaAddress();
    const cases: [string, (run: Awaited<ReturnType<typeof failedOnce>>) => Promise<void>][] = [
      [
        'another attempt',
        async ({ record }) =>
          tamper(record.orderId, (current) =>
            current.marker === undefined
              ? current
              : { ...current, marker: { ...current.marker, attemptId: 'other' } },
          ),
      ],
      [
        'a signature set',
        async ({ record, marker }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            marker: { ...marker, signature: signatureOf(3) },
          })),
      ],
      [
        'not paying',
        async ({ record }) => tamper(record.orderId, (current) => ({ ...current, state: 'paid' })),
      ],
      [
        'closed by the store',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            status: { status: 'cancelled', at: NOW + 40 },
          })),
      ],
      [
        'a marker without its slot',
        async ({ record, marker }) =>
          tamper(record.orderId, (current) => {
            const { slot: _slot, ...rest } = marker;
            return { ...current, marker: rest };
          }),
      ],
      [
        'another blockhash',
        async ({ record, marker }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            marker: { ...marker, blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' },
          })),
      ],
      [
        'another last valid height',
        async ({ record, marker }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            marker: {
              ...marker,
              lastValidBlockHeight: (BigInt(marker.lastValidBlockHeight) + 1n).toString(),
            },
          })),
      ],
      [
        'a record its stored request does not pay',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            payout: { ...current.payout, address: otherPayee },
          })),
      ],
      [
        'no stored request',
        async ({ record }) =>
          tamper(record.orderId, (current) => {
            const { paymentRequest: _request, ...rest } = current;
            return rest;
          }),
      ],
      [
        'a payout no coin is known for',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            payout: { ...current.payout, caip19: 'solana:unknown/token:nothing' },
          })),
      ],
      [
        'another payee, record and request together',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            payout: { ...current.payout, address: otherPayee },
            paymentRequest: JSON.stringify({
              ...storedSolanaRequest(current),
              recipient: otherPayee,
            }),
          })),
      ],
      [
        'another amount, record and request together',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            amount: (PRICE + 1n).toString(),
            paymentRequest: JSON.stringify({
              ...storedSolanaRequest(current),
              amount: Number(PRICE + 1n),
            }),
          })),
      ],
      [
        'another reference, record and request together',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            reference: otherReference,
            paymentRequest: JSON.stringify({
              ...storedSolanaRequest(current),
              reference: otherReference,
            }),
          })),
      ],
      [
        'another mint, record and request together',
        async ({ record }) =>
          tamper(record.orderId, (current) => ({
            ...current,
            payout: {
              ...current.payout,
              caip19: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${USDC_SOLANA_MAINNET.mint ?? ''}`,
            },
            paymentRequest: JSON.stringify({
              ...storedSolanaRequest(current),
              network: 'mainnet',
              asset: USDC_SOLANA_MAINNET,
            }),
          })),
      ],
    ];
    for (const [name, change] of cases) {
      const run = await failedOnce();
      await change(run);
      const calls = run.chain.calls.length;
      expect({ name, result: await signAgainWithSolana(run.again, run.wallet, run.deps) }).toEqual({
        name,
        result: {
          ok: false,
          reason: 'not_payable',
          record: await stored(run.record.orderId),
          attemptId: run.marker.attemptId,
        },
      });
      expect({ name, requests: run.wallet.requests }).toEqual({ name, requests: 1 });
      // Refused before any chain read.
      expect({ name, reads: run.chain.calls.length }).toEqual({ name, reads: calls });
    }
  });

  it('judges the account before it reads the chain', async () => {
    const { again, chain, deps, marker } = await failedOnce();
    chain.blockHeightFails = true;
    const other = await FakeWallet.create();
    const calls = chain.calls.length;
    expect(await signAgainWithSolana(again, other, deps)).toMatchObject({
      ok: false,
      reason: 'other_payer',
      attemptId: marker.attemptId,
    });
    expect(chain.calls.slice(calls)).toEqual([]);
  });

  it('asks nothing of another account, and the handle stays usable', async () => {
    const { again, wallet, deps, marker } = await failedOnce();
    const other = await FakeWallet.create();
    const result = await signAgainWithSolana(again, other, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'other_payer',
      afterMarker: true,
      attemptId: marker.attemptId,
      again,
    });
    expect(other.requests).toBe(0);
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({ ok: true });
  });

  it('asks nothing once the blockhash is within the margin of its end', async () => {
    const edge = await failedOnce();
    // The confirmed tip at exactly the last valid height minus 40: too close.
    edge.chain.advance(BigInt(edge.marker.lastValidBlockHeight) - 40n - edge.chain.height - 32n);
    const result = await signAgainWithSolana(edge.again, edge.wallet, edge.deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'request_expiring',
      afterMarker: true,
      attemptId: edge.marker.attemptId,
    });
    expect(result).not.toHaveProperty('again');
    expect(edge.wallet.requests).toBe(1);
    // Judged before the reference is listed: a listing that throws, or that shows a row,
    // never turns it into a failed read or a transaction seen.
    for (const listing of ['throws', 'shows a row'] as const) {
      const late = await failedOnce();
      late.chain.advance(BigInt(late.marker.lastValidBlockHeight) - 40n - late.chain.height - 32n);
      if (listing === 'throws') {
        late.chain.listingFails = true;
      } else {
        late.chain.extraListed = [
          { signature: signatureOf(1), failed: false, slot: BigInt(late.marker.slot ?? '0') },
        ];
      }
      const calls = late.chain.calls.length;
      const refused = await signAgainWithSolana(late.again, late.wallet, late.deps);
      expect({ listing, reason: refused.ok ? 'paid' : refused.reason }).toEqual({
        listing,
        reason: 'request_expiring',
      });
      expect(refused).not.toHaveProperty('again');
      expect({
        listing,
        listed: late.chain.calls.slice(calls).includes('getSignaturesForAddress'),
      }).toEqual({ listing, listed: false });
    }
    // One block earlier it is still asked.
    const inside = await failedOnce();
    inside.chain.advance(
      BigInt(inside.marker.lastValidBlockHeight) - 41n - inside.chain.height - 32n,
    );
    expect(await signAgainWithSolana(inside.again, inside.wallet, inside.deps)).toMatchObject({
      ok: true,
    });
  });

  it('asks nothing when the height cannot be read, and keeps the handle', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    chain.blockHeightFails = true;
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'rpc_error',
      afterMarker: true,
      attemptId: marker.attemptId,
      again,
    });
    expect(wallet.requests).toBe(1);
  });

  it('asks nothing while the reference lists anything since the attempt began', async () => {
    for (const failed of [false, true]) {
      const { again, wallet, chain, deps, marker } = await failedOnce();
      chain.extraListed = [{ signature: signatureOf(1), failed, slot: BigInt(marker.slot ?? '0') }];
      const result = await signAgainWithSolana(again, wallet, deps);
      expect(result).toMatchObject({
        ok: false,
        reason: 'still_waiting',
        afterMarker: true,
        attemptId: marker.attemptId,
      });
      expect(result).not.toHaveProperty('again');
      expect(result).not.toHaveProperty('signedNotSent');
      expect(wallet.requests).toBe(1);
    }
  });

  it('counts a full page of the reference as a transaction, never as clean', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    chain.extraListed = Array.from({ length: 1000 }, (_, index) => ({
      signature: signatureOf(index + 10),
      failed: true,
      slot: BigInt(marker.slot ?? '0') + 1n,
    }));
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'still_waiting',
    });
    expect(wallet.requests).toBe(1);
  });

  it('ignores what the reference listed before the attempt began', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    chain.extraListed = [
      { signature: signatureOf(1), failed: false, slot: BigInt(marker.slot ?? '0') - 1n },
    ];
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({ ok: true });
  });

  it('asks nothing when the reference cannot be read, and keeps the handle', async () => {
    const { again, wallet, chain, deps, marker } = await failedOnce();
    chain.listingFails = true;
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'rpc_error',
      afterMarker: true,
      attemptId: marker.attemptId,
      again,
    });
    expect(wallet.requests).toBe(1);
  });

  it('asks nothing once the caller says no, right before the wallet', async () => {
    const { again, wallet, deps, marker } = await failedOnce();
    let asked = 0;
    const result = await signAgainWithSolana(again, wallet, {
      ...deps,
      mayAsk: () => {
        asked += 1;
        return false;
      },
    });
    expect(result).toEqual({
      ok: false,
      reason: 'not_payable',
      record: await stored(again.orderId),
      attemptId: marker.attemptId,
    });
    expect(asked).toBe(1);
    expect(wallet.requests).toBe(1);
    expect(await signAgainWithSolana(again, wallet, { ...deps, mayAsk: () => true })).toMatchObject(
      { ok: true },
    );
  });

  it('names the attempt on every refusal after its marker, and live only where it is', async () => {
    const { record, wallet, deps, input } = await setup();
    wallet.behaviour = 'throw';
    const failed = await payWithSolana(record, wallet, input, deps);
    const attemptId = (await stored(record.orderId)).marker?.attemptId;
    expect(failed).toMatchObject({ ok: false, reason: 'wallet_failed', attemptId });
    expect(failed).not.toHaveProperty('afterMarker');
    expect(failed).not.toHaveProperty('signedNotSent');
  });

  it('reads no caller veto and lists nothing on a first ask', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    // Spam under the reference, newer than any attempt: a first ask is not held by it.
    chain.extraListed = [{ signature: signatureOf(1), failed: true, slot: 10n ** 12n }];
    const paid = await payWithSolana(record, wallet, input, { ...deps, mayAsk: () => false });
    expect(paid).toMatchObject({ ok: true });
    expect(chain.sent).toHaveLength(1);
  });

  it('never asks again with any handle of an attempt whose wallet signed', async () => {
    const cases: [string, (run: Awaited<ReturnType<typeof failedOnce>>) => void][] = [
      [
        'the reference could not be read after the answer',
        (run) => {
          run.wallet.duringPrompt = async () => {
            run.chain.listingFails = true;
          };
        },
      ],
      [
        'the fee the wallet signed could not be covered',
        (run) => {
          run.wallet.behaviour = 'raise_price';
        },
      ],
      [
        'the wallet changed the transaction',
        (run) => {
          run.wallet.behaviour = 'swap_blockhash';
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const run = await failedOnce(
        name.startsWith('the fee') ? { lamports: EMPTY_ACCOUNT_RENT + 100_000n } : {},
      );
      arrange(run);
      const answered = await signAgainWithSolana(run.again, run.wallet, run.deps);
      expect({ name, ok: answered.ok }).toEqual({ name, ok: false });
      run.wallet.behaviour = 'sign';
      run.wallet.duringPrompt = undefined;
      run.chain.listingFails = false;
      run.chain.lamports = 1_000_000_000n;
      expect({ name, again: await signAgainWithSolana(run.again, run.wallet, run.deps) }).toEqual({
        name,
        again: { ok: false, reason: 'not_payable' },
      });
      expect({ name, requests: run.wallet.requests }).toEqual({ name, requests: 2 });
      expect({ name, sent: run.chain.sent }).toEqual({ name, sent: [] });
    }
  });

  it('shares the attempt’s asks between the first handle and one an again call handed back', async () => {
    for (const behaviour of ['reject', 'throw'] as const) {
      const signedOnce = await failedOnce();
      signedOnce.wallet.behaviour = behaviour;
      const handedBack = await signAgainWithSolana(
        signedOnce.again,
        signedOnce.wallet,
        signedOnce.deps,
      );
      if (handedBack.ok || handedBack.again === undefined) {
        throw new Error('expected a handle back');
      }
      const second = handedBack.again;
      // The first handle signs; the answer is not sent (the reference could not be read).
      signedOnce.wallet.behaviour = 'sign';
      signedOnce.wallet.duringPrompt = async () => {
        signedOnce.chain.listingFails = true;
      };
      expect(
        await signAgainWithSolana(signedOnce.again, signedOnce.wallet, signedOnce.deps),
      ).toMatchObject({ ok: false, reason: 'rpc_error', signedNotSent: true });
      signedOnce.wallet.duringPrompt = undefined;
      signedOnce.chain.listingFails = false;
      expect({
        behaviour,
        result: await signAgainWithSolana(second, signedOnce.wallet, signedOnce.deps),
      }).toEqual({ behaviour, result: { ok: false, reason: 'not_payable' } });
      expect({ behaviour, requests: signedOnce.wallet.requests }).toEqual({
        behaviour,
        requests: 3,
      });
      expect(signedOnce.chain.sent).toEqual([]);
      // Two calls at once, one with each handle: the wallet is asked once.
      const together = await failedOnce();
      together.wallet.behaviour = behaviour;
      const back = await signAgainWithSolana(together.again, together.wallet, together.deps);
      if (back.ok || back.again === undefined) {
        throw new Error('expected a handle back');
      }
      together.wallet.behaviour = 'sign';
      const results = await Promise.all([
        signAgainWithSolana(together.again, together.wallet, together.deps),
        signAgainWithSolana(back.again, together.wallet, together.deps),
      ]);
      expect({ behaviour, oks: results.map((result) => result.ok) }).toEqual({
        behaviour,
        oks: [true, false],
      });
      expect({ behaviour, requests: together.wallet.requests }).toEqual({ behaviour, requests: 3 });
      expect(together.chain.sent).toHaveLength(1);
    }
  });

  it('asks the wallet once for two calls with one handle at a time', async () => {
    const { again, wallet, chain, deps } = await failedOnce();
    const [first, second] = await Promise.all([
      signAgainWithSolana(again, wallet, deps),
      signAgainWithSolana(again, wallet, deps),
    ]);
    expect([first.ok, second]).toEqual([true, { ok: false, reason: 'not_payable' }]);
    expect(wallet.requests).toBe(2);
    expect(chain.sent).toHaveLength(1);
  });

  it('keeps an old handle usable after a failure or a decline that signed nothing', async () => {
    for (const behaviour of ['throw', 'reject'] as const) {
      const { again, wallet, deps } = await failedOnce();
      wallet.behaviour = behaviour;
      expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
        ok: false,
        reason: 'wallet_failed',
      });
      // A call that ended with no signature lets the next one ask.
      wallet.behaviour = 'sign';
      expect({ behaviour, result: (await signAgainWithSolana(again, wallet, deps)).ok }).toEqual({
        behaviour,
        result: true,
      });
    }
  });

  it('lets the next call ask after one that threw before the wallet answered', async () => {
    const { again, wallet, deps } = await failedOnce();
    const throwing = Object.create(store) as OrderStore;
    throwing.get = async () => {
      throw new Error('storage failed');
    };
    await expect(signAgainWithSolana(again, wallet, { ...deps, store: throwing })).rejects.toThrow(
      'storage failed',
    );
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({ ok: true });
  });

  it('exports the store’s own closed predicate', () => {
    expect(storeClosed({ status: { status: 'cancelled', at: NOW } })).toBe(true);
    expect(storeClosed({ status: { status: 'completed', at: NOW } })).toBe(true);
    expect(storeClosed({ status: { status: 'pending', at: NOW } })).toBe(false);
    expect(storeClosed({})).toBe(false);
  });
});
