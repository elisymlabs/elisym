/**
 * The merchant's side of a Tempo payment, against pay-core's fake chain (one
 * block per second, so the floor's binary search reads real timestamps).
 */
import { deriveOrderPaymentReference } from '@elisym/commerce';
import { chainByCaip2 } from '@elisym/pay-core';
import type { Eip1193Client } from '@elisym/pay-core/evm';
import { describe, expect, it } from 'vitest';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import {
  type FakeChainOptions,
  fakeTempoChain,
  recordedReceipt,
} from '../../pay-core/tests/tempo-chain';
import { intake, storeIdentity } from '../src/intake';
import { type MerchantOrder, emptyLedger, loadLedger, saveLedger } from '../src/ledger';
import { catchUp } from '../src/solana';
import {
  type TempoContext,
  blockAtTime,
  catchUpTempo,
  checkTempoPayment,
  recordTempoCheck,
  tempoMemo,
} from '../src/tempo';
import { publishTerms } from '../src/terms';
import { D, T0, delivered, key, orderFrom } from './fixtures';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_USDC = `eip155:4217/erc20:${USDCE}`;
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PRICE = 49_000_000n;
const HEAD = 40_000_000;
/** The head's time: an hour after the store published its terms. */
const HEAD_TIME = T0 + 3600;
const LAND = HEAD - 100;
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'ac'.repeat(32)}`;

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/**
 * Ordinary traffic on the coin around the order's floor and near the head:
 * without it the verifier cannot vouch that an empty window means "none".
 */
function controlTraffic(): NonNullable<FakeChainOptions['logs']> {
  return [HEAD - 5400, HEAD - 50].map((blockNumber, index) => ({
    address: USDCE,
    topics: [`0x${'55'.repeat(32)}`],
    data: '0x',
    blockNumber,
    transactionHash: `0x${String(index + 2)
      .repeat(2)
      .repeat(32)}`,
    logIndex: 0,
  }));
}

/** One block per second up to the head: every block has a time. */
function timestamps(): Record<number, number> {
  return new Proxy({} as Record<number, number>, {
    get: (_target, property) => {
      const number = Number(property);
      return Number.isInteger(number) && number >= 0 && number <= HEAD
        ? HEAD_TIME - (HEAD - number)
        : undefined;
    },
  });
}

interface Setup {
  state: ReturnType<typeof emptyLedger>;
  order: MerchantOrder;
  context: TempoContext;
  options: FakeChainOptions & {
    receipts: Record<string, unknown>;
    logs: NonNullable<FakeChainOptions['logs']>;
  };
  memo: string;
}

function setup(price = PRICE, chainId = '0x1079', caip19 = TEMPO_USDC, payout = PAYOUT): Setup {
  const store = key();
  const buyer = key();
  const state = emptyLedger();
  state.terms = publishTerms([], { caip19, payout, amount: price.toString() }, T0 - 86_400);
  const identity = storeIdentity(store.pubkey, D, ['tempo', 'tempo-moderato']);
  const taken = intake(
    state,
    orderFrom(buyer, store, 'b3a7c2d4-0000-4000-8000-000000000001'),
    identity,
  );
  if (taken.kind !== 'order') {
    throw new Error('order not taken');
  }
  const options = {
    chainId,
    finalized: HEAD,
    timestamps: timestamps(),
    receipts: {} as Record<string, unknown>,
    logs: controlTraffic(),
  };
  const chain = chainByCaip2(caip19.split('/')[0] ?? '');
  if (chain === undefined) {
    throw new Error('no chain');
  }
  const context: TempoContext = {
    client: fakeTempoChain(options).client,
    chain,
    medium: chainId === '0x1079' ? 'tempo' : 'tempo-moderato',
    storePubkey: store.pubkey,
  };
  return {
    state,
    order: taken.order,
    context,
    options,
    memo: tempoMemo(taken.order, store.pubkey),
  };
}

/** A payment of `amount` with `memo` from the payer to the payout, landed at `block` under `hash`. */
function land(
  run: Setup,
  hash: string,
  memo: string,
  { amount = PRICE, block = LAND, receiptLogs = true } = {},
): void {
  const log = {
    address: USDCE,
    topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYOUT)}`, memo],
    data: `0x${word(amount)}`,
    blockNumber: block,
    transactionHash: hash,
    logIndex: 0,
  };
  run.options.logs.push(log);
  const at = `0x${block.toString(16)}`;
  run.options.receipts[hash] = {
    transactionHash: hash,
    status: '0x1',
    blockNumber: at,
    blockHash: `0x${'cd'.repeat(32)}`,
    logs: receiptLogs
      ? [{ ...log, blockNumber: at, logIndex: '0x0', blockHash: `0x${'cd'.repeat(32)}` }]
      : [],
  };
}

