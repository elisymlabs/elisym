/**
 * The merchant's side of a USDC payment over EIP-3009 (Base Sepolia), against
 * a fake chain that behaves like FiatToken v2.2 and a qualified RPC: the
 * check of one hash, the per-payout scan, the binding cache and the rescan.
 */
import { AUTHORIZATION_USED_TOPIC } from '@elisym/pay-core/evm';
import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_SECS,
  EIP3009_BIND_READS,
  EIP3009_STEADY_SWEEP_REQUESTS,
  EIP3009_SWEEP_REQUESTS,
  MAX_RECHECKS_PER_SWEEP,
  ORDER_SCAN_MARGIN_SECS,
  TERMS_WINDOW_SECS,
} from '../src/constants';
import {
  catchUpEip3009,
  checkEip3009Payment,
  newScanMemory,
  recordEip3009Check,
} from '../src/eip3009';
import type { MerchantOrder } from '../src/ledger';
import { FLOOR_MARGIN_SECS } from '../src/tempo';
import { publishTerms, retireTerms } from '../src/terms';
import { orderPaidBody } from '../src/webhook';
import {
  type FakeLog,
  TRANSFER_TOPIC,
  blockHashOf,
  hexNumber,
  payWithAuthorization,
  payoutRanges,
  plainTransfer,
  receiptReads,
  registryUsdc,
  txHashOf,
  word,
} from './eip3009-chain';
import {
  EVM_PAYOUT,
  NOW,
  OTHER_PAYOUT,
  PAYER,
  PRICE,
  type Run,
  blockAt,
  nonceOf,
  orderAt,
  reportOn,
  setup,
  timeAt,
} from './eip3009-support';
import { D, signatureOf } from './fixtures';

const HASH = txHashOf(1);

/** The order's payment of `value` to `payee`, landed `block`, under `hash`. */
function pay(
  run: Run,
  order: MerchantOrder,
  options: {
    hash?: string;
    value?: bigint;
    block?: number;
    payee?: string;
    authorizer?: string;
  } = {},
): string {
  const hash = options.hash ?? HASH;
  payWithAuthorization(run.fake, {
    hash,
    authorizer: options.authorizer ?? PAYER,
    nonce: nonceOf(run, order),
    payee: options.payee ?? EVM_PAYOUT,
    value: options.value ?? PRICE,
    block: options.block ?? run.fake.safe - 10,
  });
  return hash;
}

async function sweep(run: Run, now = NOW) {
  return await catchUpEip3009(run.state, run.context, now);
}

describe('checkEip3009Payment', () => {
  it('credits a leg of the price at the credit tag, claimed once by chain, hash and nonce', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order);
    const check = await checkEip3009Payment(run.state, order, HASH, run.context);
    expect(check.kind).toBe('paid');
    expect(order.paid).toEqual({
      signature: HASH,
      amount: PRICE.toString(),
      fee: '0',
      blockTime: timeAt(run, run.fake.safe - 10),
      caip19: run.caip19,
      medium: 'base-devnet',
    });
    expect(run.state.claims).toEqual({
      [`eip155:84532:${HASH}:${nonceOf(run, order)}`]: order.key,
    });
  });

  it('never credits a leg below the price (the 90% case), and sets it aside at the tag', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order, { value: (PRICE * 9n) / 10n });
    const check = await checkEip3009Payment(run.state, order, HASH, run.context);
    expect(check).toEqual({ kind: 'no_leg' });
    recordEip3009Check(order, HASH, check);
    expect(order.paid).toBeUndefined();
    expect(order.noLegTxs).toEqual([HASH]);
    expect(run.state.claims).toEqual({});
  });

  it('is final only at the credit tag: a leg above it, or a leg-less receipt above it, is asked again', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const above = run.fake.safe + 5;
    pay(run, order, { block: above });
    const leglessHash = txHashOf(2);
    plainTransfer(run.fake, {
      hash: leglessHash,
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE,
      block: above,
    });
    expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
      kind: 'ask_again',
    });
    const legless = await checkEip3009Payment(run.state, order, leglessHash, run.context);
    expect(legless).toEqual({ kind: 'ask_again' });
    recordEip3009Check(order, leglessHash, legless);
    expect(order.noLegTxs).toBeUndefined();
    expect(order.paid).toBeUndefined();
    // The tag passes both.
    run.fake.safe = above;
    expect(await checkEip3009Payment(run.state, order, leglessHash, run.context)).toEqual({
      kind: 'no_leg',
    });
    expect((await checkEip3009Payment(run.state, order, HASH, run.context)).kind).toBe('paid');
  });

  it('with credit fast credits a leg above the credit tag, and still asks again on a leg-less one there', async () => {
    const run = setup({ credit: 'fast' });
    const order = orderAt(run, NOW - 3600);
    const above = run.fake.safe + 5;
    pay(run, order, { block: above });
    const leglessHash = txHashOf(2);
    plainTransfer(run.fake, {
      hash: leglessHash,
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE,
      block: above,
    });
    expect(await checkEip3009Payment(run.state, order, leglessHash, run.context)).toEqual({
      kind: 'ask_again',
    });
    const check = await checkEip3009Payment(run.state, order, HASH, run.context);
    expect(check.kind).toBe('paid');
    expect(order.paid?.signature).toBe(HASH);
    // The leg's block may still be reorged: its time is not cached.
    expect(run.context.samples.has(above)).toBe(false);
    expect(run.state.claims).toEqual({
      [`eip155:84532:${HASH}:${nonceOf(run, order)}`]: order.key,
    });
  });

  it('asks again on an absent or unreadable receipt, never refuses', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
      kind: 'ask_again',
    });
    pay(run, order);
    run.fake.script = (method) => {
      if (method === 'eth_getTransactionReceipt') {
        throw new Error('rpc eth_getTransactionReceipt answered HTTP 503');
      }
      return undefined;
    };
    expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
      kind: 'ask_again',
    });
  });

  describe('the block-time guard', () => {
    it('refuses an old price paid past the window after a change, and credits it within', async () => {
      const run = setup();
      const change = NOW - 2 * 3600;
      run.state.terms = publishTerms(
        run.state.terms,
        { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: (PRICE * 2n).toString() },
        change,
        change,
      );
      const order = orderAt(run, NOW - 3 * 3600);
      // Paid at the old price 30 minutes ago: the change was 90 minutes before it.
      pay(run, order, { block: blockAt(run, NOW - 1800) });
      // Refused against the old terms, no leg for the new price: final, never paid.
      const late = await checkEip3009Payment(run.state, order, HASH, run.context);
      expect(late).toEqual({ kind: 'no_leg' });
      expect(order.paid).toBeUndefined();
      // The same price paid 10 minutes after the change still stood in the window.
      const early = txHashOf(3);
      pay(run, order, { hash: early, block: blockAt(run, change + 600) });
      expect((await checkEip3009Payment(run.state, order, early, run.context)).kind).toBe('paid');
      expect(order.paid?.amount).toBe(PRICE.toString());
    });

    it('refuses a payout retired past the window, and the exact amount only', async () => {
      const run = setup();
      const change = NOW - 2 * 3600;
      run.state.terms = publishTerms(
        run.state.terms,
        { d: D, caip19: run.caip19, payout: OTHER_PAYOUT, amount: PRICE.toString() },
        change,
        change,
      );
      const order = orderAt(run, NOW - 3 * 3600);
      pay(run, order, { block: blockAt(run, NOW - 1800) });
      expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
        kind: 'no_leg',
      });
      expect(order.paid).toBeUndefined();
      const toNew = txHashOf(4);
      pay(run, order, { hash: toNew, payee: OTHER_PAYOUT, block: blockAt(run, NOW - 1800) });
      expect((await checkEip3009Payment(run.state, order, toNew, run.context)).kind).toBe('paid');
    });

    it('refuses a leg below the order floor', async () => {
      const run = setup();
      const order = orderAt(run, NOW - 3600);
      // The floor is the block 30 minutes before the order.
      pay(run, order, { block: blockAt(run, NOW - 3600 - 1800) - 1 });
      expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
        kind: 'refused',
        reason: 'not_a_payment_for_this_order',
      });
      const atFloor = txHashOf(5);
      pay(run, order, { hash: atFloor, block: blockAt(run, NOW - 3600 - 1800) });
      expect((await checkEip3009Payment(run.state, order, atFloor, run.context)).kind).toBe('paid');
    });

    it("refuses a leg of another product's price: the order's own terms only", async () => {
      const run = setup();
      run.state.terms = publishTerms(
        run.state.terms,
        { d: 'cheap', caip19: run.caip19, payout: EVM_PAYOUT, amount: '1000' },
        NOW - 5 * 86_400,
        NOW - 5 * 86_400,
      );
      const order = orderAt(run, NOW - 3600);
      pay(run, order, { value: 1000n });
      expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
        kind: 'no_leg',
      });
    });
  });
});

