/**
 * Paying a Solana order that carries the protocol fee: the plan at every
 * decision point, the two bound legs, and the split the merchant node may
 * still credit.
 */
import { FeeConfigError, type FeeTerms, type PaymentRequestData } from '@elisym/pay-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_SECS, MERCHANT_CATCH_UP_SECS } from '../../src/buyer/constants';
import { type LoadedOffer, loadOffer } from '../../src/buyer/offer';
import { placeOrder } from '../../src/buyer/order-flow';
import type { OrderRecord } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import {
  type SolanaPayDeps,
  checkBeforePaying,
  composeOrderPayment,
  endSolanaOrder,
  merchantMayStillCredit,
  payWithSolana,
  signAgainWithSolana,
  storedSolanaRequest,
  watchSolanaPayment,
} from '../../src/buyer/solana-pay';
import { MemoryRelays, NOW, inboxList, makeShop, solanaAddress } from './fixtures';
import { FakeSolana, FakeWallet } from './solana-fixtures';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
/** $49 in devnet USDC subunits. */
const PRICE = 49_000_000n;
/** 3% of the price, rounded up. */
const FEE = 1_470_000n;
/** The merchant node's floor: the price less 10%. */
const FLOOR = 44_100_000n;
const TREASURY = solanaAddress();

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;
/** The store's backend: a test may write a record directly, past every rule. */
let backend: MemoryOrderBackend;

beforeEach(() => {
  backend = new MemoryOrderBackend();
  store = new OrderStore(backend);
});

/** Fee terms a test can change between calls. */
function termsSource(initial: FeeTerms | Error) {
  const source = {
    current: initial,
    asked: 0,
    read: async (_chain: string): Promise<FeeTerms> => {
      source.asked += 1;
      if (source.current instanceof Error) {
        throw source.current;
      }
      return source.current;
    },
  };
  return source;
}

const AT_3_PERCENT: FeeTerms = { feeBps: 300, treasury: TREASURY };
const AT_ZERO: FeeTerms = { feeBps: 0, treasury: '' };

async function setup(options: { fee?: boolean; terms?: FeeTerms | Error; compose?: boolean } = {}) {
  const shop = makeShop({ fee: options.fee ?? true });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const offer = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['solana'],
    now: NOW,
  });
  if (!offer.ok) {
    throw new Error(offer.message);
  }
  const fresh: Ready = offer;
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
  const terms = termsSource(options.terms ?? AT_3_PERCENT);
  const wallet = await FakeWallet.create();
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.treasury = TREASURY;
  chain.blockTime = NOW + 60;
  const now = { value: NOW + 30 };
  const deps: SolanaPayDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpc: chain.rpc,
    now: () => now.value,
    feeTerms: terms.read,
  };
  let record = placed.record;
  if (options.compose !== false) {
    const composed = await composeOrderPayment(record, store, {
      offer: fresh.offer,
      feeTerms: terms.read,
      payer: wallet.address,
    });
    if (!composed.ok) {
      throw new Error(composed.reason);
    }
    record = composed.record;
  }
  const input = { fresh, chainTime: NOW + 30 };
  return { shop, relays, fresh, record, wallet, chain, deps, input, terms, now };
}

async function stored(orderId: string): Promise<OrderRecord> {
  const record = await store.get(orderId);
  if (record === undefined) {
    throw new Error('no record');
  }
  return record;
}

