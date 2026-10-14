/**
 * The Tempo watch's mirror of the merchant node's paid rule, against a
 * verifier that answers what each test says: which derived requests it is
 * asked, and what the watch makes of each answer.
 */
import type { ParsedPaymentRequestV2 } from '@elisym/pay-core';
import { CHAINS, EVM_ASSETS } from '@elisym/pay-core';
import {
  type TempoTransferLog,
  type TempoVerifyResult,
  type VerifyTempoPaymentOptions,
  composeTempoPaymentRequest,
  verifyTempoPayment,
} from '@elisym/pay-core/evm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CLOCK_SKEW_SECS, MERCHANT_CATCH_UP_SECS } from '../../src/buyer/constants';
import type { OrderRecord, PaymentMarker } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import { merchantMayStillCredit } from '../../src/buyer/solana-pay';
import {
  type TempoWatchDeps,
  endTempoOrder,
  merchantFloor,
  watchTempoPayment,
} from '../../src/buyer/tempo-pay';
import { MemoryRelays, NOW, nostrKey } from './fixtures';
import { ACKNOWLEDGED, record as contractRecord } from './order-store.contract';

vi.mock('@elisym/pay-core/evm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@elisym/pay-core/evm')>();
  return { ...actual, verifyTempoPayment: vi.fn() };
});

const verify = vi.mocked(verifyTempoPayment);

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TREASURY = '0x1111111111111111111111111111111111111111';
const MEMO = `0x${'4d'.repeat(32)}`;
const OWN_HASH = `0x${'ab'.repeat(32)}`;
const PAYEE_TX = `0x${'01'.repeat(32)}`;
const FEE_TX = `0x${'02'.repeat(32)}`;
const FULL_TX = `0x${'03'.repeat(32)}`;
const PRICE = 49_000_000n;
const ORDER_ID = '7d3f2a51-8f1b-4c7e-9a0d-2b6c4e8f1a90';
const FEE = 1_470_000n;
const FLOOR_BLOCK = '40000000';
const AFTER_CATCH_UP = NOW + MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS + 1;

interface Asked {
  request: ParsedPaymentRequestV2;
  options: VerifyTempoPaymentOptions | undefined;
}

let store: OrderStore;
let asked: Asked[];

beforeEach(() => {
  store = new OrderStore(new MemoryOrderBackend());
  asked = [];
  verify.mockReset();
});

function leg(transactionHash: string, to: string, amount: bigint): TempoTransferLog {
  return {
    token: USDCE,
    blockHash: `0x${'cd'.repeat(32)}`,
    from: PAYER,
    to,
    amount,
    memo: MEMO,
    transactionHash,
    logIndex: 0,
    blockNumber: 40_000_010,
  };
}

function verified(payee: TempoTransferLog, fee?: TempoTransferLog): TempoVerifyResult {
  return {
    outcome: 'verified',
    settlementId: `eip155:4217:${payee.transactionHash}:${MEMO}`,
    providerLeg: payee,
    ...(fee === undefined ? {} : { feeLeg: fee }),
  };
}

/**
 * The verifier answers by the derived request it is asked: the order's own
 * (`own`), the fee-less whole price (`full`), or the merchant's floor (`floor`).
 */
function answer(answers: {
  own: TempoVerifyResult;
  full?: TempoVerifyResult;
  floor?: TempoVerifyResult;
}): void {
  verify.mockImplementation(async (_client, request, options) => {
    asked.push({ request, options });
    const amount = BigInt(request.amount);
    const stored = (await store.get(ORDER_ID))?.paymentRequest ?? '{}';
    const own = JSON.parse(stored) as { amount?: string; fee_address?: string };
    // The order's own request: what is stored.
    if (request.fee_address === own.fee_address && request.amount === own.amount) {
      return answers.own;
    }
    return amount === merchantFloor(PRICE)
      ? (answers.floor ?? { outcome: 'none' })
      : (answers.full ?? { outcome: 'none' });
  });
}

const relays = new MemoryRelays([]);