/** The ranges of the `eth_getLogs` for `payout` between two marks of the call log. */
function rangesBetween(
  run: Run,
  from: number,
  to: number,
  payout = EVM_PAYOUT,
): [number, number][] {
  const saved = run.fake.calls;
  run.fake.calls = saved.slice(from, to);
  const ranges = payoutRanges(run.fake, payout);
  run.fake.calls = saved;
  return ranges;
}

describe('catchUpEip3009: the scan per payout', () => {
  it('credits a payment without a reported hash, binding it once from its receipt', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order);
    const result = await sweep(run);
    expect(result.paid).toEqual([order]);
    expect(order.paid?.signature).toBe(HASH);
    const key = `eip155:84532:${HASH}:4`;
    expect(run.state.eip3009Bindings[key]).toEqual({
      state: 'bound',
      txHash: HASH,
      blockNumber: run.fake.safe - 10,
      authorizer: PAYER,
      nonce: nonceOf(run, order),
    });
  });

  it('credits a payment to a payout retired mid-order, found by the scan with no reported hash', async () => {
    const run = setup();
    const change = NOW - 2 * 3600;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: run.caip19, payout: OTHER_PAYOUT, amount: PRICE.toString() },
      change,
      change,
    );
    const order = orderAt(run, NOW - 3 * 3600);
    // Paid to the old payout 10 minutes after it was replaced.
    pay(run, order, { block: blockAt(run, change + 600) });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 3 && order.paid === undefined; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    expect(paid).toEqual([order]);
    expect(payoutRanges(run.fake, EVM_PAYOUT).length).toBeGreaterThan(0);
  });

  it('binds only at index - 1, by the same authorizer', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const block = run.fake.safe - 20;
    const nonce = nonceOf(run, order);
    // The authorization is another signer's; the transfer after it is the payer's.
    const crossed = txHashOf(10);
    const used = {
      address: run.fake.mint,
      topics: [AUTHORIZATION_USED_TOPIC, `0x${word(OTHER_PAYOUT)}`, nonce],
      data: '0x',
      blockNumber: hexNumber(block),
      blockHash: blockHashOf(block),
      transactionHash: crossed,
      logIndex: '0x0',
      removed: false,
    };
    const transfer = {
      ...used,
      topics: [TRANSFER_TOPIC, `0x${word(PAYER)}`, `0x${word(EVM_PAYOUT)}`],
      data: `0x${word(PRICE)}`,
      logIndex: '0x1',
    };
    // The order's authorization two logs before its transfer, something between.
    const apart = txHashOf(11);
    const usedApart = {
      ...used,
      topics: [AUTHORIZATION_USED_TOPIC, `0x${word(PAYER)}`, nonce],
      transactionHash: apart,
    };
    const between = { ...usedApart, topics: [`0x${'55'.repeat(32)}`], logIndex: '0x1' };
    const transferApart = { ...transfer, transactionHash: apart, logIndex: '0x2' };
    run.fake.logs.push(used, transfer, usedApart, between, transferApart);
    for (const [hash, logs] of [
      [crossed, [used, transfer]],
      [apart, [usedApart, between, transferApart]],
    ] as const) {
      run.fake.receipts.set(hash, {
        transactionHash: hash,
        status: '0x1',
        blockNumber: hexNumber(block),
        blockHash: blockHashOf(block),
        logs: [...logs],
      });
    }
    const result = await sweep(run);
    expect(result.paid).toEqual([]);
    expect(order.paid).toBeUndefined();
    expect(run.state.eip3009Bindings[`eip155:84532:${crossed}:1`]?.state).toBe('unbound');
    expect(run.state.eip3009Bindings[`eip155:84532:${apart}:2`]?.state).toBe('unbound');
  });

  it('caches a binding only from a receipt that matches the hit: tx, block hash and number', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order);
    const key = `eip155:84532:${HASH}:4`;
    const receipt = run.fake.receipts.get(HASH);
    if (receipt === undefined) {
      throw new Error('no receipt');
    }
    const forked = { ...receipt, blockHash: blockHashOf(run.fake.safe - 10, 1) };
    const scripted: unknown[] = [
      null,
      { ...receipt, transactionHash: txHashOf(99) },
      { ...forked, logs: forked.logs.map((log) => ({ ...log, blockHash: forked.blockHash })) },
      { ...receipt, blockNumber: hexNumber(run.fake.safe - 11), logs: [] },
    ];
    for (const answer of scripted) {
      run.fake.script = (method) =>
        method === 'eth_getTransactionReceipt' ? { value: answer } : undefined;
      const result = await sweep(run);
      expect(result.paid).toEqual([]);
      expect(run.state.eip3009Bindings[key]).toBeUndefined();
    }
    run.fake.script = undefined;
    expect((await sweep(run)).paid).toEqual([order]);
    expect(run.state.eip3009Bindings[key]?.state).toBe('bound');
  });

  it.each([
    [
      'a block hash',
      (log: FakeLog): FakeLog => ({
        ...log,
        blockHash: blockHashOf(Number.parseInt(log.blockNumber, 16), 1),
      }),
    ],
    [
      'a block number',
      (log: FakeLog): FakeLog => ({
        ...log,
        blockNumber: hexNumber(Number.parseInt(log.blockNumber, 16) - 1),
      }),
    ],
  ] as const)(
    'caches no binding for a hit whose log names another %s than its receipt, and binds the fresh sighting',
    async (_label, stale) => {
      const run = setup();
      const order = orderAt(run, NOW - 3600);
      pay(run, order);
      const key = `eip155:84532:${HASH}:4`;
      // A lagging backend answers the scan with the log of another fork.
      run.fake.logView = (log) => (log.transactionHash === HASH ? stale(log) : log);
      expect((await sweep(run)).paid).toEqual([]);
      expect(run.state.eip3009Bindings[key]).toBeUndefined();
      run.fake.logView = (log) => log;
      expect((await sweep(run)).paid).toEqual([order]);
      expect(run.state.eip3009Bindings[key]?.state).toBe('bound');
    },
  );

  it('matches a binding cached before its order reached the node', async () => {
    const run = setup();
    const first = orderAt(run, NOW - 3600);
    const late = orderAt(run, NOW - 3500);
    delete run.state.orders[late.key];
    pay(run, late);
    await sweep(run);
    expect(run.state.eip3009Bindings[`eip155:84532:${HASH}:4`]?.state).toBe('bound');
    run.state.orders[late.key] = late;
    const reads = receiptReads(run.fake).length;
    expect((await sweep(run)).paid).toEqual([late]);
    expect(first.paid).toBeUndefined();
    // The receipt was read again to judge the order, never to bind it again.
    expect(receiptReads(run.fake).length).toBeGreaterThan(reads);
  });

  it('drops hits below the lowest positive price with no read, and never scans for "0"-priced terms', async () => {
    const run = setup();
    run.state.terms = publishTerms(
      run.state.terms,
      { d: 'free', caip19: run.caip19, payout: EVM_PAYOUT, amount: '0' },
      NOW - 5 * 86_400,
      NOW - 5 * 86_400,
    );
    run.state.terms = publishTerms(
      run.state.terms,
      { d: 'free', caip19: run.caip19, payout: OTHER_PAYOUT, amount: '0' },
      NOW - 4 * 86_400,
      NOW - 4 * 86_400,
    );
    orderAt(run, NOW - 3600);
    const block = run.fake.safe - 30;
    plainTransfer(run.fake, { hash: txHashOf(20), from: PAYER, to: EVM_PAYOUT, value: 0n, block });
    plainTransfer(run.fake, {
      hash: txHashOf(21),
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE - 1n,
      block,
    });
    plainTransfer(run.fake, {
      hash: txHashOf(22),
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE,
      block,
    });
    plainTransfer(run.fake, {
      hash: txHashOf(23),
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block,
    });
    await sweep(run);
    expect(receiptReads(run.fake)).toEqual([txHashOf(22)]);
    // The payout with only a "0" price is never scanned.
    expect(payoutRanges(run.fake, OTHER_PAYOUT)).toEqual([]);
  });

  it('reads no chain for a store whose terms on it are all "0"', async () => {
    const run = setup();
    run.state.terms = [];
    run.state.terms = publishTerms(
      [],
      { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: '0' },
      NOW - 86_400,
      NOW - 86_400,
    );
    orderAt(run, NOW - 3600);
    await sweep(run);
    expect(run.fake.calls.filter(({ method }) => method === 'eth_getLogs')).toEqual([]);
  });

  it('prunes bindings by block number below the 3-day floor, on its own chain only', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const horizon = blockAt(run, NOW - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS - TERMS_WINDOW_SECS);
    const entry = (blockNumber: number) => ({
      state: 'unbound' as const,
      txHash: HASH,
      blockNumber,
    });
    run.state.eip3009Bindings = {
      'eip155:84532:old:0': entry(horizon - 10_000),
      'eip155:84532:kept:0': entry(run.fake.head - 200_000 + 100_000),
      'eip155:1:other:0': entry(1),
    };
    await sweep(run);
    expect(Object.keys(run.state.eip3009Bindings).sort()).toEqual([
      'eip155:1:other:0',
      'eip155:84532:kept:0',
    ]);
  });

  it('reads bindings by EIP3009_BIND_READS: reported first, then half newest, half oldest', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const hits = 41;
    const hashes: string[] = [];
    for (let index = 0; index < hits; index += 1) {
      const hash = txHashOf(100 + index);
      hashes.push(hash);
      plainTransfer(run.fake, {
        hash,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.safe - 2000 + index * 40,
      });
    }
    // One hit in the middle, reported by the order.
    const reported = hashes[20] ?? '';
    reportOn(run, order, reported);
    await sweep(run);
    const reads = receiptReads(run.fake);
    // The reported check reads it first, then the binding reads begin with it.
    expect(reads[0]).toBe(reported);
    const binding = reads.slice(1);
    expect(binding).toHaveLength(EIP3009_BIND_READS);
    const rest = hashes.filter((hash) => hash !== reported);
    const newestFirst = [...rest].reverse();
    const newest = Math.ceil((EIP3009_BIND_READS - 1) / 2);
    const oldest = EIP3009_BIND_READS - 1 - newest;
    expect(binding).toEqual([
      reported,
      ...newestFirst.slice(0, newest),
      ...newestFirst.slice(newest).slice(-oldest),
    ]);
    // The ones left are read on the next sweep.
    const before = receiptReads(run.fake).length;
    await sweep(run);
    const next = receiptReads(run.fake).slice(before);
    expect(next.filter((hash) => hash !== reported).sort()).toEqual(
      rest.slice(oldest, rest.length - newest).sort(),
    );
  });

  it('judges reported hashes and scan-bound hits under separate budgets', async () => {
    const run = setup();
    const spam: MerchantOrder[] = [];
    // Free orders, each with free bogus reports checked before the real payment last was.
    for (let index = 0; index < MAX_RECHECKS_PER_SWEEP + 5; index += 1) {
      const order = orderAt(run, NOW - 3600);
      reportOn(run, order, txHashOf(500 + index), NOW - 3000 + index);
      spam.push(order);
    }
    const order = orderAt(run, NOW - 3600);
    pay(run, order);
    // The payment's binding is cached, and it was asked about a minute ago.
    run.state.eip3009Bindings[`eip155:84532:${HASH}:4`] = {
      state: 'bound',
      txHash: HASH,
      blockNumber: run.fake.safe - 10,
      authorizer: PAYER,
      nonce: nonceOf(run, order),
    };
    order.recheckedAt = { [HASH]: NOW - 60 };
    const result = await sweep(run);
    expect(result.paid).toEqual([order]);
    const checkedReports = spam.filter(
      (each) => each.recheckedAt?.[each.reportedTxs[0] ?? ''] === NOW,
    );
    expect(checkedReports).toHaveLength(MAX_RECHECKS_PER_SWEEP);
  });
});