describe('composing a fee-bearing request', () => {
  it('adds the fee leg for a store that declares fee support; the total stays the price', async () => {
    const { record } = await setup();
    expect(storedSolanaRequest(record)).toMatchObject({
      amount: Number(PRICE),
      fee_address: TREASURY,
      fee_amount: Number(FEE),
    });
  });

  it('composes the fee-less request byte for byte at a zero fee', async () => {
    const { record } = await setup({ terms: AT_ZERO });
    const request = storedSolanaRequest(record);
    expect(request).toBeDefined();
    expect(request && 'fee_address' in request).toBe(false);
    expect(request && 'fee_amount' in request).toBe(false);
  });

  it('composes nothing for a store whose node cannot take a split, and the order can end', async () => {
    // The fee went from 0 to above 0 between the order and the compose.
    const { record, fresh, deps, terms } = await setup({ fee: false, compose: false });
    terms.current = AT_3_PERCENT;
    const composed = await composeOrderPayment(record, store, {
      offer: fresh.offer,
      feeTerms: terms.read,
    });
    expect(composed).toEqual({ ok: false, reason: 'store_outdated' });
    const kept = await stored(record.orderId);
    expect(kept.paymentRequest).toBeUndefined();
    expect(kept.version).toBe(record.version);
    // Nothing was requested: the order ends at once, releasing the product.
    expect(await endSolanaOrder(kept, deps)).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid' },
    });
  });

  it('leaves the record as it is when the fee terms cannot be used', async () => {
    for (const [error, reason] of [
      [new FeeConfigError('unavailable', 'down'), 'fee_config_unavailable'],
      [new FeeConfigError('wrong_cluster', 'devnet'), 'fee_config_invalid'],
    ] as const) {
      const { record, fresh, terms } = await setup({ compose: false });
      terms.current = error;
      expect(
        await composeOrderPayment(record, store, { offer: fresh.offer, feeTerms: terms.read }),
      ).toEqual({ ok: false, reason });
      expect((await stored(record.orderId)).version).toBe(record.version);
    }
  });

  it('gives no fee leg when the payout is the treasury: no spurious change later', async () => {
    const { shop, record, fresh, wallet, chain, deps, input, terms } = await setup({
      compose: false,
    });
    terms.current = { feeBps: 300, treasury: shop.payout };
    const composed = await composeOrderPayment(record, store, {
      offer: fresh.offer,
      feeTerms: terms.read,
    });
    if (!composed.ok) {
      throw new Error(composed.reason);
    }
    expect(storedSolanaRequest(composed.record)?.fee_amount).toBeUndefined();
    const paid = await payWithSolana(composed.record, wallet, input, deps);
    expect(paid).toMatchObject({ ok: true });
    expect(chain.sent).toHaveLength(1);
  });

  it('gives no fee leg when the paying wallet is the treasury: it pays with no spurious change', async () => {
    // A store with fee support (no leg is no offer_changed) and one without (no store_outdated).
    for (const fee of [true, false]) {
      const { record, fresh, wallet, chain, deps, input, terms } = await setup({
        fee,
        compose: false,
      });
      terms.current = { feeBps: 300, treasury: wallet.address };
      const composed = await composeOrderPayment(record, store, {
        offer: fresh.offer,
        feeTerms: terms.read,
        payer: wallet.address,
      });
      if (!composed.ok) {
        throw new Error(composed.reason);
      }
      expect(storedSolanaRequest(composed.record)?.fee_amount).toBeUndefined();
      expect(await payWithSolana(composed.record, wallet, input, deps)).toMatchObject({ ok: true });
      expect(chain.sent).toHaveLength(1);
    }
  });
});

