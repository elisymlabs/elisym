/**
 * The node's paid rule for Tempo payments split with an elisym treasury, by
 * the receipt of a reported hash and by the catch-up memo scan. `B` is the
 * LARGEST single leg to the payout, `T(t)` the largest single leg to a known
 * treasury `t`, both in the same receipt.
 */
import { chainByCaip2 } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import {
  type FakeChainOptions,
  fakeTempoChain,
  recordedReceipt,
} from '../../pay-core/tests/tempo-chain';
import { paymentFloor, recordTreasuryRead } from '../src/fee';
import { intake, storeIdentity } from '../src/intake';
import { type MerchantOrder, emptyLedger, recordReport } from '../src/ledger';
import {
  type TempoContext,
  catchUpTempo,
  checkTempoPayment,
  orderTempoCandidates,
  tempoMemo,
} from '../src/tempo';
import { publishTerms } from '../src/terms';
import { D, PAYOUT as SOLANA_PAYOUT, T0, USDC_DEVNET_CAIP19, key, orderFrom } from './fixtures';

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_USDC = `eip155:4217/erc20:${USDCE}`;
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const TEMPO_PATHUSD = `eip155:4217/erc20:${PATHUSD}`;
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const TREASURY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const STRANGER = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
const NEXT_TREASURY = '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc';
const PRICE = 49_000_000n;
const FEE = 490_000n;
const FLOOR = paymentFloor(PRICE);
const HEAD = 40_000_000;
const HEAD_TIME = T0 + 3600;
const LAND = HEAD - 100;
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'ac'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/** Ordinary traffic on the coin: without it the verifier cannot vouch for an empty window. */
function controlTraffic(token: string): NonNullable<FakeChainOptions['logs']> {
  return [HEAD - 5400, HEAD - 50].map((blockNumber, index) => ({
    address: token,
    topics: [`0x${'55'.repeat(32)}`],
    data: '0x',
    blockNumber,
    transactionHash: `0x${String(index + 2)
      .repeat(2)
      .repeat(32)}`,
    logIndex: 0,
  }));
}

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
  token: string;
}

function setup(
  options: {
    price?: bigint;
    chainId?: string;
    caip19?: string;
    payout?: string;
  } = {},
): Setup {
  const price = options.price ?? PRICE;
  const chainId = options.chainId ?? '0x1079';
  const caip19 = options.caip19 ?? TEMPO_USDC;
  const payout = options.payout ?? PAYOUT;
  const token = caip19.split(':').pop() ?? '';
  const store = key();
  const state = emptyLedger();
  state.terms = publishTerms(
    [],
    { d: D, caip19, payout, amount: price.toString() },
    T0 - 86_400,
    T0 - 86_400,
  );
  const identity = storeIdentity(store.pubkey, [D], ['tempo', 'tempo-moderato']);
  const taken = intake(
    state,
    orderFrom(key(), store, 'b3a7c2d4-0000-4000-8000-000000000001'),
    identity,
  );
  if (taken.kind !== 'order') {
    throw new Error('order not taken');
  }
  const chainOptions = {
    chainId,
    finalized: HEAD,
    timestamps: timestamps(),
    receipts: {} as Record<string, unknown>,
    logs: controlTraffic(token),
  };
  const chain = chainByCaip2(caip19.split('/')[0] ?? '');
  if (chain === undefined) {
    throw new Error('no chain');
  }
  // The config of the paired Solana network named the treasury just now.
  recordTreasuryRead(
    state,
    chainId === '0x1079' ? 'mainnet' : 'devnet',
    {
      treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      evmTreasury: TREASURY,
    },
    HEAD_TIME,
  );
  const context: TempoContext = {
    client: fakeTempoChain(chainOptions).client,
    chain,
    medium: chainId === '0x1079' ? 'tempo' : 'tempo-moderato',
    storePubkey: store.pubkey,
    now: () => HEAD_TIME,
  };
  return {
    state,
    order: taken.order,
    context,
    options: chainOptions,
    memo: tempoMemo(taken.order, store.pubkey),
    token,
  };
}

/**
 * One transaction under `hash` carrying `legs` with `memo`, each a
 * TransferWithMemo of the order's coin unless the leg names another.
 */