describe('catchUpEip3009: the rescan (money rule 7)', () => {
  /** An order a day old: its window is ~45 chunks, a full pass takes two sweeps. */
  function dayOld(paid = true) {
    const run = setup();
    const order = orderAt(run, NOW - 86_400);
    // Deep in the window, far below the recent one.
    const block = run.fake.head - 30_000;
    if (paid) {
      pay(run, order, { block });
    }
    return { run, order, block };
  }

  function blind(run: Run, block: number, answer: () => { value: unknown }) {
    run.fake.script = (method, params) => {
      const filter = params[0] as { fromBlock?: string; toBlock?: string } | undefined;
      if (
        method === 'eth_getLogs' &&
        Number.parseInt(filter?.fromBlock ?? '', 16) <= block &&
        Number.parseInt(filter?.toBlock ?? '', 16) >= block
      ) {
        return answer();
      }
      return undefined;
    };
  }

  it('credits a payment on the next pass, at the full budget, when its chunk fails on pass N', async () => {
    const { run, order, block } = dayOld();
    blind(run, block, () => {
      throw new Error('rpc eth_getLogs answered HTTP 429');
    });
    // Pass N: two sweeps, the payment's chunk failed: the pass is not clean.
    expect((await sweep(run)).paid).toEqual([]);
    run.fake.script = undefined;
    expect((await sweep(run)).paid).toEqual([]);
    expect(run.context.scan.passChunk).toBeUndefined();
    expect(run.context.scan.cleanPass).toBe(false);
    // Pass N + 1 starts again from the head at 32 and reaches the chunk at once.
    expect((await sweep(run)).paid).toEqual([order]);
  });

  it('credits a payment within the steady bound when its chunk answered [] on a clean pass N', async () => {
    const { run, order, block } = dayOld();
    blind(run, block, () => ({ value: [] }));
    expect((await sweep(run)).paid).toEqual([]);
    run.fake.script = undefined;
    expect((await sweep(run)).paid).toEqual([]);
    // Every read answered: pass N is clean, pass N + 1 runs on the steady budget.
    expect(run.context.scan.cleanPass).toBe(true);
    const cap = run.context.rangeCap;
    const chunksDown = Math.floor(run.fake.safe / cap) - Math.floor(block / cap) + 1;
    const sweepsNeeded = Math.ceil(chunksDown / EIP3009_STEADY_SWEEP_REQUESTS);
    expect(sweepsNeeded).toBeGreaterThan(1);
    for (let left = sweepsNeeded - 1; left > 0; left -= 1) {
      expect((await sweep(run)).paid).toEqual([]);
    }
    expect((await sweep(run)).paid).toEqual([order]);
  });

  it('restarts the full pass from the credit-tag block once it reaches the floor', async () => {
    const { run } = dayOld(false);
    const cap = run.context.rangeCap;
    const headChunk = Math.floor(run.fake.safe / cap);
    const floorChunk = Math.floor(blockAt(run, NOW - 86_400 - 1800) / cap);
    const chunks: number[][] = [];
    for (let sweeps = 0; sweeps < 3; sweeps += 1) {
      const mark = run.fake.calls.length;
      await sweep(run);
      chunks.push(
        rangesBetween(run, mark, run.fake.calls.length).map(([from]) => Math.floor(from / cap)),
      );
    }
    // Each sweep: the recent window (the three chunks under the head), then the pass.
    const recent = [headChunk, headChunk - 1, headChunk - 2];
    expect(chunks[0]?.slice(0, 3)).toEqual(recent);
    expect(chunks[0]?.slice(3, 5)).toEqual([headChunk, headChunk - 1]);
    // The second sweep goes on where the first stopped, down to the floor.
    expect(chunks[1]?.slice(0, 3)).toEqual(recent);
    expect(chunks[1]?.[3]).toBe((chunks[0]?.at(-1) ?? 0) - 1);
    expect(chunks[1]?.at(-1)).toBe(floorChunk);
    expect(chunks[2]?.slice(0, 3)).toEqual(recent);
    expect(chunks[2]?.slice(3, 5)).toEqual([headChunk, headChunk - 1]);
  });

  it('scans the recent window every sweep, whatever the full pass budget', async () => {
    const { run } = dayOld(false);
    await sweep(run);
    // The pass is now deep in the window; a fresh payment lands just under the head.
    const order = orderAt(run, NOW - 600);
    pay(run, order, { hash: txHashOf(7), block: run.fake.safe });
    expect((await sweep(run)).paid).toEqual([order]);
  });

  it('halves a chunk on a range error in a non-Tempo wording', async () => {
    const run = setup({ providerCap: 300 });
    const order = orderAt(run, NOW - 3600);
    pay(run, order);
    expect((await sweep(run)).paid).toEqual([order]);
    const ranges = payoutRanges(run.fake, EVM_PAYOUT);
    expect(ranges.some(([from, to]) => to - from + 1 === 1000)).toBe(true);
    expect(ranges.some(([from, to]) => to - from + 1 <= 300)).toBe(true);
  });

  it('logs a chunk failing across passes: older payments may be missed', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const block = run.fake.safe - 100;
    blind(run, block, () => {
      throw new Error('rpc eth_getLogs answered HTTP 503');
    });
    const first = await sweep(run);
    expect(first.warnings ?? []).toEqual([]);
    const second = await sweep(run);
    expect(second.warnings).toEqual([
      expect.stringMatching(
        /^Base Sepolia: blocks \d+-\d+ of transfers to 0x5696.* failed on \d sweeps in a row; older payments on Base Sepolia may be missed$/,
      ),
    ]);
    run.fake.script = undefined;
    await sweep(run);
    expect((await sweep(run)).warnings ?? []).toEqual([]);
  });
});