describe('paying with a fee leg', () => {
  it('pays both legs bound to the order, write-locking the treasury in the fee estimate', async () => {
    const { record, wallet, chain, deps, input } = await setup();
    const paid = await payWithSolana(record, wallet, input, deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    const treasuryAccount = await FakeSolana.usdcAccount(TREASURY);
    expect(chain.priorityAccounts.at(-1)).toContain(treasuryAccount);
    const watched = await watchSolanaPayment(paid.record, deps);
    expect(watched).toMatchObject({ state: 'paid', record: { paidTx: paid.signature } });
  });

  it('asks no treasury account in the estimate when there is no fee leg', async () => {
    const { record, wallet, chain, deps, input } = await setup({ terms: AT_ZERO });
    await payWithSolana(record, wallet, input, deps);
    expect(chain.priorityAccounts.at(-1)).not.toContain(await FakeSolana.usdcAccount(TREASURY));
    expect(chain.priorityAccounts.at(-1)).toHaveLength(2);
  });

  it('sends nothing whose payee leg or treasury leg the wallet changed', async () => {
    for (const behaviour of [
      'change_amount',
      'lower_fee_leg',
      'raise_payee_leg',
      'raise_fee_leg',
      'payee_leg_full_price',
    ] as const) {
      const { record, wallet, chain, deps, input } = await setup();
      wallet.behaviour = behaviour;
      expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
        ok: false,
        reason: 'wallet_unsupported',
        detail: 'not_bound',
      });
      expect(chain.sent).toEqual([]);
    }
  });

  it('re-plans before signing: a changed fee is offer_changed, never not_payable', async () => {
    // A fee-0 request stored, then the fee raised before the first pay.
    const raised = await setup({ terms: AT_ZERO });
    raised.terms.current = AT_3_PERCENT;
    expect(
      await payWithSolana(raised.record, raised.wallet, raised.input, raised.deps),
    ).toMatchObject({ ok: false, reason: 'offer_changed', record: { state: 'ordered' } });
    expect(raised.wallet.requests).toBe(0);
    // The same, for a store whose node cannot take a split.
    const outdated = await setup({ fee: false, terms: AT_ZERO });
    outdated.terms.current = AT_3_PERCENT;
    expect(
      await payWithSolana(outdated.record, outdated.wallet, outdated.input, outdated.deps),
    ).toMatchObject({ ok: false, reason: 'store_outdated' });
    // A stored fee leg and another rate now.
    const moved = await setup();
    moved.terms.current = { feeBps: 200, treasury: TREASURY };
    expect(await payWithSolana(moved.record, moved.wallet, moved.input, moved.deps)).toMatchObject({
      ok: false,
      reason: 'offer_changed',
    });
    // ... or another treasury.
    const rotated = await setup();
    rotated.terms.current = { feeBps: 300, treasury: solanaAddress() };
    expect(
      await checkBeforePaying(rotated.record, rotated.wallet.address, rotated.input, rotated.deps),
    ).toMatchObject({ ok: false, reason: 'offer_changed' });
  });

  it('signs nothing and leaves the record when the terms cannot be read before paying', async () => {
    for (const [error, reason] of [
      [new FeeConfigError('unavailable', 'down'), 'fee_config_unavailable'],
      [new FeeConfigError('bad_config', 'bad'), 'fee_config_invalid'],
    ] as const) {
      const { record, wallet, deps, input, terms } = await setup();
      terms.current = error;
      expect(await payWithSolana(record, wallet, input, deps)).toMatchObject({
        ok: false,
        reason,
        record: { state: 'ordered' },
      });
      expect(wallet.requests).toBe(0);
      const kept = await stored(record.orderId);
      expect(kept.marker).toBeUndefined();
      expect(kept.version).toBe(record.version);
    }
  });
});

describe('a split the merchant node may still credit', () => {
  /** An attempt the wallet failed (marker set, nothing sent), expired at finalized. */
  async function expiredAttempt(options: { terms?: FeeTerms } = {}) {
    const run = await setup(options);
    run.wallet.behaviour = 'throw';
    await payWithSolana(run.record, run.wallet, run.input, run.deps);
    run.chain.expire();
    const record = await stored(run.record.orderId);
    const request = storedSolanaRequest(record);
    if (request === undefined) {
      throw new Error('no request');
    }
    return { ...run, record, request };
  }

  function withoutFee(request: PaymentRequestData, amount: bigint): PaymentRequestData {
    const { fee_address: _feeAddress, fee_amount: _feeAmount, ...rest } = request;
    return { ...rest, amount: Number(amount) };
  }

  const AFTER_CATCH_UP = NOW + MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS + 1;

  it('counts the whole price to the payee with no fee leg as paid', async () => {
    const { record, request, chain, deps } = await expiredAttempt();
    const signature = await chain.injectPayment(withoutFee(request, PRICE));
    expect(await watchSolanaPayment(record, deps)).toMatchObject({
      state: 'paid',
      record: { paidTx: signature },
    });
  });

  it('holds the price less the fee with an unbound treasury leg, until the catch-up is over', async () => {
    const { record, request, chain, deps, now } = await expiredAttempt();
    // Both legs paid, the fee leg without the order's markers.
    await chain.injectPayment(request);
    expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'waiting' });
    expect(await endSolanaOrder(record, deps)).toMatchObject({ ended: false });
    now.value = AFTER_CATCH_UP;
    expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'over' });
  });

  it('holds a payee leg between the floor and the price, for a fee-less request too', async () => {
    for (const terms of [AT_3_PERCENT, AT_ZERO]) {
      const { record, request, chain, deps, now } = await expiredAttempt({ terms });
      await chain.injectPayment(withoutFee(request, FLOOR));
      expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'waiting' });
      now.value = AFTER_CATCH_UP;
      expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'over' });
    }
  });

  it('still holds on the last second of the catch-up and lets go one second later', async () => {
    const { record, request, chain, deps, now } = await expiredAttempt();
    await chain.injectPayment(withoutFee(request, FLOOR));
    expect(record.createdAt).toBe(NOW);
    now.value = AFTER_CATCH_UP - 1;
    expect(merchantMayStillCredit(record, now.value)).toBe(true);
    expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'waiting' });
    now.value = AFTER_CATCH_UP;
    expect(merchantMayStillCredit(record, now.value)).toBe(false);
    expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'over' });
  });

  it('ends a payee leg below the floor as unpaid at once', async () => {
    const { record, request, chain, deps } = await expiredAttempt();
    await chain.injectPayment(withoutFee(request, FLOOR - 1n));
    expect(await watchSolanaPayment(record, deps)).toMatchObject({ state: 'over' });
  });

  it('counts a split with both legs bound as paid', async () => {
    const { record, request, chain, deps } = await expiredAttempt();
    const signature = await chain.injectPayment(request, { bindFeeLeg: true });
    expect(await watchSolanaPayment(record, deps)).toMatchObject({
      state: 'paid',
      record: { paidTx: signature },
    });
  });
});