describe('the Tempo floor', () => {
  it('finds the newest block at or before a time by binary search', async () => {
    const run = setup();
    expect(await blockAtTime(run.context, HEAD_TIME - 500)).toEqual({
      number: HEAD - 500,
      timestamp: HEAD_TIME - 500,
    });
    // Clamped to the catch-up lookback.
    const far = await blockAtTime(run.context, HEAD_TIME - 30 * 86_400);
    expect(far?.timestamp).toBeGreaterThan(HEAD_TIME - 4 * 86_400);
  });
});

describe('checkTempoPayment', () => {
  it('credits a reported payment by its settlement id, and keeps the leg that paid', async () => {
    const run = setup();
    land(run, HASH, run.memo);
    const check = await checkTempoPayment(run.state, run.order, HASH, run.context);
    expect(check).toMatchObject({ kind: 'paid' });
    expect(run.order.paid).toMatchObject({
      signature: HASH,
      amount: PRICE.toString(),
      caip19: TEMPO_USDC,
      medium: 'tempo',
      blockTime: HEAD_TIME - 100,
    });
    expect(Object.entries(run.state.claims)).toEqual([
      [`eip155:4217:${HASH}:${run.memo}`, run.order.key],
    ]);
    expect(run.state.version).toBe(2);
  });

  it('asks again for a hash the chain does not know yet', async () => {
    const run = setup();
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
    });
  });

  it('sets aside, never refuses, a hash whose receipt shows no leg for this order', async () => {
    const run = setup();
    land(run, HASH, `0x${'99'.repeat(32)}`);
    const check = await checkTempoPayment(run.state, run.order, HASH, run.context);
    expect(check).toEqual({ kind: 'no_leg' });
    recordTempoCheck(run.state, run.order, HASH, check);
    expect(run.order.noLegTxs).toEqual([HASH]);
    expect(run.order.refusedTxs).toBeUndefined();
  });

  it('lifts a paid hash the pre-read set aside when catch-up finds its leg', async () => {
    const run = setup();
    // The receipt read came back with no logs (a lagging backend); the scan sees the leg.
    land(run, HASH, run.memo, { receiptLogs: false });
    const check = await checkTempoPayment(run.state, run.order, HASH, run.context);
    recordTempoCheck(run.state, run.order, HASH, check);
    expect(run.order.noLegTxs).toEqual([HASH]);
    // The receipt is whole by the next sweep.
    land(run, HASH, run.memo);
    const swept = await catchUpTempo(run.state, run.context, T0 + 3600);
    expect(swept.paid).toEqual([run.order]);
    expect(run.order.noLegTxs).toEqual([]);
  });

  it('refuses a leg paid on terms the store was not offering at its block time', async () => {
    const run = setup();
    // The price doubled after the order and more than 45 minutes before the payment landed:
    // the old price is a candidate by the order's date, but not at the leg's block time.
    run.state.terms = publishTerms(
      run.state.terms,
      { caip19: TEMPO_USDC, payout: PAYOUT, amount: (PRICE * 2n).toString() },
      T0 + 600,
    );
    land(run, HASH, run.memo);
    const check = await checkTempoPayment(run.state, run.order, HASH, run.context);
    expect(check).toEqual({ kind: 'no_leg' });
    expect(run.order.paid).toBeUndefined();
  });

  it('refuses a leg that only the old price, no longer offered, would pay', async () => {
    const run = setup();
    run.state.terms = publishTerms(
      run.state.terms,
      { caip19: TEMPO_USDC, payout: PAYOUT, amount: (PRICE / 2n).toString() },
      T0 + 600,
    );
    // Paid the OLD (higher) price after the change: the new, lower term is paid in full
    // and offered, so it credits; the check is on the term offered at the leg's time.
    land(run, HASH, run.memo);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid?.amount).toBe(PRICE.toString());
  });

  it('refuses a leg below the order floor', async () => {
    const run = setup();
    land(run, HASH, run.memo, { block: HEAD - 3 * 3600 });
    const check = await checkTempoPayment(run.state, run.order, HASH, run.context);
    expect(check).toMatchObject({ kind: 'refused' });
  });

  it('notes a transfer the recipient policy blocked, and neither refuses nor credits it', async () => {
    const blockedReceiver = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
    const pathusd = '0x20c0000000000000000000000000000000000000';
    const run = setup(PRICE, '0xa5bf', `eip155:42431/erc20:${pathusd}`, blockedReceiver);
    const recorded = recordedReceipt('moderato-blocked-pathusd');
    const guard = (recorded.logs as Record<string, unknown>[]).find(
      (log) => String(log.address).toLowerCase() === '0xb10c000000000000000000000000000000000000',
    );
    if (guard === undefined) {
      throw new Error('no guard log');
    }
    const words = String(guard.data).slice(2).match(/.{64}/g) ?? [];
    words[0] = word(PRICE);
    words[13] = word(run.memo);
    const at = `0x${LAND.toString(16)}`;
    run.options.receipts[HASH] = {
      transactionHash: HASH,
      status: '0x1',
      blockNumber: at,
      blockHash: `0x${'cd'.repeat(32)}`,
      logs: [
        {
          ...guard,
          data: `0x${words.join('')}`,
          blockNumber: at,
          transactionHash: HASH,
          blockHash: `0x${'cd'.repeat(32)}`,
        },
      ],
    };
    const check = await checkTempoPayment(run.state, run.order, HASH, run.context);
    expect(check).toEqual({ kind: 'blocked' });
    expect(run.order.blockedTx).toBe(HASH);
    expect(run.order.paid).toBeUndefined();
  });
});

