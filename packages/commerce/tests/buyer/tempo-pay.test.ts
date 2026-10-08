import { beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * Paying an order on Tempo against a fake chain that evaluates `eth_getLogs`
 * filters, and a fake EIP-1193 wallet whose payment lands as a real
 * `TransferWithMemo` receipt.
 */
import { TRANSFER_WITH_MEMO_TOPIC } from '../../../pay-core/src/evm/constants';
import {
  type FakeChainOptions,
  fakeTempoChain,
  recordedReceipt,
} from '../../../pay-core/tests/tempo-chain';
import { MERCHANT_CATCH_UP_SECS, PAY_CUTOFF_SECS } from '../../src/buyer/constants';
import { type LoadedOffer, loadOffer } from '../../src/buyer/offer';
import { placeOrder } from '../../src/buyer/order-flow';
import type { OrderRecord } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import {
  type CallsStatus,
  type TempoPayDeps,
  type TempoWallet,
  endTempoOrder,
  followTempoBundle,
  mayStillBePaid,
  payWithTempo,
  storedTempoRequest,
  watchTempoPayment,
} from '../../src/buyer/tempo-pay';
import { MemoryRelays, NO_FEE_TERMS, NOW, inboxList, makeShop } from './fixtures';

/** A test may change what the composer returns (the real calls go in). */
const composer = vi.hoisted(() => ({
  change: undefined as
    | undefined
    | ((calls: { calls: readonly unknown[] }) => { calls: readonly unknown[] }),
}));

vi.mock('@elisym/pay-core/evm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@elisym/pay-core/evm')>();
  return {
    ...actual,
    buildTempoPaymentCalls: (...args: Parameters<typeof actual.buildTempoPaymentCalls>) => {
      const calls = actual.buildTempoPaymentCalls(...args);
      return composer.change === undefined ? calls : composer.change(calls);
    },
  };
});

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
const USDCE = '0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_CAIP19 = `eip155:4217/erc20:${USDCE}`;
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
/** The receiver of the recorded Moderato transfer its policy blocked. */
const BLOCKED_RECEIVER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const MODERATO_PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
/** $49 in USDC.e subunits. */
const PRICE = 49_000_000n;
const HEAD = 40_000_000;
/** A payment lands after the floor (the head at pay time) and is finalized once the head moves past it. */
const LAND_BLOCK = HEAD + 10;
const LATER_HEAD = HEAD + 1000;
/** The registry's "yes, this payer may send to this receiver". */
const POLICY_YES = `0x${'0'.repeat(63)}1${'0'.repeat(64)}`;
const HASH = `0x${'ab'.repeat(32)}`;

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;

beforeEach(() => {
  store = new OrderStore(new MemoryOrderBackend());
  composer.change = undefined;
});

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

interface World {
  record: OrderRecord;
  fresh: Ready;
  relays: MemoryRelays;
  options: FakeChainOptions & {
    timestamps: Record<number, number>;
    receipts: Record<string, unknown>;
    logs: NonNullable<FakeChainOptions['logs']>;
  };
  deps: TempoPayDeps;
  balance: { value: bigint };
  /** The finalized head the chain answers; tests move it. */
  head: { number: number };
}

interface Network {
  caip19: string;
  payout: string;
  chainId: string;
}

const MAINNET: Network = { caip19: TEMPO_CAIP19, payout: PAYOUT, chainId: '0x1079' };
const MODERATO: Network = {
  caip19: `eip155:42431/erc20:${PATHUSD}`,
  payout: BLOCKED_RECEIVER,
  chainId: '0xa5bf',
};

async function world(
  network: Network = MAINNET,
  shopOptions: { fee?: boolean } = {},
): Promise<World> {
  const shop = makeShop({ caip19: network.caip19, payout: network.payout, ...shopOptions });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const fresh = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['evm'],
    now: NOW,
  });
  if (!fresh.ok) {
    throw new Error(fresh.message);
  }
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
  const balance = { value: PRICE * 2n };
  const options = {
    chainId: network.chainId,
    finalized: HEAD,
    timestamps: { [HEAD]: NOW + 30 } as Record<number, number>,
    receipts: {} as Record<string, unknown>,
    logs: [] as NonNullable<FakeChainOptions['logs']>,
    onCall: (_to: string, data: string) =>
      data.startsWith('0x70a08231') ? `0x${word(balance.value)}` : POLICY_YES,
  };
  const head = { number: HEAD };
  const chain = fakeTempoChain(options);
  const client = {
    request: (args: { method: string; params?: readonly unknown[] }) =>
      chain.client.request(
        args.method === 'eth_getBlockByNumber' && args.params?.[0] === 'finalized'
          ? { method: args.method, params: [`0x${head.number.toString(16)}`, false] }
          : args,
      ),
  };
  const deps: TempoPayDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    client,
    now: () => NOW + 30,
    feeTerms: NO_FEE_TERMS,
  };
  return { record: placed.record, fresh, relays, options, deps, balance, head };
}