function deps(now = NOW + 60): TempoWatchDeps {
  return {
    store,
    readClient: relays,
    clientFor: () => relays,
    client: { request: async () => null },
    now: () => now,
  };
}

/** A Tempo order paying under attempt `a`, with `marker` fields on top: its stored record. */
async function paying(
  options: { fee?: bigint; amount?: bigint; marker?: Partial<PaymentMarker> } = {},
): Promise<OrderRecord> {
  const amount = options.amount ?? PRICE;
  const fee = options.fee ?? FEE;
  const request = composeTempoPaymentRequest({
    chain: CHAINS.TEMPO_MAINNET,
    asset: EVM_ASSETS.find((coin) => coin.mint?.toLowerCase() === USDCE) ?? EVM_ASSETS[0],
    recipient: PAYOUT,
    amount,
    feeAmount: fee,
    treasury: fee > 0n ? TREASURY : PAYOUT,
    memo: MEMO,
    createdAt: NOW,
  });
  const storeKey = nostrKey();
  await store.add(
    contractRecord(ORDER_ID, {
      storePubkey: storeKey.pubkey,
      createdAt: NOW,
      payout: { caip19: `eip155:4217/erc20:${USDCE}`, address: PAYOUT },
      amount: amount.toString(),
      medium: 'tempo',
      reference: MEMO,
    }),
  );
  await store.update(ORDER_ID, 1, {
    state: 'ordered',
    paymentRequest: JSON.stringify(request),
    ...ACKNOWLEDGED,
  });
  const marker = { rail: 'tempo' as const, attemptId: 'a', setAt: NOW, floorBlock: FLOOR_BLOCK };
  await store.setMarker(ORDER_ID, 2, marker, NOW);
  if (options.marker !== undefined) {
    const extended = { ...marker, ...options.marker } as PaymentMarker;
    const bundleFailed = extended.rail === 'tempo' && extended.bundleFailed === true;
    if (bundleFailed) {
      await store.updateMarker(ORDER_ID, 3, 'a', { ...extended, bundleFailed: undefined });
      await store.updateMarker(ORDER_ID, 4, 'a', extended);
    } else {
      await store.updateMarker(ORDER_ID, 3, 'a', extended);
    }
  }
  const stored = await store.get(ORDER_ID);
  if (stored === undefined) {
    throw new Error('no record');
  }
  return stored;
}

describe('a verified payment', () => {
  it('is paid when the fee leg is in the payee leg’s own transaction', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(PAYEE_TX, TREASURY, FEE)) });
    const record = await paying();
    expect(await watchTempoPayment(record, deps())).toMatchObject({
      state: 'paid',
      record: { paidTx: PAYEE_TX },
    });
  });

  it('is paid when the payee leg alone reaches the price, whatever the fee leg', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE), leg(FEE_TX, TREASURY, FEE)) });
    expect(await watchTempoPayment(await paying(), deps())).toMatchObject({
      state: 'paid',
      record: { paidTx: PAYEE_TX },
    });
  });

  it('is paid with no fee leg, past the deadline', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE)) });
    expect(await watchTempoPayment(await paying({ fee: 0n }), deps(AFTER_CATCH_UP))).toMatchObject({
      state: 'paid',
      record: { paidTx: PAYEE_TX },
    });
  });

  it('holds a split across two transactions, and never stores its hash', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)) });
    const watched = await watchTempoPayment(await paying(), deps());
    expect(watched.state).toBe('unsure');
    const stored = await store.get(ORDER_ID);
    expect(stored?.paidTx).toBeUndefined();
    expect(stored?.marker?.rail === 'tempo' ? stored.marker.txHash : 'x').toBeUndefined();
    // The fee-less whole price was asked first: a full payment under the memo is paid.
    expect(asked.map((entry) => [entry.request.amount, entry.request.fee_address])).toEqual([
      [PRICE.toString(), TREASURY],
      [PRICE.toString(), undefined],
    ]);
  });

  it('pays a cross-transaction split when the same memo also carries the whole price', async () => {
    answer({
      own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)),
      full: verified(leg(FULL_TX, PAYOUT, PRICE)),
    });
    expect(await watchTempoPayment(await paying(), deps())).toMatchObject({
      state: 'paid',
      record: { paidTx: FULL_TX },
    });
  });

  it('releases a held cross-transaction split once the catch-up is over and nothing holds', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)) });
    const record = await paying();
    expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP))).state).toBe('over');
    // A live call, an unsaved hash or an unsaved bundle still holds it.
    for (const options of [
      { callPending: true },
      { pendingHash: OWN_HASH },
      { pendingBundleId: 'bundle' },
    ]) {
      expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP), options)).state).toBe('unsure');
    }
  });
});