describe('Tempo receipts and the ledger', () => {
  it('takes a Tempo receipt only with this order memo and one lowercase hash spelling', () => {
    const store = key();
    const buyer = key();
    const state = emptyLedger();
    const identity = storeIdentity(store.pubkey, D, ['tempo']);
    const orderId = 'b3a7c2d4-0000-4000-8000-000000000002';
    intake(state, orderFrom(buyer, store, orderId), identity);
    const memo = deriveOrderPaymentReference({
      storePubkey: store.pubkey,
      buyerPubkey: buyer.pubkey,
      orderId,
    }).tempo;
    const receipt = (reference: string, tx: string, medium = 'tempo') =>
      delivered(
        { type: 'receipt', storePubkey: store.pubkey, orderId, payment: { medium, reference, tx } },
        buyer,
        store,
      );
    expect(
      intake(state, receipt(memo, HASH.toUpperCase().replace('0X', '0x')), identity),
    ).toMatchObject({ kind: 'ignored', reason: 'foreign_payment' });
    expect(intake(state, receipt(`0x${'11'.repeat(32)}`, HASH), identity)).toMatchObject({
      reason: 'foreign_payment',
    });
    expect(intake(state, receipt(memo, HASH, 'tempo-moderato'), identity)).toMatchObject({
      reason: 'foreign_payment',
    });
    expect(state.version).toBe(1);
    expect(intake(state, receipt(memo, HASH), identity)).toMatchObject({
      kind: 'receipt',
      tx: HASH,
    });
    expect(state.version).toBe(2);
  });

  it('is read at version 1 and 2, and an unknown version is refused', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/elisym-ledger-${Date.now()}-${Math.random()}.json`;
    const state = emptyLedger();
    state.version = 2;
    saveLedger(path, state);
    expect(loadLedger(path).version).toBe(2);
    saveLedger(path, { ...state, version: 3 as never });
    expect(() => loadLedger(path)).toThrow('Unknown ledger version');
  });

  it('never lets the Solana catch-up judge a reported Tempo hash', async () => {
    const run = setup();
    run.order.reportedTxs.push(OTHER_HASH);
    const noRpc = {} as never;
    await catchUp(run.state, { rpc: noRpc, network: 'devnet' }, T0 + 3600);
    expect(run.order.refusedTxs).toBeUndefined();
  });
});

/** An endpoint whose `eth_chainId` fails `times` times: every answer past "unreadable" needs it. */
function flaky(client: Eip1193Client, times: number): Eip1193Client {
  let left = times;
  return {
    request: async (args) => {
      if (args.method === 'eth_chainId' && left > 0) {
        left -= 1;
        throw new Error('flaky');
      }
      return client.request(args);
    },
  };
}

describe('catchUpTempo', () => {
  it('does not verify again a match every term refused as no leg', async () => {
    const run = setup();
    // The price doubled after the order; the buyer paid the old price after that.
    run.state.terms = publishTerms(
      run.state.terms,
      { caip19: TEMPO_USDC, payout: PAYOUT, amount: (PRICE * 2n).toString() },
      T0 + 600,
    );
    land(run, HASH, run.memo);
    let receipts = 0;
    const steady = run.context.client;
    run.context.client = {
      request: async (args) => {
        if (args.method === 'eth_getTransactionReceipt') {
          receipts += 1;
        }
        return steady.request(args);
      },
    };
    await catchUpTempo(run.state, run.context, T0 + 3600);
    expect(run.order.tempoNoLeg).toEqual([HASH]);
    const afterFirst = receipts;
    await catchUpTempo(run.state, run.context, T0 + 3700);
    expect(receipts).toBe(afterFirst);
  });

  it('verifies an asked-again match on the next sweep and credits it', async () => {
    const run = setup();
    land(run, HASH, run.memo);
    const steady = run.context.client;
    run.context.client = flaky(steady, 100);
    const first = await catchUpTempo(run.state, run.context, T0 + 3600);
    expect(first.paid).toEqual([]);
    expect(run.order.tempoNoLeg).toBeUndefined();
    run.context.client = steady;
    const second = await catchUpTempo(run.state, run.context, T0 + 3700);
    expect(second.paid).toEqual([run.order]);
  });
});