/** Land a transfer of `amount` with `memo` from the payer to the payout, under `hash`. */
function land(run: World, hash: string, memo: string, amount = PRICE): void {
  run.options.timestamps[LAND_BLOCK] = NOW + 40;
  run.options.timestamps[LATER_HEAD] = run.options.timestamps[LATER_HEAD] ?? NOW + 60;
  run.head.number = LATER_HEAD;
  const log = {
    address: USDCE,
    topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYOUT)}`, memo],
    data: `0x${word(amount)}`,
    blockNumber: LAND_BLOCK,
    transactionHash: hash,
    logIndex: 0,
  };
  run.options.logs.push(log);
  run.options.receipts[hash] = {
    transactionHash: hash,
    status: '0x1',
    blockNumber: `0x${LAND_BLOCK.toString(16)}`,
    blockHash: `0x${'cd'.repeat(32)}`,
    logs: [
      {
        ...log,
        blockNumber: `0x${LAND_BLOCK.toString(16)}`,
        logIndex: '0x0',
        blockHash: `0x${'cd'.repeat(32)}`,
      },
    ],
  };
}

/** Ordinary traffic on the token at both ends of a scan: what lets the verifier vouch "none". */
function historyControl(run: World, floor: number): void {
  for (const [index, blockNumber] of [floor - 50, run.head.number - 100].entries()) {
    run.options.timestamps[blockNumber] = NOW;
    run.options.logs.push({
      address: USDCE,
      topics: [`0x${'55'.repeat(32)}`],
      data: '0x',
      blockNumber,
      transactionHash: `0x${String(index + 2)
        .repeat(2)
        .repeat(32)}`,
      logIndex: 0,
    });
  }
}

/** Move the chain past the request's late deadline. */
function pastDeadline(run: World, record: OrderRecord): void {
  const request = storedTempoRequest(record);
  if (request === undefined) {
    throw new Error('no request');
  }
  run.head.number = LATER_HEAD;
  run.options.timestamps[LATER_HEAD] = request.created_at + request.expiry_secs + 1800 + 10;
}

type Behaviour = 'land' | 'drop' | 'reject' | 'fail';

function wallet(
  run: World,
  behaviour: Behaviour,
  chainId = 4217,
  address = PAYER,
): TempoWallet & { sent: number } {
  const fake = {
    address,
    sent: 0,
    chainId: async () => chainId,
    sendCall: async (call: { data: string }) => {
      fake.sent += 1;
      if (behaviour === 'reject') {
        throw Object.assign(new Error('User rejected'), { code: 4001 });
      }
      if (behaviour === 'fail') {
        throw new Error('the wallet went away');
      }
      if (behaviour === 'land') {
        land(run, HASH, `0x${call.data.slice(-64)}`);
      }
      // Wallets answer in any case: the core stores it lowercase.
      return HASH.toUpperCase().replace('0X', '0x');
    },
  };
  return fake;
}

/** Land a transfer the recipient's policy blocked: the guard's log, rewritten for this order. */
function landBlocked(run: World, hash: string, memo: string, amount = PRICE): void {
  const recorded = recordedReceipt('moderato-blocked-pathusd');
  const guard = (recorded.logs as Record<string, unknown>[]).find(
    (log) => String(log.address).toLowerCase() === '0xb10c000000000000000000000000000000000000',
  );
  if (guard === undefined) {
    throw new Error('no guard log');
  }
  const words = String(guard.data).slice(2).match(/.{64}/g) ?? [];
  words[0] = word(amount);
  words[13] = word(memo);
  run.options.timestamps[LAND_BLOCK] = NOW + 40;
  run.options.timestamps[LATER_HEAD] = run.options.timestamps[LATER_HEAD] ?? NOW + 60;
  run.head.number = LATER_HEAD;
  const at = `0x${LAND_BLOCK.toString(16)}`;
  const log = {
    ...guard,
    data: `0x${words.join('')}`,
    blockNumber: at,
    transactionHash: hash,
    blockHash: `0x${'cd'.repeat(32)}`,
  };
  run.options.logs.push({
    address: String(guard.address),
    topics: guard.topics as string[],
    data: log.data,
    blockNumber: LAND_BLOCK,
    transactionHash: hash,
    logIndex: Number(BigInt(String(guard.logIndex))),
  });
  run.options.receipts[hash] = {
    transactionHash: hash,
    status: '0x1',
    blockNumber: at,
    blockHash: `0x${'cd'.repeat(32)}`,
    logs: [log],
  };
}

describe('paying on Tempo', () => {
  it('composes at the pay press, marks with the finalized floor, stores the hash, then finds it', async () => {
    const run = await world();
    const paid = await payWithTempo(run.record, wallet(run, 'land'), run.fresh, run.deps);
    expect(paid).toMatchObject({ ok: true, hash: HASH });
    const record = paid.ok ? paid.record : run.record;
    expect(storedTempoRequest(record)).toMatchObject({
      recipient: PAYOUT,
      amount: PRICE.toString(),
      memo: record.reference,
      created_at: NOW + 30,
    });
    expect(record.marker).toMatchObject({ rail: 'tempo', floorBlock: String(HEAD), txHash: HASH });
    expect(record.receiptWrap).toBeDefined();
    const watched = await watchTempoPayment(record, run.deps);
    expect(watched.state).toBe('paid');
    expect(watched.record).toMatchObject({ state: 'paid', paidTx: HASH, paidAt: NOW + 30 });
  });

  it('refuses before anything is requested when the balance does not cover the price and the fee margin', async () => {
    const run = await world();
    run.balance.value = PRICE;
    const payer = wallet(run, 'land');
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'insufficient_token',
      needed: PRICE + 10_000n,
      available: PRICE,
    });
    expect(payer.sent).toBe(0);
    const stored = await store.get(run.record.orderId);
    expect(stored?.marker).toBeUndefined();
    expect(stored?.paymentRequest).toBeUndefined();
  });

  it('refuses a payer the recipient policy would block', async () => {
    const run = await world();
    run.options.onCall = (_to, data) =>
      data.startsWith('0x70a08231')
        ? `0x${word(run.balance.value)}`
        : `0x${'0'.repeat(64)}${'2'.padStart(64, '0')}`;
    const payer = wallet(run, 'land');
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      reason: 'policy_blocked',
    });
    expect(payer.sent).toBe(0);
  });

  it('clears the marker when the wallet is on another chain: nothing was requested', async () => {
    const run = await world();
    const payer = wallet(run, 'land', 42431);
    const result = await payWithTempo(run.record, payer, run.fresh, run.deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'wrong_chain',
      record: { state: 'ordered' },
    });
    expect(payer.sent).toBe(0);
    expect((await store.get(run.record.orderId))?.marker).toBeUndefined();
  });

  it('ends the order on a proving rejection, with no old-prompt warning after it', async () => {
    const run = await world();
    const result = await payWithTempo(run.record, wallet(run, 'reject'), run.fresh, run.deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'rejected',
      record: { state: 'ended-unpaid', endedBy: 'rejected' },
    });
    expect(mayStillBePaid((result.ok ? run.record : result.record) as OrderRecord, NOW)).toBe(
      false,
    );
  });

  it('keeps an attempt live after a wallet failure, and ends it over only with a vouched "none"', async () => {
    const run = await world();
    const failed = await payWithTempo(run.record, wallet(run, 'fail'), run.fresh, run.deps);
    expect(failed).toMatchObject({
      ok: false,
      reason: 'wallet_failed',
      record: { state: 'paying' },
    });
    const record = failed.ok ? run.record : (failed.record as OrderRecord);
    // Before the late deadline: waiting, never over.
    expect((await watchTempoPayment(record, run.deps)).state).toBe('waiting');
    expect((await endTempoOrder(record, run.deps)).ended).toBe(false);
    // While this session's call is still pending: never over.
    pastDeadline(run, record);
    historyControl(run, HEAD);
    expect((await watchTempoPayment(record, run.deps, { callPending: true })).state).toBe(
      'waiting',
    );
    const ended = await endTempoOrder(record, run.deps);
    expect(ended).toMatchObject({
      ended: true,
      record: { state: 'ended-unpaid', endedBy: 'over' },
    });
    expect(mayStillBePaid(ended.record, NOW + 60)).toBe(true);
  });

  it('never ends an attempt that holds a sent hash, even when the hash never lands', async () => {
    const run = await world();
    const sent = await payWithTempo(run.record, wallet(run, 'drop'), run.fresh, run.deps);
    expect(sent).toMatchObject({ ok: true, hash: HASH });
    const record = sent.ok ? sent.record : run.record;
    pastDeadline(run, record);
    historyControl(run, HEAD);
    const watched = await watchTempoPayment(record, run.deps);
    expect(watched).toMatchObject({ state: 'waiting', pastDeadline: true });
    expect((await endTempoOrder(record, run.deps)).ended).toBe(false);
  });

  it('finds a late approval of an order that ended over', async () => {
    const run = await world();
    const failed = await payWithTempo(run.record, wallet(run, 'fail'), run.fresh, run.deps);
    const record = failed.ok ? run.record : (failed.record as OrderRecord);
    pastDeadline(run, record);
    historyControl(run, HEAD);
    const ended = await endTempoOrder(record, run.deps);
    // The old prompt is approved after all.
    land(run, HASH, ended.record.reference);
    const found = await watchTempoPayment(ended.record, run.deps);
    expect(found).toMatchObject({ state: 'paid', record: { state: 'paid', paidTx: HASH } });
  });

  it('ends a stored request too close to its deadline instead of paying it', async () => {
    const run = await world();
    // A first attempt composes the request, then stops on the wallet's chain: nothing was requested.
    const first = await payWithTempo(run.record, wallet(run, 'land', 42431), run.fresh, run.deps);
    const record = first.ok ? run.record : (first.record as OrderRecord);
    const request = storedTempoRequest(record);
    expect(request).toBeDefined();
    // The chain moves to within two minutes of the request's deadline.
    run.head.number = LATER_HEAD;
    run.options.timestamps[LATER_HEAD] =
      (request?.created_at ?? 0) + (request?.expiry_secs ?? 0) - 60;
    const payer = wallet(run, 'land');
    const late = await payWithTempo(
      record,
      payer,
      { ...run.fresh, snapshotAt: NOW + 30 },
      run.deps,
    );
    expect(late).toMatchObject({
      ok: false,
      reason: 'too_late',
      record: { state: 'ended-unpaid', endedBy: 'nothing' },
    });
    expect(payer.sent).toBe(0);
  });

  it('still pays on the last second before the cutoff and refuses one second later', async () => {
    const onTime = await world();
    const lastSecond = onTime.record.createdAt + MERCHANT_CATCH_UP_SECS - PAY_CUTOFF_SECS;
    onTime.options.timestamps[HEAD] = lastSecond;
    const paying = wallet(onTime, 'land');
    const paid = await payWithTempo(
      onTime.record,
      paying,
      { ...onTime.fresh, snapshotAt: NOW + 30 },
      onTime.deps,
    );
    expect(paid).toMatchObject({ ok: true, hash: HASH });
    expect(paying.sent).toBe(1);
    const late = await world();
    late.options.timestamps[HEAD] = lastSecond + 1;
    const refused = wallet(late, 'land');
    expect(
      await payWithTempo(late.record, refused, { ...late.fresh, snapshotAt: NOW + 30 }, late.deps),
    ).toMatchObject({ ok: false, reason: 'too_late' });
    expect(refused.sent).toBe(0);
  });

  it('refuses when the fresh offer no longer pays this price, and a transfer to oneself', async () => {
    const run = await world();
    const raised = {
      ...run.fresh,
      payouts: run.fresh.payouts.map((payout) => ({ ...payout, amount: payout.amount + 1n })),
    };
    expect(await payWithTempo(run.record, wallet(run, 'land'), raised, run.deps)).toMatchObject({
      reason: 'offer_changed',
    });
    expect(
      await payWithTempo(run.record, wallet(run, 'land', 4217, PAYOUT), run.fresh, run.deps),
    ).toMatchObject({ reason: 'self_payment' });
  });

  it('records a payment the recipient policy blocked as blocked', async () => {
    const run = await world(MODERATO);
    const failed = await payWithTempo(
      run.record,
      wallet(run, 'fail', 42431, MODERATO_PAYER),
      run.fresh,
      run.deps,
    );
    const record = failed.ok ? run.record : (failed.record as OrderRecord);
    pastDeadline(run, record);
    historyControl(run, HEAD);
    landBlocked(run, HASH, record.reference);
    const watched = await watchTempoPayment(record, run.deps);
    expect(watched).toMatchObject({ state: 'blocked', record: { state: 'blocked' } });
  });

  it('reports a decline as ended only once the order ended, re-reading on a lost write', async () => {
    const run = await world();
    const payer = wallet(run, 'reject');
    const original = payer.sendCall;
    payer.sendCall = async (call) => {
      // The status listener stores something while the prompt is open.
      const [open] = await store.forProduct(run.record.productAddress);
      if (open !== undefined) {
        await store.update(open.orderId, open.version, {
          acknowledgedRelays: ['wss://x.example.com'],
        });
      }
      return original(call);
    };
    const result = await payWithTempo(run.record, payer, run.fresh, run.deps);
    expect(result).toMatchObject({
      ok: false,
      reason: 'rejected',
      record: { state: 'ended-unpaid', endedBy: 'rejected' },
    });
  });
});

const TREASURY = '0x1111111111111111111111111111111111111111';
/** 3% of the price. */
const FEE = 1_470_000n;
const BUNDLE = `0x${'b0'.repeat(32)}`;
const AT_3_PERCENT = async () => ({ feeBps: 300, treasury: TREASURY });

/** Land one transaction carrying `legs` (each a `TransferWithMemo` with `memo`) under `hash`. */
function landLegs(run: World, hash: string, memo: string, legs: { to: string; amount: bigint }[]) {
  run.options.timestamps[LAND_BLOCK] = NOW + 40;
  run.options.timestamps[LATER_HEAD] = run.options.timestamps[LATER_HEAD] ?? NOW + 60;
  run.head.number = LATER_HEAD;
  const logs = legs.map((entry, index) => ({
    address: USDCE,
    topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(entry.to)}`, memo],
    data: `0x${word(entry.amount)}`,
    blockNumber: LAND_BLOCK,
    transactionHash: hash,
    logIndex: index,
  }));
  run.options.logs.push(...logs);
  run.options.receipts[hash] = {
    transactionHash: hash,
    status: '0x1',
    blockNumber: `0x${LAND_BLOCK.toString(16)}`,
    blockHash: `0x${'cd'.repeat(32)}`,
    logs: logs.map((log) => ({
      ...log,
      blockNumber: `0x${LAND_BLOCK.toString(16)}`,
      logIndex: `0x${log.logIndex.toString(16)}`,
      blockHash: `0x${'cd'.repeat(32)}`,
    })),
  };
}