describe('catchUpEip3009: the USDC implementation pin', () => {
  function withHits() {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    // Another order stays open: the sweeps go on after the first is paid.
    orderAt(run, NOW - 3600);
    pay(run, order);
    const spam = txHashOf(30);
    plainTransfer(run.fake, {
      hash: spam,
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 40,
    });
    return { run, order, spamKey: `eip155:84532:${spam}:0` };
  }

  it('warns on a mismatched implementation and caches no unbound, but credits bound hits', async () => {
    const { run, order, spamKey } = withHits();
    run.fake.implementation = `0x${'99'.repeat(20)}`;
    const result = await sweep(run);
    expect(result.paid).toEqual([order]);
    expect(run.state.eip3009Bindings[spamKey]).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `WARNING: Base Sepolia: the USDC proxy runs implementation 0x${'99'.repeat(20)}, not the pinned`,
      ),
    ]);
  });

  it('caches no unbound on a sweep whose implementation read errs, and does on the next', async () => {
    const { run, spamKey } = withHits();
    run.fake.script = (method) => {
      if (method === 'eth_getStorageAt') {
        throw new Error('rpc eth_getStorageAt answered HTTP 502');
      }
      return undefined;
    };
    const result = await sweep(run);
    expect(run.state.eip3009Bindings[spamKey]).toBeUndefined();
    expect(result.warnings?.[0]).toMatch(/the USDC implementation could not be read/);
    run.fake.script = undefined;
    await sweep(run);
    expect(run.state.eip3009Bindings[spamKey]?.state).toBe('unbound');
  });

  it('reads the implementation pinned to the credit-tag block by hash', async () => {
    const { run } = withHits();
    await sweep(run);
    const reads = run.fake.calls.filter(({ method }) => method === 'eth_getStorageAt');
    expect(reads.map(({ params }) => params[2])).toEqual([
      { blockHash: blockHashOf(run.fake.safe), requireCanonical: true },
    ]);
  });
});

describe('catchUpEip3009: reported hashes', () => {
  it('checks a hash reported on this chain only, and keeps a final verdict', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const legless = txHashOf(40);
    plainTransfer(run.fake, {
      hash: legless,
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 5,
    });
    reportOn(run, order, legless);
    // A hash reported for Tempo is not this chain's.
    order.reportedTxs.push(txHashOf(41));
    await sweep(run);
    expect(order.noLegTxs).toEqual([legless]);
    expect(receiptReads(run.fake)).not.toContain(txHashOf(41));
    const reads = receiptReads(run.fake).length;
    await sweep(run);
    expect(receiptReads(run.fake).filter((hash) => hash === legless)).toHaveLength(
      receiptReads(run.fake)
        .slice(0, reads)
        .filter((hash) => hash === legless).length,
    );
  });
});

describe('catchUpEip3009: review round 1', () => {
  it('scans down to the lowest price of a payout: a price lowered mid-window is credited without a report', async () => {
    const run = setup();
    run.state.terms = publishTerms(
      [],
      { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: (PRICE * 2n).toString() },
      NOW - 5 * 86_400,
      NOW - 5 * 86_400,
    );
    const change = NOW - 2 * 3600;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: PRICE.toString() },
      change,
      change,
    );
    const order = orderAt(run, NOW - 3600);
    pay(run, order);
    expect((await sweep(run)).paid).toEqual([order]);
    expect(order.paid?.amount).toBe(PRICE.toString());
  });

  /** `count` orders, each with a hash nobody can read yet: every check asks again. */
  function waiting(run: Run, count: number, queue: 'reported' | 'bound'): MerchantOrder[] {
    const orders: MerchantOrder[] = [];
    for (let index = 0; index < count; index += 1) {
      const order = orderAt(run, NOW - 3600);
      const hash = txHashOf(700 + index);
      if (queue === 'reported') {
        reportOn(run, order, hash, NOW - 3000 + index);
      } else {
        run.state.eip3009Bindings[`eip155:84532:${hash}:0`] = {
          state: 'bound',
          txHash: hash,
          blockNumber: run.fake.safe - 10,
          authorizer: PAYER,
          nonce: nonceOf(run, order),
        };
        order.recheckedAt = { [hash]: NOW - 3000 + index };
      }
      orders.push(order);
    }
    return orders;
  }

  it.each(['reported', 'bound'] as const)(
    'reaches every %s hash within a few sweeps, oldest check first: none starves',
    async (queue) => {
      const run = setup();
      const orders = waiting(run, MAX_RECHECKS_PER_SWEEP + 5, queue);
      await sweep(run, NOW);
      await sweep(run, NOW + 60);
      const unchecked = orders.filter((order) =>
        Object.values(order.recheckedAt ?? {}).every((at) => at < NOW),
      );
      expect(unchecked).toEqual([]);
    },
  );

  it('keeps hits waiting for a binding read across sweeps, also those only the full pass found', async () => {
    const run = setup();
    orderAt(run, NOW - 86_400);
    const hashes: string[] = [];
    // Deep in the window: only the first sweep's full pass reads these blocks.
    for (let index = 0; index < EIP3009_BIND_READS + 8; index += 1) {
      const hash = txHashOf(800 + index);
      hashes.push(hash);
      plainTransfer(run.fake, {
        hash,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.head - 20_000 + index,
      });
    }
    await sweep(run);
    expect(Object.keys(run.state.eip3009Bindings)).toHaveLength(EIP3009_BIND_READS);
    await sweep(run);
    expect(Object.keys(run.state.eip3009Bindings).sort()).toEqual(
      hashes.map((hash) => `eip155:84532:${hash}:0`).sort(),
    );
  });

  it('counts the halvings of a chunk against the full pass budget', async () => {
    const run = setup({ providerCap: 300 });
    orderAt(run, NOW - 86_400);
    await sweep(run);
    // The recent window (3 chunks) and the pass, each chunk 6 requests at this cap:
    // the pass stops at its budget, one chunk of overshoot at most.
    const requests = run.fake.calls.filter(({ method }) => method === 'eth_getLogs').length;
    expect(requests).toBeLessThanOrEqual(3 * 6 + EIP3009_SWEEP_REQUESTS + 6);
  });

  it('keeps a refused hash and never reads it again', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order, { block: blockAt(run, NOW - 3600 - 1800) - 10 });
    reportOn(run, order, HASH);
    await sweep(run);
    expect(order.refusedTxs).toEqual([HASH]);
    const reads = receiptReads(run.fake).length;
    await sweep(run, NOW + 60);
    expect(receiptReads(run.fake).slice(reads)).not.toContain(HASH);
  });

  it('never judges again a scan-bound hit already judged for its order', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order, { value: PRICE - 1n });
    // The 90% hit is above the drop threshold of another, cheaper product.
    run.state.terms = publishTerms(
      run.state.terms,
      { d: 'cheap', caip19: run.caip19, payout: EVM_PAYOUT, amount: '1000' },
      NOW - 86_400,
      NOW - 86_400,
    );
    await sweep(run);
    expect(order.noLegTxs).toEqual([HASH]);
    const reads = receiptReads(run.fake).length;
    await sweep(run, NOW + 60);
    expect(receiptReads(run.fake).slice(reads)).toEqual([]);
  });

  it('warns and scans nothing when the finalized block alone cannot be read', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    let lastTag: unknown;
    run.fake.script = (method, params) => {
      if (method !== 'eth_getBlockByNumber') {
        return undefined;
      }
      const tag = params[0];
      const answer = tag === 'finalized' && lastTag === 'safe' ? { value: null } : undefined;
      lastTag = tag;
      return answer;
    };
    const result = await sweep(run);
    expect(result.warnings).toEqual([
      "Base Sepolia: the chain's head could not be read; payments there were not scanned this time",
    ]);
    expect(payoutRanges(run.fake, EVM_PAYOUT)).toEqual([]);
  });
});