describe('a payee leg without its fee leg', () => {
  for (const code of ['fee_leg_missing', 'fee_leg_blocked'] as const) {
    it(`(${code}) is paid only when the whole price went to the payee`, async () => {
      answer({ own: { outcome: 'refused', code }, full: verified(leg(FULL_TX, PAYOUT, PRICE)) });
      expect(await watchTempoPayment(await paying(), deps())).toMatchObject({
        state: 'paid',
        record: { paidTx: FULL_TX },
      });
    });

    it(`(${code}) is held otherwise, and released after the catch-up when nothing holds`, async () => {
      answer({ own: { outcome: 'refused', code }, full: { outcome: 'none' } });
      const record = await paying();
      expect((await watchTempoPayment(record, deps())).state).toBe('unsure');
      expect((await endTempoOrder(record, deps())).ended).toBe(false);
      expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP))).state).toBe('over');
    });
  }

  it("holds the buyer's own hash with a bounced fee leg forever", async () => {
    answer({ own: { outcome: 'refused', code: 'fee_leg_blocked' }, full: { outcome: 'none' } });
    const record = await paying({ marker: { txHash: OWN_HASH } });
    expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP))).state).toBe('unsure');
    expect((await endTempoOrder(record, deps(AFTER_CATCH_UP))).ended).toBe(false);
  });
});

describe('nothing found', () => {
  it('asks again at the merchant floor while the catch-up is open: a leg there holds the order', async () => {
    const floor = merchantFloor(PRICE);
    answer({ own: { outcome: 'none' }, floor: verified(leg(PAYEE_TX, PAYOUT, floor)) });
    const record = await paying();
    expect((await watchTempoPayment(record, deps())).state).toBe('unsure');
    expect((await endTempoOrder(record, deps())).ended).toBe(false);
    const floorAsk = asked.find((entry) => BigInt(entry.request.amount) === floor);
    expect(floorAsk?.request.fee_address).toBeUndefined();
    expect(floorAsk?.request.fee_amount).toBeUndefined();
    // Past the catch-up the floor is not asked, and the order ends.
    asked = [];
    expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP))).state).toBe('over');
    expect(asked).toHaveLength(1);
  });

  it('holds when the floor question cannot be answered (history control failed)', async () => {
    answer({
      own: { outcome: 'none' },
      floor: { outcome: 'inconclusive', reason: 'control_failed' },
    });
    expect((await watchTempoPayment(await paying(), deps())).state).toBe('unsure');
  });

  it.each([
    { outcome: 'inconclusive', reason: 'control_failed' },
    { outcome: 'refused', code: 'no_provider_leg' },
  ] as const)('holds, storing nothing, when the full-price question answers %o', async (full) => {
    answer({ own: { outcome: 'refused', code: 'fee_leg_missing' }, full });
    const record = await paying({ marker: { txHash: OWN_HASH } });
    expect((await watchTempoPayment(record, deps())).state).toBe('unsure');
    expect((await store.get(ORDER_ID))?.paidTx).toBeUndefined();
  });

  it('ends over when the floor finds nothing either', async () => {
    answer({ own: { outcome: 'none' }, floor: { outcome: 'none' } });
    const record = await paying();
    expect((await watchTempoPayment(record, deps())).state).toBe('over');
    expect(asked).toHaveLength(2);
  });

  it('skips the floor question at a 1-subunit price (its floor is 0)', async () => {
    answer({ own: { outcome: 'none' } });
    const record = await paying({ amount: 1n, fee: 0n });
    expect((await watchTempoPayment(record, deps())).state).toBe('over');
    expect(asked).toHaveLength(1);
  });

  it('asks every derived question with the watch’s own options, in one pass', async () => {
    answer({ own: { outcome: 'refused', code: 'fee_leg_missing' }, full: { outcome: 'none' } });
    await watchTempoPayment(await paying({ marker: { txHash: OWN_HASH } }), deps());
    answer({ own: { outcome: 'none' }, floor: { outcome: 'none' } });
    await watchTempoPayment((await store.get(ORDER_ID)) ?? (await paying()), deps());
    expect(asked.length).toBeGreaterThanOrEqual(4);
    for (const entry of asked) {
      expect(entry.options).toEqual({
        txSignature: OWN_HASH,
        fromBlock: Number(FLOOR_BLOCK),
        pollBudgetMs: 0,
      });
      expect(entry.request.memo).toBe(MEMO);
      expect(entry.request.created_at).toBe(NOW);
    }
  });
});