type BatchBehaviour = 'land' | 'drop' | 'fail' | { code: number };

interface BatchWallet extends TempoWallet {
  sent: number;
  batches: { from: string; chainId: string; calls: readonly { to: string; data: string }[] }[];
  /** What `wallet_getCallsStatus` answers; a function to throw. */
  status: CallsStatus | (() => never);
  atomic: boolean;
}

/** A wallet that batches (EIP-5792), approving bundles as told. */
function batchWallet(run: World, behaviour: BatchBehaviour = 'drop'): BatchWallet {
  const fake: BatchWallet = {
    address: PAYER,
    rdns: 'io.metamask',
    sent: 0,
    batches: [],
    status: { status: 100 },
    atomic: true,
    chainId: async () => 4217,
    sendCall: async () => {
      fake.sent += 1;
      return HASH;
    },
    capabilities: async () => ({ atomic: fake.atomic }),
    sendCalls: async (request) => {
      fake.batches.push(request);
      if (typeof behaviour === 'object') {
        throw Object.assign(new Error('wallet said no'), { code: behaviour.code });
      }
      if (behaviour === 'fail') {
        throw new Error('the wallet went away');
      }
      if (behaviour === 'land') {
        const memo = `0x${request.calls[0]?.data.slice(-64) ?? ''}`;
        landLegs(run, HASH, memo, [
          { to: PAYOUT, amount: PRICE - FEE },
          { to: TREASURY, amount: FEE },
        ]);
      }
      return { bundleId: BUNDLE };
    },
    callsStatus: async () => {
      if (typeof fake.status === 'function') {
        return fake.status();
      }
      return fake.status;
    },
  };
  return fake;
}