describe('catchUpEip3009: review round 2', () => {
  it('scans from the OLDEST open order: a hash-less payment of an old order below a new order floor is credited', async () => {
    const run = setup();
    const old = orderAt(run, NOW - 86_400);
    orderAt(run, NOW - 600);
    // Below the new order's floor, far below the recent window.
    pay(run, old, { block: run.fake.head - 30_000 });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 3 && old.paid === undefined; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    expect(paid).toEqual([old]);
  });

  it("takes the threshold from every open order's terms: an old order's retired lower price still binds", async () => {
    const run = setup();
    const change = NOW - 5 * 3600;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: (PRICE * 2n).toString() },
      change,
      change,
    );
    const old = orderAt(run, NOW - 6 * 3600);
    orderAt(run, NOW - 600);
    // The old order pays its own (lower) price before the change, with no receipt.
    pay(run, old, { block: blockAt(run, change - 600) });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 3 && old.paid === undefined; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    expect(paid).toEqual([old]);
    expect(old.paid?.amount).toBe(PRICE.toString());
  });

  it('refuses a leg whose payout and amount stand only on another chain: the caip19 must match too', async () => {
    const run = setup();
    const arbitrum = registryUsdc('eip155:421614');
    const arbitrumUsdc = `${arbitrum.chain.caip2}/erc20:${(arbitrum.asset.mint ?? '').toLowerCase()}`;
    const retire = NOW - 2 * 3600;
    // The Base terms retire; the same address and amount stay offered on Arbitrum.
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: arbitrumUsdc, payout: EVM_PAYOUT, amount: PRICE.toString() },
      NOW - 5 * 86_400,
      NOW - 5 * 86_400,
    );
    run.state.terms = retireTerms(run.state.terms, D, [arbitrumUsdc], retire);
    const order = orderAt(run, NOW - 3 * 3600);
    pay(run, order, { block: blockAt(run, NOW - 1800) });
    expect(await checkEip3009Payment(run.state, order, HASH, run.context)).toEqual({
      kind: 'refused',
      reason: 'not_a_payment_for_this_order',
    });
    // Within the window it still pays.
    const early = txHashOf(9);
    pay(run, order, { hash: early, block: blockAt(run, retire + 600) });
    expect((await checkEip3009Payment(run.state, order, early, run.context)).kind).toBe('paid');
  });

  it('reads the payouts left in a chunk where the budget ran out on the next sweep, never skipping one', async () => {
    const run = setup();
    for (const [d, payout] of [
      ['b', OTHER_PAYOUT],
      ['c', PAYER],
    ] as const) {
      run.state.terms = publishTerms(
        run.state.terms,
        { d, caip19: run.caip19, payout, amount: PRICE.toString() },
        NOW - 5 * 86_400,
        NOW - 5 * 86_400,
      );
    }
    orderAt(run, NOW - 86_400);
    const cap = run.context.rangeCap;
    // Every sweep's 32 requests over three payouts end inside a chunk: run the pass to its end.
    await sweep(run);
    let sweeps = 1;
    while (run.context.scan.passChunk !== undefined && sweeps < 10) {
      await sweep(run);
      sweeps += 1;
    }
    expect(sweeps).toBeGreaterThan(2);
    const chunksOf = (payout: string) =>
      new Set(payoutRanges(run.fake, payout).map(([from]) => Math.floor(from / cap)));
    const first = chunksOf(EVM_PAYOUT);
    const floorChunk = Math.floor(blockAt(run, NOW - 86_400 - 1800) / cap);
    expect(first.has(floorChunk)).toBe(true);
    expect(first.size).toBe(Math.floor(run.fake.safe / cap) - floorChunk + 1);
    expect(chunksOf(OTHER_PAYOUT)).toEqual(first);
    expect(chunksOf(PAYER)).toEqual(first);
  });

  it('prunes bindings on both sides of the 3-day floor block, exactly', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    // `blockAtTime` never reaches below the catch-up lookback of the finalized block.
    const horizon = blockAt(
      run,
      Math.max(
        NOW - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS - TERMS_WINDOW_SECS,
        timeAt(run, run.fake.finalized) - CATCH_UP_SECS - FLOOR_MARGIN_SECS,
      ),
    );
    const entry = (blockNumber: number) => ({
      state: 'unbound' as const,
      txHash: HASH,
      blockNumber,
    });
    run.state.eip3009Bindings = {
      // The kept entry first: every entry is looked at, not only the first.
      'eip155:84532:at:0': entry(horizon),
      'eip155:84532:below:0': entry(horizon - 1),
    };
    // The scan's failure counts, of chunks and of receipts, on both sides too.
    const failure = (block: number) => ({ count: 1, block, sweep: 0 });
    run.context.scan.failures = new Map([
      [`${EVM_PAYOUT}:2`, failure(horizon)],
      [`${EVM_PAYOUT}:1`, failure(horizon - 1)],
      ['bind:at', failure(horizon)],
      ['bind:below', failure(horizon - 1)],
    ]);
    await sweep(run);
    expect(Object.keys(run.state.eip3009Bindings)).toEqual(['eip155:84532:at:0']);
    expect([...run.context.scan.failures.keys()]).toEqual([`${EVM_PAYOUT}:2`, 'bind:at']);
  });

  it('prunes waiting hits at the 3-day floor block also when no payout is in reach', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    // No terms on this chain: nothing is scanned, the waiting hits are still pruned.
    run.state.terms = [];
    const horizon = blockAt(
      run,
      Math.max(
        NOW - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS - TERMS_WINDOW_SECS,
        timeAt(run, run.fake.finalized) - CATCH_UP_SECS - FLOOR_MARGIN_SECS,
      ),
    );
    const waitingAt = (block: number) => ({
      hit: {
        txHash: HASH,
        blockNumber: block,
        blockHash: blockHashOf(block),
        logIndex: 0,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
      },
      waited: 0,
    });
    run.context.scan.pending = new Map([
      ['at', waitingAt(horizon)],
      ['below', waitingAt(horizon - 1)],
    ]);
    await sweep(run);
    expect([...run.context.scan.pending.keys()]).toEqual(['at']);
  });

  it('never reads again the receipt of a hit whose binding is cached, though the scan finds it every sweep', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const hash = txHashOf(80);
    plainTransfer(run.fake, {
      hash,
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 5,
    });
    await sweep(run);
    expect(run.state.eip3009Bindings[`eip155:84532:${hash}:0`]?.state).toBe('unbound');
    const reads = receiptReads(run.fake).length;
    await sweep(run, NOW + 60);
    expect(receiptReads(run.fake).slice(reads)).toEqual([]);
    expect(run.context.scan.pending.size).toBe(0);
  });

  it('counts failures in a row only: a read that worked in between starts the count again', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const failing = () => {
      run.fake.script = (method, params) => {
        const filter = params[0] as { toBlock?: string } | undefined;
        if (method === 'eth_getLogs' && filter?.toBlock === `0x${run.fake.safe.toString(16)}`) {
          throw new Error('rpc eth_getLogs answered HTTP 503');
        }
        return undefined;
      };
    };
    failing();
    expect((await sweep(run)).warnings ?? []).toEqual([]);
    run.fake.script = undefined;
    expect((await sweep(run, NOW + 60)).warnings ?? []).toEqual([]);
    expect(run.context.scan.failures.size).toBe(0);
    failing();
    expect((await sweep(run, NOW + 120)).warnings ?? []).toEqual([]);
  });

  it('starts the next full pass from the head once no order is open', async () => {
    const run = setup();
    for (const [d, payout] of [
      ['b', OTHER_PAYOUT],
      ['c', PAYER],
    ] as const) {
      run.state.terms = publishTerms(
        run.state.terms,
        { d, caip19: run.caip19, payout, amount: PRICE.toString() },
        NOW - 5 * 86_400,
        NOW - 5 * 86_400,
      );
    }
    const order = orderAt(run, NOW - 86_400);
    await sweep(run);
    // Three payouts: the budget ran out inside a chunk.
    expect(run.context.scan.passChunk).toBeDefined();
    expect(run.context.scan.passDone.size).toBeGreaterThan(0);
    delete run.state.orders[order.key];
    await sweep(run);
    expect(run.context.scan.passChunk).toBeUndefined();
    expect(run.context.scan.passDone.size).toBe(0);
  });
});