function land(
  run: Setup,
  hash: string,
  legs: readonly { to: string; amount: bigint; token?: string }[],
  { memo = run.memo, block = LAND } = {},
): void {
  const at = `0x${block.toString(16)}`;
  const logs = legs.map((leg, index) => ({
    address: leg.token ?? run.token,
    topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(leg.to)}`, memo],
    data: `0x${word(leg.amount)}`,
    blockNumber: block,
    transactionHash: hash,
    logIndex: index,
  }));
  run.options.logs.push(...logs);
  run.options.receipts[hash] = {
    transactionHash: hash,
    status: '0x1',
    blockNumber: at,
    blockHash: BLOCK_HASH,
    logs: logs.map((log) => ({
      ...log,
      blockNumber: at,
      logIndex: `0x${log.logIndex.toString(16)}`,
      blockHash: BLOCK_HASH,
    })),
  };
}

describe('the paid rule on Tempo, by the receipt', () => {
  it('rule 1: the full price with no fee leg is paid with no fee', async () => {
    const run = setup();
    land(run, HASH, [{ to: PAYOUT, amount: PRICE }]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid).toMatchObject({
      amount: PRICE.toString(),
      fee: '0',
    });
  });

  it('rule 2: a split to the known treasury in one transaction is paid, total and fee recorded', async () => {
    const run = setup();
    land(run, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid).toMatchObject({
      signature: HASH,
      amount: PRICE.toString(),
      fee: FEE.toString(),
      medium: 'tempo',
    });
  });

  it('rule 2 with a treasury excess records the fee as the price less the payee leg', async () => {
    const run = setup();
    land(run, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE * 4n },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid).toMatchObject({
      amount: PRICE.toString(),
      fee: FEE.toString(),
    });
  });

  it('judges the largest single payee leg, never the sum of several', async () => {
    // P = 100 units: 95 + 3 to the payee is B = 95, which needs 5 to the treasury.
    const unit = PRICE / 100n;
    const short = setup();
    land(short, HASH, [
      { to: PAYOUT, amount: unit * 95n },
      { to: PAYOUT, amount: unit * 3n },
      { to: TREASURY, amount: unit * 2n },
    ]);
    expect(await checkTempoPayment(short.state, short.order, HASH, short.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    const whole = setup();
    land(whole, HASH, [
      { to: PAYOUT, amount: unit * 95n },
      { to: PAYOUT, amount: unit * 3n },
      { to: TREASURY, amount: unit * 5n },
    ]);
    expect(await checkTempoPayment(whole.state, whole.order, HASH, whole.context)).toMatchObject({
      kind: 'paid',
    });
    expect(whole.order.paid).toMatchObject({
      amount: PRICE.toString(),
      fee: (unit * 5n).toString(),
    });
  });

  it('the floor at a 1000 bps fee: the floor is paid, one subunit less has no leg', async () => {
    expect(FLOOR).toBe(44_100_000n);
    const atFloor = setup();
    land(atFloor, HASH, [
      { to: PAYOUT, amount: FLOOR },
      { to: TREASURY, amount: PRICE - FLOOR },
    ]);
    expect(
      await checkTempoPayment(atFloor.state, atFloor.order, HASH, atFloor.context),
    ).toMatchObject({ kind: 'paid' });
    expect(atFloor.order.paid?.fee).toBe((PRICE - FLOOR).toString());
    const below = setup();
    land(below, HASH, [
      { to: PAYOUT, amount: FLOOR - 1n },
      { to: TREASURY, amount: PRICE - FLOOR + 1n },
    ]);
    expect(await checkTempoPayment(below.state, below.order, HASH, below.context)).toEqual({
      kind: 'no_leg',
    });
  });

  it('reads a fee leg of a single subunit: a split of 10 as 9 + 1 is paid with fee 1', async () => {
    const run = setup({ price: 10n });
    expect(paymentFloor(10n)).toBe(9n);
    land(run, HASH, [
      { to: PAYOUT, amount: 9n },
      { to: TREASURY, amount: 1n },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid).toMatchObject({ amount: '10', fee: '1' });
  });

  it('reads a payee leg of a single subunit: a price of 1 paid in full is paid', async () => {
    const run = setup({ price: 1n });
    land(run, HASH, [{ to: PAYOUT, amount: 1n }]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid).toMatchObject({ amount: '1', fee: '0' });
  });

  it('a split to an unknown address asks again and is marked, never refused or set aside', async () => {
    const run = setup();
    land(run, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: STRANGER, amount: FEE },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
  });

  it('a split whose fee leg is in another transaction is unresolved, never paid', async () => {
    const run = setup();
    land(run, HASH, [{ to: PAYOUT, amount: PRICE - FEE }]);
    land(run, OTHER_HASH, [{ to: TREASURY, amount: FEE }]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    expect(run.order.paid).toBeUndefined();
  });

  it('never uses a known treasury that is the payout itself', async () => {
    const run = setup();
    recordTreasuryRead(
      run.state,
      'mainnet',
      {
        treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
        evmTreasury: PAYOUT,
      },
      HEAD_TIME,
    );
    land(run, HASH, [{ to: PAYOUT, amount: PRICE - FEE }]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    expect(run.order.paid).toBeUndefined();
  });

  it('an unresolved term keeps the answer open, whatever another term says', async () => {
    const run = setup();
    // The price doubled after the order: the old term is unresolved, the new one has no leg.
    run.state.terms = publishTerms(
      run.state.terms,
      {
        d: D,
        caip19: TEMPO_USDC,
        payout: PAYOUT,
        amount: (PRICE * 2n).toString(),
      },
      T0 + 600,
      T0 + 600,
    );
    land(run, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: STRANGER, amount: FEE },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
  });

  it('a fresh home with no treasury read asks again', async () => {
    const run = setup();
    run.state.treasuries = {};
    land(run, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
  });

  it('on Moderato credits a treasury of the devnet config, never one only the mainnet config named', async () => {
    const moderato = { chainId: '0xa5bf', caip19: `eip155:42431/erc20:${PATHUSD}` };
    const devnet = setup(moderato);
    land(devnet, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE },
    ]);
    expect(await checkTempoPayment(devnet.state, devnet.order, HASH, devnet.context)).toMatchObject(
      { kind: 'paid' },
    );
    expect(devnet.order.paid).toMatchObject({
      amount: PRICE.toString(),
      fee: FEE.toString(),
      medium: 'tempo-moderato',
    });

    const mainnetOnly = setup(moderato);
    mainnetOnly.state.treasuries = {};
    recordTreasuryRead(
      mainnetOnly.state,
      'mainnet',
      { treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy', evmTreasury: TREASURY },
      HEAD_TIME,
    );
    land(mainnetOnly, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE },
    ]);
    expect(
      await checkTempoPayment(mainnetOnly.state, mainnetOnly.order, HASH, mainnetOnly.context),
    ).toEqual({ kind: 'ask_again', feeUnresolved: true });
    expect(mainnetOnly.order.paid).toBeUndefined();
  });
});

describe('the paid rule on Tempo, with legs of another coin in the same receipt', () => {
  /** The product is also offered in pathUSD, at ten times the price: its legs are read too. */
  function twoCoins(): Setup {
    const run = setup();
    run.state.terms = publishTerms(
      run.state.terms,
      {
        d: D,
        caip19: TEMPO_PATHUSD,
        payout: PAYOUT,
        amount: (PRICE * 10n).toString(),
      },
      T0 - 86_400,
      T0 - 86_400,
    );
    run.options.logs.push(...controlTraffic(PATHUSD));
    return run;
  }

  it('judges the payee and treasury legs in the coin of the term, never a larger one in another', async () => {
    const unit = PRICE / 100n;
    const run = twoCoins();
    land(run, HASH, [
      { to: PAYOUT, amount: unit * 95n },
      { to: TREASURY, amount: unit * 5n },
      { to: PAYOUT, amount: PRICE, token: PATHUSD },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toMatchObject({
      kind: 'paid',
    });
    expect(run.order.paid).toMatchObject({
      caip19: TEMPO_USDC,
      amount: PRICE.toString(),
      fee: (unit * 5n).toString(),
    });
  });

  it('never counts a treasury leg in another coin as the fee leg', async () => {
    const unit = PRICE / 100n;
    const run = twoCoins();
    land(run, HASH, [
      { to: PAYOUT, amount: unit * 95n },
      { to: TREASURY, amount: unit * 5n, token: PATHUSD },
    ]);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'ask_again',
      feeUnresolved: true,
    });
    expect(run.order.paid).toBeUndefined();
    // Two treasuries known: the first one has only a leg in the other coin, so
    // the fee is the later one's leg in the coin of the term.
    const rotated = twoCoins();
    recordTreasuryRead(
      rotated.state,
      'mainnet',
      {
        treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
        evmTreasury: NEXT_TREASURY,
      },
      HEAD_TIME,
    );
    land(rotated, HASH, [
      { to: PAYOUT, amount: unit * 95n },
      { to: TREASURY, amount: unit * 5n, token: PATHUSD },
      { to: NEXT_TREASURY, amount: unit * 5n },
    ]);
    expect(
      await checkTempoPayment(rotated.state, rotated.order, HASH, rotated.context),
    ).toMatchObject({ kind: 'paid' });
    expect(rotated.order.paid).toMatchObject({
      caip19: TEMPO_USDC,
      amount: PRICE.toString(),
      fee: (unit * 5n).toString(),
    });
  });
});

describe('the paid rule on Tempo, by the catch-up scan', () => {
  it('pays a scanned split no buyer reported, and marks one to an unknown address', async () => {
    const paid = setup();
    land(paid, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE },
    ]);
    const found = await catchUpTempo(paid.state, paid.context, HEAD_TIME);
    expect(found.paid).toEqual([paid.order]);
    expect(paid.order.paid).toMatchObject({
      amount: PRICE.toString(),
      fee: FEE.toString(),
    });

    const unknown = setup();
    land(unknown, HASH, [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: STRANGER, amount: FEE },
    ]);
    const asked = await catchUpTempo(unknown.state, unknown.context, HEAD_TIME);
    expect(asked.paid).toEqual([]);
    expect(asked.unresolved).toEqual([`${unknown.order.key} ${HASH}`]);
    expect(unknown.order.feeUnresolved).toEqual({ [HASH]: HEAD_TIME });
    expect(unknown.order.tempoNoLeg).toBeUndefined();
    expect(unknown.order.noLegTxs).toBeUndefined();
    expect(unknown.order.refusedTxs).toBeUndefined();
    // The treasury becomes known: the next sweep pays it.
    recordTreasuryRead(
      unknown.state,
      'mainnet',
      {
        treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
        evmTreasury: STRANGER,
      },
      HEAD_TIME + 30,
    );
    const later = await catchUpTempo(unknown.state, unknown.context, HEAD_TIME + 60);
    expect(later.paid).toEqual([unknown.order]);
    expect(unknown.order.feeUnresolved).toBeUndefined();
  });

  it('the floor at a 1000 bps fee, by the scan: the floor is paid, one subunit less is not', async () => {
    const atFloor = setup();
    land(atFloor, HASH, [
      { to: PAYOUT, amount: FLOOR },
      { to: TREASURY, amount: PRICE - FLOOR },
    ]);
    expect((await catchUpTempo(atFloor.state, atFloor.context, HEAD_TIME)).paid).toEqual([
      atFloor.order,
    ]);
    const below = setup();
    land(below, HASH, [
      { to: PAYOUT, amount: FLOOR - 1n },
      { to: TREASURY, amount: PRICE - FLOOR + 1n },
    ]);
    const swept = await catchUpTempo(below.state, below.context, HEAD_TIME);
    expect(swept.paid).toEqual([]);
    expect(below.order.paid).toBeUndefined();
    expect(below.order.feeUnresolved).toBeUndefined();
  });
});

describe('a scanned leg the receipt does not show', () => {
  it('is asked again, never set aside, when the receipt has no leg or only a smaller one', async () => {
    for (const receiptAmount of [undefined, 1n]) {
      const run = setup();
      land(run, HASH, [{ to: PAYOUT, amount: PRICE }]);
      const receipt = run.options.receipts[HASH] as {
        logs: Record<string, unknown>[];
      };
      if (receiptAmount === undefined) {
        receipt.logs = [];
      } else {
        receipt.logs = receipt.logs.map((log) => ({
          ...log,
          data: `0x${word(receiptAmount)}`,
        }));
      }
      const swept = await catchUpTempo(run.state, run.context, HEAD_TIME);
      const label = String(receiptAmount);
      expect(`${label}: ${swept.paid.length}`).toBe(`${label}: 0`);
      expect(run.order.tempoNoLeg).toBeUndefined();
      expect(run.order.refusedTxs).toBeUndefined();
      expect(run.order.feeUnresolved).toBeUndefined();
    }
  });
});

describe('a scanned leg the receipt shows but no term of the order can use', () => {
  it("is set aside with no leg, not asked again forever, when another product's floor let the scan find it", async () => {
    const run = setup();
    const cheap = PRICE / 2n;
    // A cheaper product on the same coin and payout: the scan reads down to its floor.
    run.state.terms = publishTerms(
      run.state.terms,
      {
        d: 'cheap',
        caip19: TEMPO_USDC,
        payout: PAYOUT,
        amount: cheap.toString(),
      },
      T0 - 86_400,
      T0 - 86_400,
    );
    expect(cheap).toBeGreaterThanOrEqual(paymentFloor(cheap));
    expect(cheap).toBeLessThan(FLOOR);
    // The order is for the dearer product; the leg carries its memo and the cheap price.
    land(run, HASH, [{ to: PAYOUT, amount: cheap }]);
    const first = await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(first.paid).toEqual([]);
    expect(run.order.tempoNoLeg).toEqual([HASH]);
    expect(run.order.paid).toBeUndefined();
    expect(run.order.refusedTxs).toBeUndefined();
    expect(run.order.feeUnresolved).toBeUndefined();
    // The next sweep does not judge it again.
    const checkedAt = run.order.recheckedAt?.[HASH];
    await catchUpTempo(run.state, run.context, HEAD_TIME + 60);
    expect(run.order.recheckedAt?.[HASH]).toBe(checkedAt);
    expect(run.order.tempoNoLeg).toEqual([HASH]);
  });

  it("is set aside with no leg when it went to another product's payout", async () => {
    const run = setup();
    run.state.terms = publishTerms(
      run.state.terms,
      {
        d: 'other',
        caip19: TEMPO_USDC,
        payout: STRANGER,
        amount: PRICE.toString(),
      },
      T0 - 86_400,
      T0 - 86_400,
    );
    land(run, HASH, [{ to: STRANGER, amount: PRICE }]);
    const swept = await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(swept.paid).toEqual([]);
    expect(run.order.tempoNoLeg).toEqual([HASH]);
    expect(run.order.paid).toBeUndefined();
  });

  it("is set aside with no leg, not refused, when the order's product has no Tempo terms", async () => {
    const run = setup();
    // The order's product is sold on Solana only; another product takes Tempo.
    run.state.terms = publishTerms(
      publishTerms(
        [],
        {
          d: D,
          caip19: USDC_DEVNET_CAIP19,
          payout: SOLANA_PAYOUT,
          amount: PRICE.toString(),
        },
        T0 - 86_400,
        T0 - 86_400,
      ),
      {
        d: 'other',
        caip19: TEMPO_USDC,
        payout: STRANGER,
        amount: PRICE.toString(),
      },
      T0 - 86_400,
      T0 - 86_400,
    );
    expect(orderTempoCandidates(run.state, run.order, run.context)).toEqual([]);
    land(run, HASH, [{ to: STRANGER, amount: PRICE }]);
    const swept = await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(swept.paid).toEqual([]);
    expect(run.order.tempoNoLeg).toEqual([HASH]);
    expect(run.order.refusedTxs).toBeUndefined();
    expect(run.order.paid).toBeUndefined();
  });
});

/** A receipt holding only a guard log that bounced `amount` to `receiver` (Moderato pathUSD). */
function guarded(run: Setup, receiver: string, amount: bigint): void {
  const recorded = recordedReceipt('moderato-blocked-pathusd');
  const guard = (recorded.logs as Record<string, unknown>[]).find(
    (log) => String(log.address).toLowerCase() === '0xb10c000000000000000000000000000000000000',
  );
  if (guard === undefined) {
    throw new Error('no guard log');
  }
  const words = String(guard.data).slice(2).match(/.{64}/g) ?? [];
  words[0] = word(amount);
  words[8] = word(receiver);
  words[13] = word(run.memo);
  const topics = [...(guard.topics as string[])];
  topics[2] = `0x${word(receiver)}`;
  const at = `0x${LAND.toString(16)}`;
  run.options.receipts[HASH] = {
    transactionHash: HASH,
    status: '0x1',
    blockNumber: at,
    blockHash: BLOCK_HASH,
    logs: [
      {
        ...guard,
        topics,
        data: `0x${words.join('')}`,
        blockNumber: at,
        transactionHash: HASH,
        blockHash: BLOCK_HASH,
      },
    ],
  };
}

describe('the blocked note', () => {
  const blockedReceiver = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const pathusd = '0x20c0000000000000000000000000000000000000';
  const moderato = () =>
    setup({
      chainId: '0xa5bf',
      caip19: `eip155:42431/erc20:${pathusd}`,
      payout: blockedReceiver,
    });

  it('is taken from a guard log to the payout of at least the floor', async () => {
    const run = moderato();
    guarded(run, blockedReceiver, FLOOR);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'blocked',
    });
    expect(run.order.blockedTx).toBe(HASH);
  });

  it('is taken beside a dust transfer to the payout, which is no leg', async () => {
    const run = moderato();
    guarded(run, blockedReceiver, PRICE);
    const receipt = run.options.receipts[HASH] as {
      logs: Record<string, unknown>[];
    };
    const at = `0x${LAND.toString(16)}`;
    receipt.logs.push({
      address: run.token,
      topics: [
        TRANSFER_WITH_MEMO_TOPIC,
        `0x${word(PAYER)}`,
        `0x${word(blockedReceiver)}`,
        run.memo,
      ],
      data: `0x${word(1n)}`,
      blockNumber: at,
      transactionHash: HASH,
      logIndex: '0x5',
      blockHash: BLOCK_HASH,
    });
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'blocked',
    });
  });

  it('is never taken from a guard log below the floor, or one to a treasury', async () => {
    const dust = moderato();
    guarded(dust, blockedReceiver, FLOOR - 1n);
    expect(await checkTempoPayment(dust.state, dust.order, HASH, dust.context)).toEqual({
      kind: 'no_leg',
    });
    expect(dust.order.blockedTx).toBeUndefined();
    const treasury = moderato();
    guarded(treasury, TREASURY, PRICE);
    expect(await checkTempoPayment(treasury.state, treasury.order, HASH, treasury.context)).toEqual(
      { kind: 'no_leg' },
    );
    expect(treasury.order.blockedTx).toBeUndefined();
  });
});

/** The order's split of `PRICE - FEE` and `FEE`, the fee to `STRANGER`: no treasury known. */
function strangerSplit(run: Setup): void {
  land(run, HASH, [
    { to: PAYOUT, amount: PRICE - FEE },
    { to: STRANGER, amount: FEE },
  ]);
}

/** The config names `STRANGER` as the EVM treasury now. */
function learnStranger(run: Setup, at: number): void {
  recordTreasuryRead(
    run.state,
    'mainnet',
    {
      treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      evmTreasury: STRANGER,
    },
    at,
  );
}

/** The order's terms start after the landing block (`HEAD_TIME - 100`): the block-time guard refuses it. */
function startTermsAfterLanding(run: Setup): void {
  run.state.terms = run.state.terms.map((period) => ({
    ...period,
    from: HEAD_TIME - 50,
  }));
}

describe('a hash set aside for good drops its unresolved mark', () => {
  it('reported: unresolved, then the treasury is known but the block-time guard refuses it', async () => {
    const run = setup();
    strangerSplit(run);
    recordReport(run.order, HASH, HEAD_TIME - 10);
    await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(run.order.feeUnresolved).toEqual({ [HASH]: HEAD_TIME });
    learnStranger(run, HEAD_TIME + 30);
    startTermsAfterLanding(run);
    const swept = await catchUpTempo(run.state, run.context, HEAD_TIME + 60);
    expect(swept.paid).toEqual([]);
    expect(run.order.refusedTxs).toEqual([HASH]);
    expect(run.order.feeUnresolved).toBeUndefined();
  });

  it('reported: marked unresolved by its own check when the scan does not find the leg', async () => {
    const run = setup();
    strangerSplit(run);
    recordReport(run.order, HASH, HEAD_TIME - 10);
    // The receipt shows the split, but no log scan finds the hash's legs.
    run.options.logs = run.options.logs.filter((log) => log.transactionHash !== HASH);
    const swept = await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(swept.paid).toEqual([]);
    expect(swept.unresolved).toEqual([`${run.order.key} ${HASH}`]);
    expect(run.order.feeUnresolved).toEqual({ [HASH]: HEAD_TIME });
    expect(run.order.refusedTxs).toBeUndefined();
    expect(run.order.noLegTxs).toBeUndefined();
  });

  it('scanned: unresolved, then the treasury is known but the block-time guard refuses it', async () => {
    const run = setup();
    strangerSplit(run);
    await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(run.order.feeUnresolved).toEqual({ [HASH]: HEAD_TIME });
    learnStranger(run, HEAD_TIME + 30);
    startTermsAfterLanding(run);
    const swept = await catchUpTempo(run.state, run.context, HEAD_TIME + 60);
    expect(swept.paid).toEqual([]);
    expect(run.order.refusedTxs).toEqual([HASH]);
    expect(run.order.feeUnresolved).toBeUndefined();
  });

  it('reported: unresolved, then its receipt shows no leg for the order', async () => {
    const run = setup();
    strangerSplit(run);
    recordReport(run.order, HASH, HEAD_TIME - 10);
    await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(run.order.feeUnresolved).toEqual({ [HASH]: HEAD_TIME });
    // Another backend's answer: the receipt carries another memo, and no scan finds the hash.
    const receipt = run.options.receipts[HASH] as {
      logs: { topics: string[] }[];
    };
    receipt.logs = receipt.logs.map((log) => ({
      ...log,
      topics: [...log.topics.slice(0, 3), `0x${'99'.repeat(32)}`],
    }));
    run.options.logs = run.options.logs.filter((log) => log.transactionHash !== HASH);
    await catchUpTempo(run.state, run.context, HEAD_TIME + 60);
    expect(run.order.noLegTxs).toEqual([HASH]);
    expect(run.order.feeUnresolved).toBeUndefined();
  });

  it('scanned: unresolved, then no term of the order can use the leg', async () => {
    const run = setup();
    strangerSplit(run);
    await catchUpTempo(run.state, run.context, HEAD_TIME);
    expect(run.order.feeUnresolved).toEqual({ [HASH]: HEAD_TIME });
    // The order's product now costs twice as much; a cheaper product on the same
    // coin and payout keeps the scan reading down to the leg.
    run.state.terms = [
      {
        terms: {
          d: D,
          caip19: TEMPO_USDC,
          payout: PAYOUT,
          amount: (PRICE * 2n).toString(),
        },
        from: T0 - 86_400,
      },
      {
        terms: {
          d: 'cheap',
          caip19: TEMPO_USDC,
          payout: PAYOUT,
          amount: PRICE.toString(),
        },
        from: T0 - 86_400,
      },
    ];
    await catchUpTempo(run.state, run.context, HEAD_TIME + 60);
    expect(run.order.tempoNoLeg).toEqual([HASH]);
    expect(run.order.feeUnresolved).toBeUndefined();
  });
});

/**
 * The context's client, contradicting itself after the first receipt read (the
 * pre-read): every later receipt read answers `reverted`, and no log scan finds
 * the hash's legs any more - a backend that cannot see what another just showed.
 */
function revertingAfterFirstRead(run: Setup): void {
  const inner = run.context.client;
  let reads = 0;
  run.context = {
    ...run.context,
    client: {
      request: async (args) => {
        if (args.method === 'eth_getTransactionReceipt') {
          reads += 1;
          const hash = String(args.params?.[0]);
          const receipt = run.options.receipts[hash];
          if (reads === 1) {
            run.options.logs = run.options.logs.filter((log) => log.transactionHash !== hash);
          } else if (receipt !== undefined) {
            return { ...(receipt as Record<string, unknown>), status: '0x0' };
          }
        }
        return await inner.request(args);
      },
    },
  };
}

describe('a scanned leg the verify read contradicts', () => {
  it('is asked again, never set aside, down to a leg of exactly the floor', async () => {
    for (const payee of [PRICE, FLOOR]) {
      const run = setup();
      land(run, HASH, [
        { to: PAYOUT, amount: payee },
        ...(payee === PRICE ? [] : [{ to: TREASURY, amount: PRICE - payee }]),
      ]);
      revertingAfterFirstRead(run);
      const swept = await catchUpTempo(run.state, run.context, HEAD_TIME);
      const label = payee.toString();
      expect(`${label}: ${swept.paid.length}`).toBe(`${label}: 0`);
      expect(`${label}: ${String(run.order.tempoNoLeg)}`).toBe(`${label}: undefined`);
      expect(run.order.refusedTxs).toBeUndefined();
      expect(run.order.recheckedAt?.[HASH]).toBe(HEAD_TIME);
    }
  });

  it('a reported hash, with no scanned leg to contradict, is set aside', async () => {
    const run = setup();
    land(run, HASH, [{ to: PAYOUT, amount: PRICE }]);
    revertingAfterFirstRead(run);
    expect(await checkTempoPayment(run.state, run.order, HASH, run.context)).toEqual({
      kind: 'no_leg',
    });
  });
});