describe('asking the same wallet again for a fee-bearing order', () => {
  /** A first ask the wallet failed (not a decline): the attempt is live, with its handle. */
  async function failedOnce(options: { terms?: FeeTerms } = {}) {
    const run = await setup(options);
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
    return { ...run, again: failed.again, marker: waiting.marker };
  }

  /** Rewrite the stored request straight in the backend, past every rule. */
  async function tamperRequest(
    orderId: string,
    change: (request: PaymentRequestData) => PaymentRequestData,
  ) {
    const current = await stored(orderId);
    const request = storedSolanaRequest(current);
    if (request === undefined) {
      throw new Error('no request');
    }
    await backend.transactProduct(current.productAddress, () => ({
      write: [{ ...current, paymentRequest: JSON.stringify(change(request)) }],
      result: undefined,
    }));
  }

  it('pays both legs in the same attempt without reading the fee terms again', async () => {
    for (const changed of [{ feeBps: 200, treasury: solanaAddress() }, new Error('down')]) {
      const { again, wallet, chain, deps, record, terms } = await failedOnce();
      // The terms moved (or cannot be read) since the attempt was built: again binds what it signed.
      terms.current = changed;
      const asked = terms.asked;
      const paid = await signAgainWithSolana(again, wallet, deps);
      if (!paid.ok) {
        throw new Error(paid.reason);
      }
      expect(terms.asked).toBe(asked);
      expect(wallet.requests).toBe(2);
      expect(chain.sent).toHaveLength(1);
      expect(await watchSolanaPayment(await stored(record.orderId), deps)).toMatchObject({
        state: 'paid',
        record: { paidTx: paid.signature },
      });
    }
  });

  it('sends nothing when the wallet asked again lowers the fee leg', async () => {
    const { again, wallet, chain, deps } = await failedOnce();
    wallet.behaviour = 'lower_fee_leg';
    expect(await signAgainWithSolana(again, wallet, deps)).toMatchObject({
      ok: false,
      reason: 'wallet_unsupported',
      detail: 'not_bound',
    });
    expect(chain.sent).toEqual([]);
  });

  it('asks nothing when the stored fee leg is no longer the one the attempt was built on', async () => {
    const cases: [string, FeeTerms, (request: PaymentRequestData) => PaymentRequestData][] = [
      [
        'a fee leg added to a fee-less request',
        AT_ZERO,
        (request) => ({ ...request, fee_address: TREASURY, fee_amount: Number(FEE) }),
      ],
      [
        'the fee leg removed',
        AT_3_PERCENT,
        (request) => {
          const { fee_address: _feeAddress, fee_amount: _feeAmount, ...rest } = request;
          return rest;
        },
      ],
      [
        'another fee amount',
        AT_3_PERCENT,
        (request) => ({ ...request, fee_amount: Number(FEE + 1n) }),
      ],
      [
        'another treasury',
        AT_3_PERCENT,
        (request) => ({ ...request, fee_address: solanaAddress() }),
      ],
    ];
    for (const [name, terms, change] of cases) {
      const run = await failedOnce({ terms });
      await tamperRequest(run.record.orderId, change);
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
      expect({ name, reads: run.chain.calls.length }).toEqual({ name, reads: calls });
      expect({ name, sent: run.chain.sent }).toEqual({ name, sent: [] });
    }
  });
});
