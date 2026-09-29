import { beforeEach, describe, expect, it } from 'vitest';
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
import { type LoadedOffer, loadOffer } from '../../src/buyer/offer';
import { placeOrder } from '../../src/buyer/order-flow';
import type { OrderRecord } from '../../src/buyer/order-record';
import { MemoryOrderBackend, OrderStore } from '../../src/buyer/order-store';
import {
  type TempoPayDeps,
  type TempoWallet,
  endTempoOrder,
  mayStillBePaid,
  payWithTempo,
  storedTempoRequest,
  watchTempoPayment,
} from '../../src/buyer/tempo-pay';
import { MemoryRelays, NOW, inboxList, makeShop } from './fixtures';

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

async function world(network: Network = MAINNET): Promise<World> {
  const shop = makeShop({ caip19: network.caip19, payout: network.payout });
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