describe('catchUpEip3009: review round 3 (foreign entries, pending prune)', () => {
  it('judges only hashes reported on its own chain: Solana, Tempo and Arbitrum reports are left alone', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const foreign = {
      solana: signatureOf(3),
      tempo: txHashOf(61),
      arbitrum: txHashOf(62),
      legacy: txHashOf(63),
    };
    order.reportedTxs.push(foreign.solana, foreign.tempo, foreign.arbitrum, foreign.legacy);
    order.reportedMedia = {
      [foreign.solana]: 'solana-devnet',
      [foreign.tempo]: 'tempo-moderato',
      [foreign.arbitrum]: 'arbitrum-devnet',
    };
    await sweep(run);
    expect(receiptReads(run.fake)).toEqual([]);
    expect(order.recheckedAt).toBeUndefined();
    expect(order.refusedTxs).toBeUndefined();
    expect(order.noLegTxs).toBeUndefined();
  });

  it('reads first only the hits reported on its own chain', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const hashes: string[] = [];
    for (let index = 0; index < EIP3009_BIND_READS + 9; index += 1) {
      const hash = txHashOf(1100 + index);
      hashes.push(hash);
      plainTransfer(run.fake, {
        hash,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.safe - 2000 + index * 40,
      });
    }
    // The middle hash, reported for Arbitrum: no reason to read it first on Base.
    const middle = hashes[20] ?? '';
    order.reportedTxs.push(middle);
    order.reportedMedia = { [middle]: 'arbitrum-devnet' };
    await sweep(run);
    const newestFirst = [...hashes].reverse();
    const newest = Math.ceil(EIP3009_BIND_READS / 2);
    expect(receiptReads(run.fake)).toEqual([
      ...newestFirst.slice(0, newest),
      ...newestFirst.slice(newest).slice(-(EIP3009_BIND_READS - newest)),
    ]);
  });

  it("never scans another chain's payout, nor counts its price toward the threshold", async () => {
    const run = setup();
    const arbitrum = registryUsdc('eip155:421614');
    const arbitrumUsdc = `${arbitrum.chain.caip2}/erc20:${(arbitrum.asset.mint ?? '').toLowerCase()}`;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: arbitrumUsdc, payout: OTHER_PAYOUT, amount: '1000' },
      NOW - 86_400,
      NOW - 86_400,
    );
    run.state.terms = publishTerms(
      run.state.terms,
      { d: 'other', caip19: arbitrumUsdc, payout: EVM_PAYOUT, amount: '1000' },
      NOW - 86_400,
      NOW - 86_400,
    );
    orderAt(run, NOW - 3600);
    plainTransfer(run.fake, {
      hash: txHashOf(64),
      from: PAYER,
      to: EVM_PAYOUT,
      value: 1000n,
      block: run.fake.safe - 5,
    });
    await sweep(run);
    expect(payoutRanges(run.fake, OTHER_PAYOUT)).toEqual([]);
    // Below every Base price: dropped with no read.
    expect(receiptReads(run.fake)).toEqual([]);
  });

  it('keeps a waiting hit just above the floor and binds it; drops one just below it', async () => {
    const run = setup();
    orderAt(run, NOW - 86_400);
    const floor = blockAt(run, NOW - 86_400 - 1800);
    const waiting = (seed: number, block: number) => {
      const hash = txHashOf(seed);
      plainTransfer(run.fake, { hash, from: PAYER, to: EVM_PAYOUT, value: PRICE, block });
      run.context.scan.pending.set(`eip155:84532:${hash}:0`, {
        hit: {
          txHash: hash,
          blockNumber: block,
          blockHash: blockHashOf(block),
          logIndex: 0,
          from: PAYER,
          to: EVM_PAYOUT,
          value: PRICE,
        },
        waited: 1,
      });
      return hash;
    };
    // Found by an earlier pass; this sweep's pass does not reach the floor's chunk.
    const above = waiting(70, floor + 1);
    const below = waiting(71, floor - 1);
    await sweep(run);
    expect(run.state.eip3009Bindings[`eip155:84532:${above}:0`]?.state).toBe('unbound');
    expect(receiptReads(run.fake)).not.toContain(below);
    expect(run.context.scan.pending.has(`eip155:84532:${below}:0`)).toBe(false);
  });
});

describe('catchUpEip3009: review round 6 (boundaries)', () => {
  it('records what the leg paid, not the price: an overpayment and its webhook carry the leg value', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    pay(run, order, { value: PRICE + 1n });
    const outbox = { storePubkey: run.store.pubkey, now: () => NOW };
    expect(
      (await checkEip3009Payment(run.state, order, HASH, { ...run.context, outbox })).kind,
    ).toBe('paid');
    expect(order.paid?.amount).toBe((PRICE + 1n).toString());
    const entry = order.webhook;
    if (entry === undefined) {
      throw new Error('no webhook queued');
    }
    expect(
      JSON.parse(orderPaidBody(order, entry, { storePubkey: run.store.pubkey })),
    ).toMatchObject({
      payment: {
        amount: (PRICE + 1n).toString(),
        fee: '0',
        net: (PRICE + 1n).toString(),
        amountDisplay: '5.000001',
        tx: HASH,
        medium: 'base-devnet',
      },
    });
  });

  it('binds and credits a waiting hit at exactly the floor block', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 86_400);
    const floor = blockAt(run, NOW - 86_400 - 1800);
    pay(run, order, { block: floor });
    // Found by an earlier pass; this sweep's pass does not reach the floor's chunk.
    run.context.scan.pending.set(`eip155:84532:${HASH}:4`, {
      hit: {
        txHash: HASH,
        blockNumber: floor,
        blockHash: blockHashOf(floor),
        logIndex: 4,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
      },
      waited: 1,
    });
    expect((await sweep(run)).paid).toEqual([order]);
  });

  it('takes as candidates the terms in reach of a leg up to the scan margin before the order', async () => {
    const run = setup();
    const createdAt = NOW - 6 * 3600;
    // The price doubled an hour before the order: a leg 20 minutes before the
    // order may still pay the old price (the window reaches 45 minutes back).
    const change = createdAt - 3600;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: (PRICE * 2n).toString() },
      change,
      change,
    );
    const order = orderAt(run, createdAt);
    pay(run, order, { block: blockAt(run, createdAt - 1200) });
    expect((await checkEip3009Payment(run.state, order, HASH, run.context)).kind).toBe('paid');
    expect(order.paid?.amount).toBe(PRICE.toString());
  });

  it('finds that same hash-less leg by the scan: the floor, the threshold and the candidates all reach before the order', async () => {
    const run = setup();
    const createdAt = NOW - 6 * 3600;
    const change = createdAt - 3600;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: run.caip19, payout: EVM_PAYOUT, amount: (PRICE * 2n).toString() },
      change,
      change,
    );
    const order = orderAt(run, createdAt);
    pay(run, order, { block: blockAt(run, createdAt - 1200) });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 3 && order.paid === undefined; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    expect(paid).toEqual([order]);
  });

  it('judges a cached binding only for the order owning its nonce', async () => {
    const run = setup();
    const orders = [orderAt(run, NOW - 3600), orderAt(run, NOW - 1800)];
    const foreign = txHashOf(90);
    plainTransfer(run.fake, {
      hash: foreign,
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 5,
    });
    run.state.eip3009Bindings[`eip155:84532:${foreign}:0`] = {
      state: 'bound',
      txHash: foreign,
      blockNumber: run.fake.safe - 5,
      authorizer: PAYER,
      nonce: `0x${'fa'.repeat(32)}`,
    };
    await sweep(run);
    expect(receiptReads(run.fake)).not.toContain(foreign);
    for (const order of orders) {
      expect(order.noLegTxs).toBeUndefined();
      expect(order.recheckedAt).toBeUndefined();
    }
  });

  it('scans the recent window down to exactly its first block, every sweep', async () => {
    const run = setup();
    orderAt(run, NOW - 86_400);
    await sweep(run);
    // The pass is deep now; the recent window starts an hour of blocks below finalized.
    const recentFrom = run.fake.finalized - 1800;
    const atEdge = orderAt(run, NOW - 3 * 3600);
    const pastEdge = orderAt(run, NOW - 3 * 3600);
    pay(run, atEdge, { hash: txHashOf(91), block: recentFrom });
    pay(run, pastEdge, { hash: txHashOf(92), block: recentFrom - 1 });
    const paid = (await sweep(run, NOW + 60)).paid;
    expect(paid).toEqual([atEdge]);
  });

  it('reads the last block of every chunk in the full pass', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 86_400);
    // Deep, at a chunk's last block.
    pay(run, order, { block: run.fake.head - 30_000 + 999 - ((run.fake.head - 30_000) % 1000) });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 3 && order.paid === undefined; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    expect(paid).toEqual([order]);
  });

  it('reads the floor block itself when it is the last block of its chunk', async () => {
    const run = setup();
    // An order whose floor (30 minutes before it) is the last block of a chunk.
    const deep = blockAt(run, NOW - 86_400 - 1800);
    const floor = deep - (deep % 1000) + 999 - 1000;
    const order = orderAt(run, timeAt(run, floor) + 1800);
    expect(blockAt(run, order.createdAt - 1800)).toBe(floor);
    pay(run, order, { block: floor });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 4 && order.paid === undefined; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    expect(paid).toEqual([order]);
  });
});