async function feeWorld(options: { fee?: boolean } = {}): Promise<World> {
  const run = await world(MAINNET, { fee: options.fee ?? true });
  run.deps.feeTerms = AT_3_PERCENT;
  return run;
}

describe('paying a fee-bearing order on Tempo', () => {
  it('sends both legs as one atomic batch, payee first, and stores the bundle with its wallet', async () => {
    const run = await feeWorld();
    const payer = batchWallet(run);
    const paid = await payWithTempo(run.record, payer, run.fresh, run.deps);
    expect(paid).toMatchObject({ ok: true, bundleId: BUNDLE });
    expect(paid.ok && 'bundleUnsaved' in paid).toBe(false);
    expect(payer.sent).toBe(0);
    expect(payer.batches).toHaveLength(1);
    const [batch] = payer.batches;
    expect(batch?.from).toBe(PAYER);
    expect(batch?.chainId).toBe('0x1079');
    expect(batch?.calls.map((call) => call.data.slice(10, 74))).toEqual([
      word(PAYOUT),
      word(TREASURY),
    ]);
    expect(batch?.calls.map((call) => BigInt(`0x${call.data.slice(74, 138)}`))).toEqual([
      PRICE - FEE,
      FEE,
    ]);
    const record = paid.ok ? paid.record : run.record;
    expect(storedTempoRequest(record)).toMatchObject({
      amount: PRICE.toString(),
      fee_address: TREASURY,
      fee_amount: FEE.toString(),
    });
    expect(record.marker).toMatchObject({ bundleId: BUNDLE, bundleWallet: 'io.metamask' });
    expect(record.marker?.rail === 'tempo' ? record.marker.txHash : 'x').toBeUndefined();
  });

  it('refuses a wallet that cannot batch before anything is requested', async () => {
    const run = await feeWorld();
    const notAtomic = batchWallet(run);
    notAtomic.atomic = false;
    const { capabilities: _dropped, ...noCapabilities } = batchWallet(run);
    const { sendCalls: _noSend, ...cannotSend } = batchWallet(run);
    const { callsStatus: _noStatus, ...cannotFollow } = batchWallet(run);
    const failing = batchWallet(run);
    failing.capabilities = async () => {
      throw new Error('no answer');
    };
    // An answer that does not say `atomic: true` is no batching.
    const silent = batchWallet(run);
    silent.capabilities = async () => ({}) as { atomic: boolean };
    for (const payer of [notAtomic, noCapabilities, cannotSend, cannotFollow, failing, silent]) {
      expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'wallet_cannot_batch',
        record: { state: 'ordered' },
      });
    }
    expect(notAtomic.batches).toHaveLength(0);
    const stored = await store.get(run.record.orderId);
    expect(stored?.marker).toBeUndefined();
    expect(stored?.paymentRequest).toBeUndefined();
  });

  it('sends a fee-less payment as one plain transaction, even from a wallet that batches', async () => {
    const run = await world();
    const payer = batchWallet(run);
    payer.sendCall = async (call) => {
      payer.sent += 1;
      land(run, HASH, `0x${call.data.slice(-64)}`);
      return HASH;
    };
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: true,
      hash: HASH,
    });
    expect(payer.sent).toBe(1);
    expect(payer.batches).toHaveLength(0);
  });

  it('pays the payout that is the EVM treasury with one call and no fee leg', async () => {
    const run = await world(MAINNET, { fee: false });
    run.deps.feeTerms = async () => ({ feeBps: 300, treasury: PAYOUT });
    const paid = await payWithTempo(run.record, wallet(run, 'land'), run.fresh, run.deps);
    expect(paid).toMatchObject({ ok: true, hash: HASH });
    const record = paid.ok ? paid.record : run.record;
    expect(storedTempoRequest(record)?.fee_address).toBeUndefined();
    expect((await watchTempoPayment(record, run.deps)).state).toBe('paid');
  });

  it('pays with no fee leg when the paying wallet is the treasury: no spurious change', async () => {
    // A store with fee support (no batch asked) and one without (no store_outdated).
    for (const fee of [true, false]) {
      const run = await world(MAINNET, { fee });
      run.deps.feeTerms = async () => ({ feeBps: 300, treasury: PAYER });
      const payer = wallet(run, 'land');
      const paid = await payWithTempo(run.record, payer, run.fresh, run.deps);
      expect(paid).toMatchObject({ ok: true, hash: HASH });
      expect(payer.sent).toBe(1);
      const record = paid.ok ? paid.record : run.record;
      expect(storedTempoRequest(record)?.fee_address).toBeUndefined();
    }
  });

  it('sends nothing when the composer returns another number of calls than the legs', async () => {
    // A fee leg composed into one call: no batch of the payee leg alone.
    const run = await feeWorld();
    composer.change = (calls) => ({ ...calls, calls: calls.calls.slice(0, 1) });
    const payer = batchWallet(run);
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(payer.batches).toHaveLength(0);
    expect((await store.get(run.record.orderId))?.marker).toBeUndefined();
    // No fee leg, yet two calls: no plain transaction of either.
    const plain = await world();
    composer.change = (calls) => ({ ...calls, calls: [...calls.calls, ...calls.calls] });
    const single = wallet(plain, 'land');
    expect(await payWithTempo(plain.record, single, plain.fresh, plain.deps)).toMatchObject({
      ok: false,
      reason: 'not_payable',
    });
    expect(single.sent).toBe(0);
    expect((await store.get(plain.record.orderId))?.marker).toBeUndefined();
  });

  it('ends a declined batch, and puts an unsupported one back to ordered', async () => {
    for (const code of [4001, 5750]) {
      const run = await feeWorld();
      expect(
        await payWithTempo(run.record, batchWallet(run, { code }), run.fresh, run.deps),
      ).toMatchObject({
        ok: false,
        reason: 'rejected',
        record: { state: 'ended-unpaid', endedBy: 'rejected' },
      });
    }
    for (const code of [4200, 5700, 5710, 5740, 5760]) {
      const run = await feeWorld();
      expect(
        await payWithTempo(run.record, batchWallet(run, { code }), run.fresh, run.deps),
      ).toMatchObject({ ok: false, reason: 'wallet_cannot_batch', record: { state: 'ordered' } });
      expect((await store.get(run.record.orderId))?.marker).toBeUndefined();
    }
    // Any other failure after the call keeps the attempt: it may have gone out.
    for (const behaviour of ['fail', { code: 5730 }] as const) {
      const run = await feeWorld();
      expect(
        await payWithTempo(run.record, batchWallet(run, behaviour), run.fresh, run.deps),
      ).toMatchObject({ ok: false, reason: 'wallet_failed', record: { state: 'paying' } });
    }
  });

  it('keeps the attempt when the wallet answers with no usable bundle id', async () => {
    for (const bundleId of ['', 'x'.repeat(8193), undefined]) {
      const run = await feeWorld();
      const payer = batchWallet(run);
      payer.sendCalls = async () => ({ bundleId }) as { bundleId: string };
      expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason: 'wallet_failed',
        record: { state: 'paying' },
      });
    }
    const run = await feeWorld();
    const payer = batchWallet(run);
    payer.sendCalls = async () => ({ bundleId: 'x'.repeat(8192) });
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({ ok: true });
  });

  it('keeps a bundle id it could not store in memory, for the watch to hold', async () => {
    const run = await feeWorld();
    const payer = batchWallet(run);
    const sendCalls = payer.sendCalls;
    payer.sendCalls = async (request) => {
      const answer = await sendCalls?.(request);
      // Another tab ended the record meanwhile: the write cannot land.
      const [open] = await store.forProduct(run.record.productAddress);
      store.updateMarker = async () => ({ ok: false, reason: 'not_ready' });
      expect(open?.state).toBe('paying');
      return answer ?? { bundleId: '' };
    };
    const paid = await payWithTempo(run.record, payer, run.fresh, run.deps);
    expect(paid).toMatchObject({ ok: true, bundleId: BUNDLE, bundleUnsaved: true });
    const record = paid.ok ? paid.record : run.record;
    expect(record.marker?.rail === 'tempo' ? record.marker.bundleId : 'x').toBeUndefined();
    // Past the deadline with a vouched "none", only the in-memory bundle holds it.
    pastDeadline(run, record);
    historyControl(run, HEAD);
    const ownHold = await watchTempoPayment(record, run.deps, { pendingBundleId: BUNDLE });
    expect(ownHold.state).not.toBe('over');
    expect((await watchTempoPayment(record, run.deps)).state).toBe('over');
    expect((await endTempoOrder(record, run.deps, { pendingBundleId: BUNDLE })).ended).toBe(false);
  });

  it('refuses a store whose node cannot take a split, before anything is requested', async () => {
    const run = await feeWorld({ fee: false });
    const payer = batchWallet(run);
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'store_outdated',
      record: { state: 'ordered' },
    });
    expect(payer.batches).toHaveLength(0);
    expect((await store.get(run.record.orderId))?.paymentRequest).toBeUndefined();
  });

  it('refuses when elisym’s treasury would not take the transfer: fee_config_invalid', async () => {
    const run = await feeWorld();
    run.options.onCall = (_to, data) => {
      if (data.startsWith('0x70a08231')) {
        return `0x${word(run.balance.value)}`;
      }
      return data.includes(TREASURY.slice(2))
        ? `0x${'0'.repeat(64)}${'2'.padStart(64, '0')}`
        : POLICY_YES;
    };
    const payer = batchWallet(run);
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'fee_config_invalid',
      record: { state: 'ordered' },
    });
    expect(payer.batches).toHaveLength(0);
  });

  it('leaves the record as it is when the treasury’s policy cannot be read: rpc_error', async () => {
    const run = await feeWorld();
    run.options.onCall = (_to, data) => {
      if (data.startsWith('0x70a08231')) {
        return `0x${word(run.balance.value)}`;
      }
      if (data.includes(TREASURY.slice(2))) {
        throw new Error('policy registry unreachable');
      }
      return POLICY_YES;
    };
    const payer = batchWallet(run);
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'rpc_error',
      record: { state: 'ordered' },
    });
    const stored = await store.get(run.record.orderId);
    expect(stored?.version).toBe(run.record.version);
    expect(stored?.paymentRequest).toBeUndefined();
    expect(stored?.marker).toBeUndefined();
    expect(payer.batches).toHaveLength(0);
  });

  it('leaves the record as it is when the fee terms cannot be read', async () => {
    const run = await feeWorld();
    run.deps.feeTerms = async () => {
      throw new Error('rpc down');
    };
    const payer = batchWallet(run);
    expect(await payWithTempo(run.record, payer, run.fresh, run.deps)).toMatchObject({
      ok: false,
      reason: 'fee_config_unavailable',
    });
    const stored = await store.get(run.record.orderId);
    expect(stored?.version).toBe(run.record.version);
    expect(payer.batches).toHaveLength(0);
  });

  it('re-plans a stored request: a fee raised since is offer_changed, or store_outdated', async () => {
    for (const [fee, reason] of [
      [true, 'offer_changed'],
      [false, 'store_outdated'],
    ] as const) {
      const run = await world(MAINNET, { fee });
      // A first press composes the fee-less request, then stops on the wallet's chain.
      const first = await payWithTempo(run.record, wallet(run, 'land', 42431), run.fresh, run.deps);
      const record = first.ok ? run.record : (first.record as OrderRecord);
      expect(storedTempoRequest(record)?.fee_address).toBeUndefined();
      run.deps.feeTerms = AT_3_PERCENT;
      const payer = batchWallet(run);
      expect(await payWithTempo(record, payer, run.fresh, run.deps)).toMatchObject({
        ok: false,
        reason,
        record: { state: 'ordered' },
      });
      expect(payer.batches).toHaveLength(0);
    }
  });
});