describe('a bundle', () => {
  it('holds the order while approved and unfailed, even past the catch-up', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)) });
    const record = await paying({ marker: { bundleId: 'bundle' } });
    expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP))).state).toBe('unsure');
    answer({ own: { outcome: 'none' } });
    expect((await watchTempoPayment(record, deps(AFTER_CATCH_UP))).state).toBe('waiting');
    expect((await endTempoOrder(record, deps(AFTER_CATCH_UP))).ended).toBe(false);
  });

  it('no longer holds once failed: a cross-transaction split ends over after the catch-up, not before', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)) });
    const record = await paying({ marker: { bundleId: 'bundle', bundleFailed: true } });
    expect((await endTempoOrder(record, deps())).ended).toBe(false);
    const ended = await endTempoOrder(record, deps(AFTER_CATCH_UP));
    expect(ended).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid', endedBy: 'over' },
    });
  });

  it('a failed bundle with a vouched none ends over', async () => {
    answer({ own: { outcome: 'none' }, floor: { outcome: 'none' } });
    const record = await paying({ marker: { bundleId: 'bundle', bundleFailed: true } });
    expect(await endTempoOrder(record, deps())).toMatchObject({
      ended: true,
      record: { endedBy: 'over' },
    });
  });
});

describe('the merchant node’s limits', () => {
  it('floors at the price less a 10% fee, rounded up', () => {
    expect(merchantFloor(PRICE)).toBe(44_100_000n);
    expect(merchantFloor(1n)).toBe(0n);
    expect(merchantFloor(11n)).toBe(9n);
  });

  it('may still credit up to the end of its catch-up, with the skew allowance', () => {
    const edge = NOW + MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS;
    expect(merchantMayStillCredit({ createdAt: NOW }, edge)).toBe(true);
    expect(merchantMayStillCredit({ createdAt: NOW }, edge + 1)).toBe(false);
  });

  it('the Tempo watch releases a held split one second after that edge, not at it', async () => {
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)) });
    const record = await paying();
    const edge = NOW + MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS;
    expect((await watchTempoPayment(record, deps(edge))).state).toBe('unsure');
    expect((await watchTempoPayment(record, deps(edge + 1))).state).toBe('over');
  });

  it('never answers over for an order that already ended: only a live attempt ends', async () => {
    answer({ own: { outcome: 'none' }, floor: { outcome: 'none' } });
    const ended = await endTempoOrder(await paying(), deps());
    expect(ended.ended).toBe(true);
    answer({ own: verified(leg(PAYEE_TX, PAYOUT, PRICE - FEE), leg(FEE_TX, TREASURY, FEE)) });
    expect((await watchTempoPayment(ended.record, deps(AFTER_CATCH_UP))).state).toBe('unsure');
  });
});