describe('catchUpEip3009: the full pass budget, exactly', () => {
  it('makes exactly EIP3009_SWEEP_REQUESTS pass requests in a sweep, besides the recent window', async () => {
    const run = setup();
    orderAt(run, NOW - 86_400);
    await sweep(run);
    const requests = run.fake.calls.filter(({ method }) => method === 'eth_getLogs').length;
    // The recent window is three chunks under the head.
    expect(requests).toBe(3 + EIP3009_SWEEP_REQUESTS);
  });

  it('ends the pass in the sweep that reads its last chunk with the last request', async () => {
    const run = setup();
    const cap = run.context.rangeCap;
    const headChunk = Math.floor(run.fake.safe / cap);
    // A window of exactly EIP3009_SWEEP_REQUESTS chunks.
    const floorBlock = (headChunk - EIP3009_SWEEP_REQUESTS + 1) * cap + 500;
    const order = orderAt(run, timeAt(run, floorBlock) + 1800);
    expect(Math.floor(blockAt(run, order.createdAt - 1800) / cap)).toBe(
      headChunk - EIP3009_SWEEP_REQUESTS + 1,
    );
    await sweep(run);
    expect(run.context.scan.passChunk).toBeUndefined();
  });
});

describe('catchUpEip3009: the steady budget after a clean pass', () => {
  /** A day-old order: a pass is ~45 chunks, two sweeps at 32; the recent window is three. */
  const RECENT = 3;

  async function logReads(run: Run, now = NOW): Promise<number> {
    run.fake.calls.length = 0;
    await sweep(run, now);
    return run.fake.calls.filter(({ method }) => method === 'eth_getLogs').length;
  }

  async function clean() {
    const run = setup();
    const order = orderAt(run, NOW - 86_400);
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
    expect(run.context.scan.cleanPass).toBe(false);
    await sweep(run);
    expect(run.context.scan.passChunk).toBeUndefined();
    expect(run.context.scan.cleanPass).toBe(true);
    return { run, order };
  }

  /** Fail every `eth_getLogs` whose range holds `block`. */
  function failAt(run: Run, block: number) {
    run.fake.script = (method, params) => {
      const filter = params[0] as { fromBlock?: string; toBlock?: string } | undefined;
      if (
        method === 'eth_getLogs' &&
        Number.parseInt(filter?.fromBlock ?? '', 16) <= block &&
        Number.parseInt(filter?.toBlock ?? '', 16) >= block
      ) {
        throw new Error('rpc eth_getLogs answered HTTP 429');
      }
      return undefined;
    };
  }

  it('runs the pass on EIP3009_SWEEP_REQUESTS until a clean pass, then on EIP3009_STEADY_SWEEP_REQUESTS', async () => {
    const { run } = await clean();
    expect(await logReads(run)).toBe(RECENT + EIP3009_STEADY_SWEEP_REQUESTS);
    expect(await logReads(run)).toBe(RECENT + EIP3009_STEADY_SWEEP_REQUESTS);
  });

  it('goes back to the full budget after a failed pass read, until a pass started after it is clean', async () => {
    const { run } = await clean();
    // The first chunk below the recent window: read by the steady pass's first sweep.
    failAt(run, run.fake.safe - 4 * run.context.rangeCap);
    await sweep(run);
    run.fake.script = undefined;
    expect(run.context.scan.cleanPass).toBe(false);
    expect(run.context.scan.passDirty).toBe(true);
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
    // That pass reaches its floor dirty: still the full budget for the next one.
    for (let sweeps = 0; sweeps < 8 && run.context.scan.passChunk !== undefined; sweeps += 1) {
      await sweep(run);
    }
    expect(run.context.scan.passChunk).toBeUndefined();
    expect(run.context.scan.cleanPass).toBe(false);
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
    // The pass started after the failure reads every chunk: clean, back to the steady budget.
    for (let sweeps = 0; sweeps < 8 && run.context.scan.passChunk !== undefined; sweeps += 1) {
      await sweep(run);
    }
    expect(run.context.scan.cleanPass).toBe(true);
    expect(await logReads(run)).toBe(RECENT + EIP3009_STEADY_SWEEP_REQUESTS);
  });

  it('goes back to the full budget after a failed recent-window read', async () => {
    const { run } = await clean();
    failAt(run, run.fake.safe);
    await sweep(run);
    run.fake.script = undefined;
    expect(run.context.scan.cleanPass).toBe(false);
    // The pass of that sweep read the failing head chunk too: it ends dirty.
    for (let sweeps = 0; sweeps < 8 && run.context.scan.passChunk !== undefined; sweeps += 1) {
      await sweep(run);
    }
    expect(run.context.scan.cleanPass).toBe(false);
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
  });

  it('gives the pass the full budget in the sweep whose recent window failed, and a pass it starts can be clean', async () => {
    const { run } = await clean();
    // Exactly one failure: the first recent-window read of the head chunk.
    let failed = false;
    run.fake.script = (method) => {
      if (method === 'eth_getLogs' && !failed) {
        failed = true;
        throw new Error('rpc eth_getLogs answered HTTP 429');
      }
      return undefined;
    };
    const reads = await logReads(run);
    run.fake.script = undefined;
    // The failed read and the recent window, then a pass on the full budget, not the steady one.
    expect(reads).toBeGreaterThanOrEqual(RECENT + EIP3009_SWEEP_REQUESTS);
    expect(run.context.scan.cleanPass).toBe(false);
    // That pass started after the failure and read the failed blocks itself: it ends clean.
    for (let sweeps = 0; sweeps < 8 && run.context.scan.passChunk !== undefined; sweeps += 1) {
      await sweep(run);
    }
    expect(run.context.scan.cleanPass).toBe(true);
    expect(await logReads(run)).toBe(RECENT + EIP3009_STEADY_SWEEP_REQUESTS);
  });

  it('goes back to the full budget after a sweep that could not read the head', async () => {
    const { run } = await clean();
    run.fake.script = (method, params) =>
      method === 'eth_getBlockByNumber' && params[0] === 'safe' ? { value: null } : undefined;
    expect(await logReads(run)).toBe(0);
    run.fake.script = undefined;
    expect(run.context.scan.cleanPass).toBe(false);
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
  });

  it('goes back to the full budget after a sweep that threw', async () => {
    const { run } = await clean();
    const samples = run.context.samples;
    class Broken extends Map<number, number> {
      override get(): number | undefined {
        throw new Error('broken samples');
      }
    }
    run.context.samples = new Broken();
    await expect(sweep(run)).rejects.toThrow('broken samples');
    run.context.samples = samples;
    expect(run.context.scan.cleanPass).toBe(false);
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
  });

  it('starts again on the full budget after a restart', async () => {
    const { run } = await clean();
    run.context.scan = newScanMemory();
    expect(await logReads(run)).toBe(RECENT + EIP3009_SWEEP_REQUESTS);
  });

  it('credits a payment exactly once across the switch from the full to the steady budget', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 86_400);
    // An unpaid order keeps the scan running after the payment is credited.
    orderAt(run, NOW - 86_400);
    // Below the recent window: read by the first pass at 32 and again by the steady passes.
    pay(run, order, { block: run.fake.head - 30_000 });
    const paid: MerchantOrder[] = [];
    for (let sweeps = 0; sweeps < 12; sweeps += 1) {
      paid.push(...(await sweep(run)).paid);
    }
    // The payment's chunk was read again on the steady budget: still credited once.
    expect(run.context.scan.cleanPass).toBe(true);
    expect(paid).toEqual([order]);
  });

  it('keeps a clean pass across sweeps with no open order', async () => {
    const { run } = await clean();
    const orders = run.state.orders;
    run.state.orders = {};
    expect(await logReads(run)).toBe(0);
    run.state.orders = orders;
    expect(run.context.scan.cleanPass).toBe(true);
    expect(await logReads(run)).toBe(RECENT + EIP3009_STEADY_SWEEP_REQUESTS);
  });
});