describe('following a bundle', () => {
  async function approved(behaviour: BatchBehaviour = 'drop') {
    const run = await feeWorld();
    const payer = batchWallet(run, behaviour);
    const paid = await payWithTempo(run.record, payer, run.fresh, run.deps);
    if (!paid.ok) {
      throw new Error(paid.reason);
    }
    return { run, payer, record: paid.record };
  }

  it('answers pending while the wallet says 100', async () => {
    const { run, payer, record } = await approved();
    expect(await followTempoBundle(record, run.deps, payer, BUNDLE)).toMatchObject({
      step: 'pending',
    });
  });

  it('stores the one receipt of a confirmed atomic bundle, sends the receipt, then finds it paid', async () => {
    const { run, payer, record } = await approved('land');
    payer.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    const step = await followTempoBundle(record, run.deps, payer, BUNDLE);
    expect(step).toMatchObject({ step: 'hash', hash: HASH });
    expect(step.record.marker).toMatchObject({ bundleId: BUNDLE, txHash: HASH });
    expect(step.record.receiptWrap).toBeDefined();
    expect(await watchTempoPayment(step.record, run.deps)).toMatchObject({
      state: 'paid',
      record: { paidTx: HASH },
    });
  });

  it('trusts no other confirmed answer: non-atomic, several receipts, partly reverted', async () => {
    const answers: CallsStatus[] = [
      { status: 200, atomic: false, receipts: [{ transactionHash: HASH }] },
      { status: 200, receipts: [{ transactionHash: HASH }] },
      {
        status: 200,
        atomic: true,
        receipts: [{ transactionHash: HASH }, { transactionHash: `0x${'cc'.repeat(32)}` }],
      },
      { status: 200, atomic: true, receipts: [] },
      { status: 600, atomic: true, receipts: [{ transactionHash: HASH }] },
    ];
    for (const status of answers) {
      const { run, payer, record } = await approved();
      payer.status = status;
      const step = await followTempoBundle(record, run.deps, payer, BUNDLE);
      expect(step.step).toBe('unsure');
      expect((await store.get(record.orderId))?.marker).toEqual(record.marker);
    }
  });

  it('marks a stored bundle failed on 400 or 500, which then ends over only past the deadline', async () => {
    for (const status of [400, 500]) {
      const { run, payer, record } = await approved();
      payer.status = { status };
      const step = await followTempoBundle(record, run.deps, payer, BUNDLE);
      expect(step).toMatchObject({ step: 'failed', record: { marker: { bundleFailed: true } } });
      // Before the late deadline: never over.
      expect((await endTempoOrder(step.record, run.deps)).ended).toBe(false);
      pastDeadline(run, step.record);
      historyControl(run, HEAD);
      expect(await endTempoOrder(step.record, run.deps)).toMatchObject({
        ended: true,
        record: { state: 'ended-unpaid', endedBy: 'over' },
      });
    }
  });

  it('re-reads on a lost compare-and-swap and still stores the failed bundle', async () => {
    const { run, payer, record } = await approved();
    const marker = record.marker;
    if (marker?.rail !== 'tempo') {
      throw new Error('no tempo marker');
    }
    // Another write bumped the version since this record was read.
    const bumped = await store.updateMarker(record.orderId, record.version, marker.attemptId, {
      ...marker,
    });
    expect(bumped.ok).toBe(true);
    const writes = vi.spyOn(store, 'updateMarker');
    payer.status = { status: 400 };
    const step = await followTempoBundle(record, run.deps, payer, BUNDLE);
    expect(await writes.mock.results[0]?.value).toMatchObject({ ok: false, reason: 'conflict' });
    expect(step).toMatchObject({ step: 'failed', record: { marker: { bundleFailed: true } } });
    expect((await store.get(record.orderId))?.marker).toMatchObject({
      bundleId: BUNDLE,
      bundleFailed: true,
    });
  });

  it('never ends an approved bundle the wallet did not fail', async () => {
    const { run, record } = await approved();
    pastDeadline(run, record);
    historyControl(run, HEAD);
    expect((await watchTempoPayment(record, run.deps)).state).not.toBe('over');
    expect((await endTempoOrder(record, run.deps)).ended).toBe(false);
  });

  it('changes nothing for an unknown bundle (5730), no wallet, or another bundle id', async () => {
    const { run, payer, record } = await approved();
    payer.status = () => {
      throw Object.assign(new Error('unknown bundle'), { code: 5730 });
    };
    expect((await followTempoBundle(record, run.deps, payer, BUNDLE)).step).toBe('unknown');
    expect((await followTempoBundle(record, run.deps, undefined, BUNDLE)).step).toBe('unknown');
    payer.status = { status: 400 };
    expect((await followTempoBundle(record, run.deps, payer, `0x${'b1'.repeat(32)}`)).step).toBe(
      'unknown',
    );
    expect((await store.get(record.orderId))?.marker).toEqual(record.marker);
  });

  it('writes nothing when an unsaved bundle fails: the caller drops its own hold', async () => {
    const run = await feeWorld();
    const payer = batchWallet(run, 'fail');
    const failed = await payWithTempo(run.record, payer, run.fresh, run.deps);
    const record = failed.ok ? run.record : (failed.record as OrderRecord);
    payer.status = { status: 400 };
    const step = await followTempoBundle(record, run.deps, payer, BUNDLE);
    expect(step.step).toBe('failed');
    expect((await store.get(record.orderId))?.marker).toEqual(record.marker);
  });
});