describe('catchUpEip3009: review round 7 (every element, exact counts)', () => {
  it('reads EVERY payout in the recent window: a fresh payment to the current payout after a payout change', async () => {
    const run = setup();
    const change = NOW - 2 * 3600;
    run.state.terms = publishTerms(
      run.state.terms,
      { d: D, caip19: run.caip19, payout: OTHER_PAYOUT, amount: PRICE.toString() },
      change,
      change,
    );
    orderAt(run, NOW - 86_400);
    await sweep(run);
    const order = orderAt(run, NOW - 600);
    pay(run, order, { hash: txHashOf(7), payee: OTHER_PAYOUT, block: run.fake.safe });
    expect((await sweep(run)).paid).toEqual([order]);
  });

  it('reads each payout once per chunk over a whole pass, resumes mid-chunk included: exact request count', async () => {
    const run = setup();
    for (const [d, payout] of [
      ['b', OTHER_PAYOUT],
      ['c', PAYER],
    ] as const) {
      run.state.terms = publishTerms(
        run.state.terms,
        { d, caip19: run.caip19, payout, amount: PRICE.toString() },
        NOW - 5 * 86_400,
        NOW - 5 * 86_400,
      );
    }
    orderAt(run, NOW - 86_400);
    const cap = run.context.rangeCap;
    let sweeps = 0;
    do {
      await sweep(run);
      sweeps += 1;
    } while (run.context.scan.passChunk !== undefined && sweeps < 10);
    const headChunk = Math.floor(run.fake.safe / cap);
    const floorChunk = Math.floor(blockAt(run, NOW - 86_400 - 1800) / cap);
    const passChunks = headChunk - floorChunk + 1;
    for (const payout of [EVM_PAYOUT, OTHER_PAYOUT, PAYER]) {
      // Each sweep reads the recent window's three chunks; the pass reads each chunk once.
      expect(payoutRanges(run.fake, payout)).toHaveLength(3 * sweeps + passChunks);
    }
  });

  it('reads at most EIP3009_BIND_READS receipts in a sweep, however many hits were reported', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const count = EIP3009_BIND_READS + 8;
    for (let index = 0; index < count; index += 1) {
      const hash = txHashOf(1300 + index);
      plainTransfer(run.fake, {
        hash,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.safe - 2000 + index * 40,
      });
      reportOn(run, order, hash);
    }
    await sweep(run);
    expect(Object.keys(run.state.eip3009Bindings)).toHaveLength(EIP3009_BIND_READS);
  });

  it('warns of a receipt that keeps failing as such, never as a hit not read yet', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const hash = txHashOf(95);
    plainTransfer(run.fake, {
      hash,
      from: PAYER,
      to: EVM_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 5,
    });
    run.fake.script = (method, params) => {
      if (method === 'eth_getTransactionReceipt' && params[0] === hash) {
        throw new Error('rpc eth_getTransactionReceipt answered HTTP 503');
      }
      return undefined;
    };
    await sweep(run);
    await sweep(run, NOW + 60);
    expect((await sweep(run, NOW + 120)).warnings).toEqual([
      `Base Sepolia: the receipt of ${hash} failed on 3 sweeps in a row; older payments on Base Sepolia may be missed`,
    ]);
  });

  it('drops every waiting hit whose binding is cached, not only the first', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const hashes = [txHashOf(96), txHashOf(97)];
    for (const hash of hashes) {
      plainTransfer(run.fake, {
        hash,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.safe - 5,
      });
    }
    await sweep(run);
    const reads = receiptReads(run.fake).length;
    await sweep(run, NOW + 60);
    expect(receiptReads(run.fake).slice(reads)).toEqual([]);
  });

  it('reads first the hits reported by ANY open order, also the second one', async () => {
    const run = setup();
    orderAt(run, NOW - 3600);
    const reporter = orderAt(run, NOW - 1800);
    const hashes: string[] = [];
    for (let index = 0; index < EIP3009_BIND_READS + 9; index += 1) {
      const hash = txHashOf(1400 + index);
      hashes.push(hash);
      plainTransfer(run.fake, {
        hash,
        from: PAYER,
        to: EVM_PAYOUT,
        value: PRICE,
        block: run.fake.safe - 2000 + index * 40,
      });
    }
    const middle = hashes[20] ?? '';
    reportOn(run, reporter, middle);
    await sweep(run);
    // The reported check reads it, then the binding reads begin with it.
    expect(receiptReads(run.fake).slice(0, 2)).toEqual([middle, middle]);
  });

  it('judges every hash an order reported on this chain, not only its first report', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    order.reportedTxs.push(txHashOf(98));
    order.reportedMedia = { [txHashOf(98)]: 'tempo-moderato' };
    // A transfer elsewhere: only the reported check ever reads it.
    plainTransfer(run.fake, {
      hash: txHashOf(99),
      from: PAYER,
      to: OTHER_PAYOUT,
      value: PRICE,
      block: run.fake.safe - 5,
    });
    reportOn(run, order, txHashOf(99));
    await sweep(run);
    expect(order.noLegTxs).toEqual([txHashOf(99)]);
  });

  it('judges a hash both reported and bound once in a sweep', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    // Landed above the credit tag: every check asks again.
    const block = run.fake.safe + 5;
    pay(run, order, { block });
    reportOn(run, order, HASH);
    for (const logIndex of [4, 9]) {
      run.state.eip3009Bindings[`eip155:84532:${HASH}:${logIndex}`] = {
        state: 'bound',
        txHash: HASH,
        blockNumber: block,
        authorizer: PAYER,
        nonce: nonceOf(run, order),
      };
    }
    await sweep(run);
    expect(receiptReads(run.fake).filter((hash) => hash === HASH)).toHaveLength(1);
  });

  // Two bindings of one transaction (two logs) for one order: one check (a Map by pair).
  it('judges a hash two bindings name once in a sweep', async () => {
    const run = setup();
    const order = orderAt(run, NOW - 3600);
    const block = run.fake.safe + 5;
    pay(run, order, { block });
    for (const logIndex of [4, 9]) {
      run.state.eip3009Bindings[`eip155:84532:${HASH}:${logIndex}`] = {
        state: 'bound',
        txHash: HASH,
        blockNumber: block,
        authorizer: PAYER,
        nonce: nonceOf(run, order),
      };
    }
    await sweep(run);
    expect(receiptReads(run.fake).filter((hash) => hash === HASH)).toHaveLength(1);
  });
});
