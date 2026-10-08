/**
 * The protocol fee in the widget's session: the checks before an order, the
 * refusals after one, and on Tempo the one atomic bundle of both legs - its
 * holds, its follow-up through the wallet, and a reload that observes it.
 */
import {
  type CallsStatus,
  type LoadedOffer,
  type OrderRecord,
  OrderStore,
  type TempoWallet,
  loadOffer,
} from '@elisym/commerce/buyer';
import { FeeConfigError, type FeeTerms } from '@elisym/pay-core';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryRelays,
  NOW,
  type Shop,
  inboxList,
  makeShop,
  solanaAddress,
} from '../../commerce/tests/buyer/fixtures';
import { FakeSolana, FakeWallet } from '../../commerce/tests/buyer/solana-fixtures';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import { type FakeChainOptions, fakeTempoChain } from '../../pay-core/tests/tempo-chain';
import { CheckoutSession, type SessionDeps, type View } from '../src/app/session';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import { settle, spyStore } from './reset-harness';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const TEMPO_CAIP19 = `eip155:42431/erc20:${PATHUSD}`;
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const TREASURY = `0x${'77'.repeat(20)}`;
const PRICE = 49_000_000n;
/** 100 bps of the price, rounded up. */
const FEE = 490_000n;
const HEAD = 40_000_000;
const LAND = HEAD + 10;
const LATER = HEAD + 1000;
const POLICY_YES = `0x${'0'.repeat(63)}1${'0'.repeat(64)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const BUNDLE = 'bundle-1';
const RDNS = 'io.metamask';

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;
let backend: IndexedDbOrderBackend;

beforeEach(async () => {
  backend = new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory()));
  store = new OrderStore(backend);
});

class Timers {
  private next = 1;
  readonly running = new Map<number, () => void>();
  set = (handler: () => void) => {
    const id = this.next;
    this.next += 1;
    this.running.set(id, handler);
    return id;
  };
  clear = (id: unknown) => {
    this.running.delete(id as number);
  };
  async tick(): Promise<void> {
    for (const handler of [...this.running.values()]) {
      handler();
    }
    await settle(80);
  }
}

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/** Fee terms that answer each call from `answers` in turn (the last one repeats). */
function termsSequence(answers: readonly (FeeTerms | Error)[]): {
  source: SessionDeps['feeTerms'];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    source: async (chain) => {
      calls.push(chain);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error('no answer');
      }
      return answer;
    },
  };
}

const ZERO: FeeTerms = { feeBps: 0, treasury: '' };

function withFeeSupport(offer: Ready): Ready {
  return { ...offer, offer: { ...offer.offer, feeSupport: true } };
}

function problemOf(view: View | undefined): string | undefined {
  return view?.kind === 'offer' || view?.kind === 'waiting_payment'
    ? view.problem?.reason
    : undefined;
}

// ---- Solana ---------------------------------------------------------------

async function solanaSetup(options: {
  terms: readonly (FeeTerms | Error)[];
  feeSupport?: boolean;
}) {
  const shop = makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const transform = (offer: Ready) => (options.feeSupport === true ? withFeeSupport(offer) : offer);
  const load = async (now: number) => {
    const loaded = await loadOffer(shop.naddr, {
      client: relays,
      pageOrigin: PAGE,
      families: ['solana'],
      now,
    });
    if (!loaded.ok) {
      throw new Error(loaded.message);
    }
    return transform(loaded);
  };
  const offer = await load(NOW);
  const wallet = await FakeWallet.create();
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.blockTime = NOW + 60;
  const timers = new Timers();
  const views: View[] = [];
  const terms = termsSequence(options.terms);
  const clock = NOW + 30;
  const deps: SessionDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => chain.rpc,
    feeTerms: terms.source,
    wallets: () => [{ name: 'Fake', connect: async () => wallet }],
    reloadOffer: () => load(clock),
    now: () => clock,
    chainTime: async () => clock,
    setInterval: timers.set,
    clearInterval: timers.clear,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    onView: (view) => views.push(view),
    onStatus: () => undefined,
  };
  return {
    shop,
    relays,
    offer,
    wallet,
    terms,
    deps,
    timers,
    session: new CheckoutSession(offer, deps),
    last: () => views.at(-1),
  };
}

describe('the fee before an order (Solana)', () => {
  it('orders nothing when the fee terms cannot be read now', async () => {
    const run = await solanaSetup({ terms: [new FeeConfigError('unavailable', 'down')] });
    await run.session.start();
    await run.session.pay('Fake');
    expect(problemOf(run.last())).toBe('fee_config_unavailable');
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
    expect(run.wallet.requests).toBe(0);
  });

  it('orders nothing on a fee configuration that cannot be used', async () => {
    const run = await solanaSetup({ terms: [new FeeConfigError('wrong_cluster', 'other')] });
    await run.session.start();
    await run.session.pay('Fake');
    expect(problemOf(run.last())).toBe('fee_config_invalid');
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
  });

  it('orders nothing from a store whose node cannot take a fee split', async () => {
    const run = await solanaSetup({ terms: [{ feeBps: 100, treasury: solanaAddress() }] });
    await run.session.start();
    await run.session.pay('Fake');
    expect(problemOf(run.last())).toBe('store_outdated');
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
    expect(run.wallet.requests).toBe(0);
  });

  it('reads the terms for the payout chain', async () => {
    const run = await solanaSetup({ terms: [ZERO] });
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.terms.calls[0]).toBe(run.offer.payouts[0]?.target.caip19.chain.caip2);
  });
});

describe('the fee after the order (Solana)', () => {
  it('ends the order when the fee rose above 0 before the request, for an outdated store', async () => {
    const run = await solanaSetup({ terms: [ZERO, { feeBps: 100, treasury: solanaAddress() }] });
    await run.session.start();
    await run.session.pay('Fake');
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record).toMatchObject({ state: 'ended-unpaid' });
    expect(record?.paymentRequest).toBeUndefined();
    expect(problemOf(run.last())).toBe('store_outdated');
    expect(run.wallet.requests).toBe(0);
  });

  it('leaves the order as it is when the terms cannot be read at the request', async () => {
    const run = await solanaSetup({ terms: [ZERO, new FeeConfigError('unavailable', 'down')] });
    await run.session.start();
    await run.session.pay('Fake');
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record).toMatchObject({ state: 'ordered' });
    expect(problemOf(run.last())).toBe('fee_config_unavailable');
  });

  it('ends an order whose stored fee-0 request no longer matches a fee raised before the first pay', async () => {
    const run = await solanaSetup({
      feeSupport: true,
      terms: [ZERO, ZERO, { feeBps: 100, treasury: solanaAddress() }],
    });
    await run.session.start();
    await run.session.pay('Fake');
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record).toMatchObject({ state: 'ended-unpaid' });
    expect(record?.paymentRequest).toBeDefined();
    expect(problemOf(run.last())).toBe('offer_changed');
    expect(run.wallet.requests).toBe(0);
  });

  it('ends the order when the fee rose before signing and the store cannot take a split', async () => {
    const run = await solanaSetup({
      terms: [ZERO, ZERO, { feeBps: 100, treasury: solanaAddress() }],
    });
    await run.session.start();
    await run.session.pay('Fake');
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record).toMatchObject({ state: 'ended-unpaid' });
    expect(problemOf(run.last())).toBe('store_outdated');
    expect(run.wallet.requests).toBe(0);
  });

  it('ends a resumed order with no marker when the fee rose for an outdated store', async () => {
    const run = await solanaSetup({
      terms: [
        ZERO,
        new FeeConfigError('unavailable', 'down'),
        { feeBps: 100, treasury: solanaAddress() },
      ],
    });
    await run.session.start();
    await run.session.pay('Fake');
    const [left] = await store.forProduct(run.offer.productAddress);
    expect(left).toMatchObject({ state: 'ordered' });
    expect(left?.paymentRequest).toBeUndefined();
    run.session.dispose();
    const resumed = new CheckoutSession(run.offer, run.deps);
    await resumed.start();
    await resumed.pay('Fake');
    const records = await store.forProduct(run.offer.productAddress);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ orderId: left?.orderId, state: 'ended-unpaid' });
    expect(problemOf(run.last())).toBe('store_outdated');
    expect(run.wallet.requests).toBe(0);
  });

  it('pays with no fee leg when the treasury is the payer', async () => {
    const run = await solanaSetup({ terms: [ZERO] });
    // The buyer's own wallet is the treasury: a 100 bps rate, yet no fee leg.
    const terms: FeeTerms = { feeBps: 100, treasury: run.wallet.address };
    run.deps.feeTerms = async () => terms;
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    await run.timers.tick();
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record?.state).toBe('paid');
    const request: unknown = JSON.parse(record?.paymentRequest ?? '{}');
    expect(request).not.toHaveProperty('fee_address');
    expect(request).not.toHaveProperty('fee_amount');
  });

  it('leaves the order as it is when the terms cannot be read before signing', async () => {
    const run = await solanaSetup({
      terms: [ZERO, ZERO, new FeeConfigError('bad_config', 'too high')],
    });
    await run.session.start();
    await run.session.pay('Fake');
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record).toMatchObject({ state: 'ordered' });
    expect(problemOf(run.last())).toBe('fee_config_invalid');
    expect(run.wallet.requests).toBe(0);
  });

  it('leaves the order as it is when the terms are unavailable before signing', async () => {
    const run = await solanaSetup({
      terms: [ZERO, ZERO, new FeeConfigError('unavailable', 'down')],
    });
    await run.session.start();
    await run.session.pay('Fake');
    const [record] = await store.forProduct(run.offer.productAddress);
    expect(record).toMatchObject({ state: 'ordered' });
    expect(problemOf(run.last())).toBe('fee_config_unavailable');
    expect(run.wallet.requests).toBe(0);
  });
});

// ---- Tempo ----------------------------------------------------------------

interface BundleWallet {
  /** What `capabilities` answers, in turn (the last repeats). */
  atomic: boolean[];
  capabilityCalls: number;
  sends: number;
  statusCalls: number;
  status: CallsStatus | Error;
  /** The ids `sendCalls` hands out, in turn (the last repeats); `BUNDLE` when unset. */
  ids?: string[];
  /** The answer about one bundle id, over `status` when it gives one (a test may hold it). */
  statusFor?: (bundleId: string) => Promise<CallsStatus | Error> | undefined;
  /** Thrown by `sendCalls` (a wallet error code). */
  sendError?: number;
  /** Another tab ends the order while the wallet is open. */
  endMeanwhile?: boolean;
  /** `sendCalls` waits for this before it answers (a wallet left open). */
  hold?: Promise<void>;
  /** Called once `sendCalls` is asked. */
  onSend?: () => void;
  connects: number;
}

async function tempoSetup(
  options: {
    terms?: readonly (FeeTerms | Error)[];
    /** Refuse every bundle write to the marker (the id stays unsaved). */
    refuseBundleWrite?: boolean;
    /** The reader EIP-6963 discovery hands out for an rdns (`undefined`: none found). */
    discovered?: boolean;
    /** Whether the store's node declares it can take a fee split (default: it can). */
    feeSupport?: boolean;
  } = {},
) {
  const shop: Shop = makeShop({ caip19: TEMPO_CAIP19, payout: PAYOUT });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const load = async (now: number) => {
    const loaded = await loadOffer(shop.naddr, {
      client: relays,
      pageOrigin: PAGE,
      families: ['evm'],
      now,
    });
    if (!loaded.ok) {
      throw new Error(loaded.message);
    }
    return options.feeSupport === false ? loaded : withFeeSupport(loaded);
  };
  const offer = await load(NOW);
  const head = { number: HEAD };
  const chainOptions = {
    chainId: '0xa5bf',
    finalized: HEAD,
    timestamps: { [HEAD]: NOW + 30 } as Record<number, number>,
    receipts: {} as Record<string, unknown>,
    logs: [] as NonNullable<FakeChainOptions['logs']>,
    onCall: (_to: string, data: string) =>
      data.startsWith('0x70a08231') ? `0x${word(PRICE * 2n)}` : POLICY_YES,
  };
  const fake = fakeTempoChain(chainOptions);
  /** Run once, before the next chain request is answered (a test sets it). */
  const chainGate: { next?: () => Promise<void> } = {};
  const client = {
    request: async (args: { method: string; params?: readonly unknown[] }) => {
      const gate = chainGate.next;
      if (gate !== undefined) {
        chainGate.next = undefined;
        await gate();
      }
      return fake.client.request(
        args.method === 'eth_getBlockByNumber' && args.params?.[0] === 'finalized'
          ? { method: args.method, params: [`0x${head.number.toString(16)}`, false] }
          : args,
      );
    },
  };
  const bundle: BundleWallet = {
    atomic: [true],
    capabilityCalls: 0,
    sends: 0,
    statusCalls: 0,
    status: { status: 100 },
    connects: 0,
  };
  const callsStatus = async (bundleId: string): Promise<CallsStatus> => {
    bundle.statusCalls += 1;
    const status = (await bundle.statusFor?.(bundleId)) ?? bundle.status;
    if (status instanceof Error) {
      throw status;
    }
    return status;
  };
  const tempoWallet: TempoWallet = {
    address: PAYER,
    rdns: RDNS,
    chainId: async () => 42431,
    sendCall: async () => {
      throw new Error('a fee-bearing payment never goes as one transaction');
    },
    capabilities: async () => {
      bundle.capabilityCalls += 1;
      const atomic = bundle.atomic[Math.min(bundle.capabilityCalls - 1, bundle.atomic.length - 1)];
      return { atomic: atomic === true };
    },
    sendCalls: async () => {
      bundle.sends += 1;
      bundle.onSend?.();
      await bundle.hold;
      if (bundle.sendError !== undefined) {
        throw Object.assign(new Error('wallet error'), { code: bundle.sendError });
      }
      if (bundle.endMeanwhile === true) {
        const [open] = await store.forProduct(offer.productAddress);
        const marker = open?.marker;
        if (open !== undefined && marker !== undefined) {
          await store.clearMarker(
            open.orderId,
            open.version,
            marker.attemptId,
            'ended-unpaid',
            'over',
          );
        }
      }
      const ids = bundle.ids ?? [BUNDLE];
      return { bundleId: ids[Math.min(bundle.sends - 1, ids.length - 1)] ?? BUNDLE };
    },
    callsStatus,
  };
  /** Past the request's late deadline, with the traffic that lets "none" be vouched. */
  function pastDeadline(record: OrderRecord): void {
    const request = JSON.parse(record.paymentRequest ?? '{}') as {
      created_at: number;
      expiry_secs: number;
    };
    head.number = LATER;
    chainOptions.timestamps[LATER] = request.created_at + request.expiry_secs + 1800 + 10;
    for (const [index, blockNumber] of [HEAD - 50, LATER - 100].entries()) {
      chainOptions.timestamps[blockNumber] = NOW;
      chainOptions.logs.push({
        address: PATHUSD,
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
  /** Both legs of the bundle, landed in one receipt under `HASH`. */
  function landBoth(memo: string): void {
    chainOptions.timestamps[LAND] = NOW + 40;
    chainOptions.timestamps[LATER] = chainOptions.timestamps[LATER] ?? NOW + 60;
    head.number = LATER;
    const legs = [
      { to: PAYOUT, amount: PRICE - FEE },
      { to: TREASURY, amount: FEE },
    ].map((leg, index) => ({
      address: PATHUSD,
      topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(leg.to)}`, memo],
      data: `0x${word(leg.amount)}`,
      blockNumber: LAND,
      transactionHash: HASH,
      logIndex: index,
    }));
    chainOptions.logs.push(...legs);
    chainOptions.receipts[HASH] = {
      transactionHash: HASH,
      status: '0x1',
      blockNumber: `0x${LAND.toString(16)}`,
      blockHash: `0x${'cd'.repeat(32)}`,
      logs: legs.map((leg) => ({
        ...leg,
        blockNumber: `0x${LAND.toString(16)}`,
        logIndex: `0x${leg.logIndex.toString(16)}`,
        blockHash: `0x${'cd'.repeat(32)}`,
      })),
    };
  }
  const spy = spyStore(store);
  if (options.refuseBundleWrite === true) {
    spy.refuseWrites(
      (method, args) =>
        method === 'updateMarker' &&
        typeof args[3] === 'object' &&
        args[3] !== null &&
        'bundleId' in args[3],
    );
  }
  const timers = new Timers();
  const views: View[] = [];
  const terms = termsSequence(options.terms ?? [{ feeBps: 100, treasury: TREASURY }]);
  let clock = NOW + 30;
  const discovered = options.discovered !== false;
  /** The rdns the one wallet the page finds announces; a test may change it. */
  const found = { rdns: RDNS };
  const deps: SessionDeps = {
    store: spy.store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => undefined,
    feeTerms: terms.source,
    bundleWallet: (rdns) =>
      discovered && rdns === RDNS
        ? { callsStatus: (bundleId: string) => callsStatus(bundleId) }
        : undefined,
    wallets: () => [],
    tempoFor: () => client,
    tempoWallets: () => [
      {
        name: 'MetaMask',
        rdns: found.rdns,
        connect: async () => {
          bundle.connects += 1;
          return tempoWallet;
        },
      },
    ],
    tempoChainTime: async () => clock,
    reloadOffer: () => load(clock),
    now: () => clock,
    chainTime: async () => clock,
    setInterval: timers.set,
    clearInterval: timers.clear,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    onView: (view) => views.push(view),
    onStatus: () => undefined,
  };
  return {
    offer,
    relays,
    deps,
    bundle,
    timers,
    spy,
    pastDeadline,
    landBoth,
    found,
    tempoWallet,
    chainGate,
    terms,
    session: new CheckoutSession(offer, deps),
    /** A session of the same page opened again (a reload). */
    reload: () => new CheckoutSession(offer, deps),
    advance: (seconds: number) => {
      clock += seconds;
    },
    last: () => views.at(-1),
  };
}

async function onlyRecord(offer: Ready): Promise<OrderRecord> {
  const records = await store.forProduct(offer.productAddress);
  const [record] = records;
  if (record === undefined || records.length !== 1) {
    throw new Error(`expected one order, found ${records.length}`);
  }
  return record;
}

function tempoMarker(record: OrderRecord) {
  if (record.marker?.rail !== 'tempo') {
    throw new Error('a Tempo attempt');
  }
  return record.marker;
}

describe('the fee before a Tempo order', () => {
  it('orders nothing for a wallet that cannot send both legs in one batch', async () => {
    const run = await tempoSetup();
    run.bundle.atomic = [false];
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('wallet_cannot_batch');
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
    expect(run.bundle.sends).toBe(0);
  });

  it('asks nothing of the wallet about batching when there is no fee leg', async () => {
    const run = await tempoSetup({ terms: [ZERO] });
    run.bundle.atomic = [false];
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.bundle.capabilityCalls).toBe(0);
  });

  it('leaves the order ordered when the wallet cannot batch at the re-check', async () => {
    const run = await tempoSetup();
    run.bundle.atomic = [true, false];
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await onlyRecord(run.offer);
    expect(record.state).toBe('ordered');
    expect(record.marker).toBeUndefined();
    expect(problemOf(run.last())).toBe('wallet_cannot_batch');
    expect(run.bundle.sends).toBe(0);
  });

  it('ends the order when the fee rose before signing and the store cannot take a split', async () => {
    const run = await tempoSetup({
      feeSupport: false,
      terms: [ZERO, { feeBps: 100, treasury: TREASURY }],
    });
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.terms.calls).toHaveLength(2);
    const record = await onlyRecord(run.offer);
    expect(record).toMatchObject({ state: 'ended-unpaid' });
    expect(problemOf(run.last())).toBe('store_outdated');
    expect(run.bundle.sends).toBe(0);
  });

  it('ends a resumed order with no marker when the fee rose for an outdated store', async () => {
    const run = await tempoSetup({
      feeSupport: false,
      terms: [ZERO, new FeeConfigError('unavailable', 'down'), { feeBps: 100, treasury: TREASURY }],
    });
    await run.session.start();
    await run.session.pay('MetaMask');
    const left = await onlyRecord(run.offer);
    expect(left.state).toBe('ordered');
    expect(left.marker).toBeUndefined();
    run.session.dispose();
    const resumed = run.reload();
    await resumed.start();
    await resumed.pay('MetaMask');
    const record = await onlyRecord(run.offer);
    expect(record).toMatchObject({ orderId: left.orderId, state: 'ended-unpaid' });
    expect(problemOf(run.last())).toBe('store_outdated');
    expect(run.bundle.sends).toBe(0);
  });

  it.each([
    ['fee_config_unavailable', new FeeConfigError('unavailable', 'down')],
    ['fee_config_invalid', new FeeConfigError('bad_config', 'too high')],
  ])(
    'leaves the order ordered when the terms fail before signing (%s)',
    async (reason, failure) => {
      // The terms are read twice: before the order, and again before the wallet is asked.
      const run = await tempoSetup({ terms: [{ feeBps: 100, treasury: TREASURY }, failure] });
      await run.session.start();
      await run.session.pay('MetaMask');
      expect(run.terms.calls).toHaveLength(2);
      const record = await onlyRecord(run.offer);
      expect(record.state).toBe('ordered');
      expect(record.marker).toBeUndefined();
      expect(problemOf(run.last())).toBe(reason);
      expect(run.bundle.sends).toBe(0);
    },
  );

  it('puts the order back to ordered when the wallet refuses the batch before any prompt', async () => {
    const run = await tempoSetup();
    run.bundle.sendError = 5740;
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await onlyRecord(run.offer);
    expect(record.state).toBe('ordered');
    expect(problemOf(run.last())).toBe('wallet_cannot_batch');
  });
});

describe('a Tempo payment as one bundle', () => {
  it('stores the bundle with its wallet, and its hash from the wallet once confirmed', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const sent = await onlyRecord(run.offer);
    expect(tempoMarker(sent)).toMatchObject({ bundleId: BUNDLE, bundleWallet: RDNS });
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', signed: true });
    // The chain shows nothing yet: only the wallet's answer names the hash.
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.timers.tick();
    const confirmed = await onlyRecord(run.offer);
    expect(tempoMarker(confirmed).txHash).toBe(HASH);
    expect(confirmed.receiptWrap).toBeDefined();
  });

  it('marks a stored bundle the wallet reports failed, and shows the request counting down', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    run.bundle.status = { status: 400 };
    await run.timers.tick();
    const record = await onlyRecord(run.offer);
    expect(tempoMarker(record).bundleFailed).toBe(true);
    expect(record.state).toBe('paying');
    const view = run.last();
    expect(view).toMatchObject({ kind: 'waiting_payment', signed: false });
    expect(view?.kind === 'waiting_payment' ? view.requestEndsIn : undefined).toBeDefined();
    expect(problemOf(view)).toBe('wallet_payment_failed');
  });

  it('stops asking about a stored bundle once the modal closes', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    await run.timers.tick();
    const asked = run.bundle.statusCalls;
    expect(asked).toBeGreaterThan(0);
    expect(run.session.resetOnClose()).toBe(true);
    await run.timers.tick();
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    // The marker keeps it: the order still holds the product.
    expect((await onlyRecord(run.offer)).state).toBe('paying');
  });

  it('never ends an order behind an unsaved bundle in the background, until the wallet says it failed', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    await run.session.start();
    await run.session.pay('MetaMask');
    const unsaved = await onlyRecord(run.offer);
    expect(tempoMarker(unsaved).bundleId).toBeUndefined();
    expect(run.session.resetOnClose()).toBe(true);
    // The wallet says nothing about it (not even "pending"): the in-memory id alone holds it.
    run.bundle.status = new Error('no answer');
    run.pastDeadline(unsaved);
    await run.timers.tick();
    await run.timers.tick();
    expect((await onlyRecord(run.offer)).state).toBe('paying');
    // Every press is held meanwhile: no second payment.
    await run.session.pay('MetaMask');
    expect(run.bundle.sends).toBe(1);
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
    // The wallet's final word drops the hold: the bundle-less request ends `over`.
    run.bundle.status = { status: 500 };
    await run.timers.tick();
    await run.timers.tick();
    const ended = await onlyRecord(run.offer);
    expect(ended).toMatchObject({ state: 'ended-unpaid', endedBy: 'over' });
  });

  it.each([
    [
      'confirmed but not atomic',
      { status: 200, atomic: false, receipts: [{ transactionHash: HASH }] },
    ],
    [
      'confirmed with several receipts',
      {
        status: 200,
        atomic: true,
        receipts: [{ transactionHash: HASH }, { transactionHash: `0x${'ef'.repeat(32)}` }],
      },
    ],
    ['partly reverted', { status: 600 }],
  ])(
    'keeps holding an unsaved bundle the wallet answers unsure about (%s)',
    async (_label, status) => {
      const run = await tempoSetup({ refuseBundleWrite: true });
      await run.session.start();
      await run.session.pay('MetaMask');
      const unsaved = await onlyRecord(run.offer);
      expect(tempoMarker(unsaved).bundleId).toBeUndefined();
      expect(run.session.resetOnClose()).toBe(true);
      // An answer no verdict rests on: the approved bundle may still land.
      run.bundle.status = status;
      run.pastDeadline(unsaved);
      await run.timers.tick();
      await run.timers.tick();
      expect((await onlyRecord(run.offer)).state).toBe('paying');
      // Every press is held meanwhile: no second payment.
      await run.session.pay('MetaMask');
      expect(run.bundle.sends).toBe(1);
      expect(run.last()).toMatchObject({
        kind: 'offer',
        problem: { reason: 'earlier_payment', phase: 'confirming' },
      });
      // ... and the bundle is still asked about through its wallet.
      const asked = run.bundle.statusCalls;
      await run.timers.tick();
      expect(run.bundle.statusCalls).toBeGreaterThan(asked);
      expect((await onlyRecord(run.offer)).state).toBe('paying');
    },
  );

  it('holds every press behind an unsaved bundle the wallet returned after the modal closed', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    expect(run.session.resetOnClose()).toBe(true);
    release();
    await pressed;
    await settle(80);
    const record = await onlyRecord(run.offer);
    expect(tempoMarker(record).bundleId).toBeUndefined();
    run.pastDeadline(record);
    await run.timers.tick();
    expect((await onlyRecord(run.offer)).state).toBe('paying');
    await run.session.pay('MetaMask');
    expect(run.bundle.sends).toBe(1);
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
  });

  it('follows an unsaved bundle as a late one once another tab ends its order', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    await run.session.start();
    await run.session.pay('MetaMask');
    const open = await onlyRecord(run.offer);
    expect(tempoMarker(open).bundleId).toBeUndefined();
    // Another tab ends the order behind the in-memory bundle.
    await store.clearMarker(
      open.orderId,
      open.version,
      tempoMarker(open).attemptId,
      'ended-unpaid',
      'over',
    );
    await run.timers.tick();
    await run.timers.tick();
    expect((await onlyRecord(run.offer)).state).toBe('ended-unpaid');
    // The bundle the buyer approved holds every press: no second payment.
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    expect(run.bundle.sends).toBe(1);
    // ... and it is still asked about through its wallet.
    const asked = run.bundle.statusCalls;
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBeGreaterThan(asked);
  });

  it('never ends an order whose unsaved bundle came back while its pass proved it over', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    expect(run.session.resetOnClose()).toBe(true);
    await settle(80);
    const record = await onlyRecord(run.offer);
    // Past the deadline with a vouched "none": the background pass proves the attempt over...
    run.pastDeadline(record);
    run.bundle.status = new Error('no answer');
    // ... and while it reads the chain, the wallet returns the bundle it could not store.
    run.chainGate.next = async () => {
      release();
      await pressed;
      await settle(20);
    };
    await run.timers.tick();
    expect(run.chainGate.next).toBeUndefined();
    const kept = await onlyRecord(run.offer);
    expect(tempoMarker(kept).bundleId).toBeUndefined();
    expect(kept.state).toBe('paying');
    await run.session.pay('MetaMask');
    expect(run.bundle.sends).toBe(1);
  });

  it('never ends an order whose unsaved bundle came back while a press after a close proved it over', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    expect(run.session.resetOnClose()).toBe(true);
    await settle(80);
    const record = await onlyRecord(run.offer);
    // Past the deadline with a vouched "none": the next press's earlier-payment pass proves
    // the attempt over...
    run.pastDeadline(record);
    run.bundle.status = new Error('no answer');
    // ... and while it reads the chain, the wallet returns the bundle it could not store.
    run.chainGate.next = async () => {
      release();
      await pressed;
      await settle(20);
    };
    await run.session.pay('MetaMask');
    expect(run.chainGate.next).toBeUndefined();
    const kept = await onlyRecord(run.offer);
    expect(tempoMarker(kept).bundleId).toBeUndefined();
    expect(kept.state).toBe('paying');
    // The press stops on the earlier payment's line: no wallet request, no second payment.
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment' },
    });
    expect(run.bundle.sends).toBe(1);
  });

  it("holds the open modal's attempt by its unsaved bundle exactly as by a stored one", async () => {
    /** Chain requests of one watch pass of the open modal, past the deadline, the wallet silent. */
    async function heldPass(refuseBundleWrite: boolean): Promise<number> {
      const run = await tempoSetup({ refuseBundleWrite });
      await run.session.start();
      await run.session.pay('MetaMask');
      const record = await onlyRecord(run.offer);
      expect(tempoMarker(record).bundleId).toBe(refuseBundleWrite ? undefined : BUNDLE);
      run.bundle.status = new Error('no answer');
      run.pastDeadline(record);
      let requests = 0;
      const count = async () => {
        requests += 1;
        run.chainGate.next = count;
      };
      run.chainGate.next = count;
      await run.timers.tick();
      await settle(50);
      run.chainGate.next = undefined;
      expect((await onlyRecord(run.offer)).state).toBe('paying');
      expect(run.last()).toMatchObject({ kind: 'waiting_payment', signed: true });
      return requests;
    }
    const stored = await heldPass(false);
    expect(stored).toBeGreaterThan(0);
    // The pass itself sees the attempt held: it never goes on to prove it over again.
    expect(await heldPass(true)).toBe(stored);
  });

  it('never ends an order whose unsaved bundle came back while the open modal proved it over', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    await settle(80);
    const record = await onlyRecord(run.offer);
    // The modal stays open. Past the deadline with a vouched "none": the unanswered-wallet
    // probe proves the attempt over and ends the press...
    run.pastDeadline(record);
    run.bundle.status = new Error('no answer');
    let verdictRead: { reached: Promise<void>; release: () => void } | undefined;
    run.chainGate.next = async () => {
      // ... and the next read of the order is the verdict's, before it ends the order.
      verdictRead = run.spy.hold('get', (args) => args[0] === record.orderId);
    };
    await run.timers.tick();
    expect(run.chainGate.next).toBeUndefined();
    if (verdictRead === undefined) {
      throw new Error('the probe never read the chain');
    }
    await verdictRead.reached;
    // Meanwhile the wallet returns the bundle it could not store.
    release();
    await pressed;
    await settle(20);
    verdictRead.release();
    await settle(80);
    const kept = await onlyRecord(run.offer);
    expect(tempoMarker(kept).bundleId).toBeUndefined();
    expect(kept.state).toBe('paying');
    await run.session.pay('MetaMask');
    expect(run.bundle.sends).toBe(1);
  });

  /**
   * The open modal's probe proves the attempt over and ends the order while the
   * wallet is still open; the wallet then returns the bundle the buyer approved
   * (unsaved: its order ended).
   */
  async function approvedAfterTheProbeEnded() {
    const run = await tempoSetup();
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    await settle(80);
    const record = await onlyRecord(run.offer);
    // Past the deadline with a vouched "none", the wallet silent: the probe ends the order.
    run.pastDeadline(record);
    run.bundle.status = new Error('no answer');
    await run.timers.tick();
    await settle(80);
    expect((await onlyRecord(run.offer)).state).toBe('ended-unpaid');
    expect(problemOf(run.last())).toBe('attempt_over');
    release();
    await pressed;
    await settle(80);
    return { ...run, record };
  }

  it('notes a bundle the wallet returned after the open modal proved its order over and ended it', async () => {
    const run = await approvedAfterTheProbeEnded();
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    // The approval holds every press: no second payment.
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    expect(run.bundle.sends).toBe(1);
  });

  it('asks the wallet nothing more about that bundle once it named the hash and the hash landed', async () => {
    const run = await approvedAfterTheProbeEnded();
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.timers.tick();
    run.landBoth(run.record.reference);
    await run.timers.tick();
    await run.timers.tick();
    expect(await onlyRecord(run.offer)).toMatchObject({ state: 'paid', paidTx: HASH });
    const asked = run.bundle.statusCalls;
    // The paid order holds the press, judged by its hash alone: the wallet is not asked again.
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment' },
    });
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    expect(run.bundle.sends).toBe(1);
  });

  it('holds every press behind a late bundle answer, until the wallet says it failed', async () => {
    const run = await tempoSetup();
    run.bundle.endMeanwhile = true;
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    expect(run.bundle.sends).toBe(1);
    run.bundle.status = { status: 400 };
    await run.timers.tick();
    await run.session.pay('MetaMask');
    // No longer held: the press goes on, to the old-prompt question of the ended order.
    expect(run.last()?.kind).toBe('old_prompt');
  });

  it('holds every press behind a late bundle once the wallet names its hash, and watches that hash', async () => {
    const run = await tempoSetup();
    run.bundle.endMeanwhile = true;
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    // The wallet answers the bundle landed: one receipt, its hash.
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.timers.tick();
    // The hash now holds every press: no second payment, no old-prompt question.
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    expect(run.bundle.sends).toBe(1);
    // The wallet is not asked again: the hash is what is watched now, until it lands.
    const asked = run.bundle.statusCalls;
    run.landBoth((await onlyRecord(run.offer)).reference);
    await run.timers.tick();
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    expect(await onlyRecord(run.offer)).toMatchObject({ state: 'paid', paidTx: HASH });
  });

  it('shows a late bundle seen before a close as the quiet earlier-payment line at the next press', async () => {
    const run = await tempoSetup();
    run.bundle.endMeanwhile = true;
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(problemOf(run.last())).toBe('late_approval');
    // Its ended order's store listener was dropped (the listener cap): only the late
    // bundle itself marks the order as one followed since the close.
    const ended = await onlyRecord(run.offer);
    const listeners = (run.session as unknown as { background: Map<string, { close: () => void }> })
      .background;
    listeners.get(ended.orderId)?.close();
    expect(listeners.delete(ended.orderId)).toBe(true);
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
    expect(run.bundle.sends).toBe(1);
  });

  it('holds every press behind a late bundle answer that came after a close', async () => {
    const run = await tempoSetup();
    run.bundle.endMeanwhile = true;
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    // Closed while the wallet is open: its answer, for an order ended meanwhile, is a late one.
    expect(run.session.resetOnClose()).toBe(true);
    release();
    await pressed;
    await settle(80);
    expect((await onlyRecord(run.offer)).state).toBe('ended-unpaid');
    // Followed since the close: every press shows only that a payment is being confirmed.
    for (let press = 0; press < 2; press += 1) {
      await run.session.pay('MetaMask');
      expect(run.last()).toMatchObject({
        kind: 'offer',
        problem: { reason: 'earlier_payment', phase: 'confirming' },
      });
    }
    expect(run.bundle.sends).toBe(1);
    run.bundle.status = { status: 400 };
    await run.timers.tick();
    await run.session.pay('MetaMask');
    // No longer held: the press goes on, to the old-prompt question of the ended order.
    expect(run.last()?.kind).toBe('old_prompt');
  });

  it('holds the order by the hash of an unsaved bundle it could not store, and watches that hash', async () => {
    const run = await tempoSetup({ refuseBundleWrite: true });
    await run.session.start();
    await run.session.pay('MetaMask');
    const open = await onlyRecord(run.offer);
    expect(tempoMarker(open).bundleId).toBeUndefined();
    // The hash the wallet names cannot be stored either: it lives only in this session.
    run.spy.refuseWrites(
      (method, args) =>
        method === 'updateMarker' &&
        typeof args[3] === 'object' &&
        args[3] !== null &&
        ('bundleId' in args[3] || 'txHash' in args[3]),
    );
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.timers.tick();
    expect(tempoMarker(await onlyRecord(run.offer)).txHash).toBeUndefined();
    // Past the late deadline with a vouched "none": only the in-memory hash holds the order.
    const asked = run.bundle.statusCalls;
    run.pastDeadline(open);
    await run.timers.tick();
    await run.timers.tick();
    expect((await onlyRecord(run.offer)).state).toBe('paying');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', signed: true });
    // The hash is what is watched now, not the bundle.
    expect(run.bundle.statusCalls).toBe(asked);
    // The next press is refused: no second payment.
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
    expect(run.bundle.sends).toBe(1);
    expect((await onlyRecord(run.offer)).state).toBe('paying');
  });

  it("asks the session's own wallet about its stored bundle at a press after a close", async () => {
    const run = await tempoSetup();
    // Discovery finds no wallet for the stored rdns: only the session's own one can answer.
    const session = new CheckoutSession(run.offer, { ...run.deps, bundleWallet: () => undefined });
    await session.start();
    await session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    expect(session.resetOnClose()).toBe(true);
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    const connects = run.bundle.connects;
    await session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).txHash).toBe(HASH);
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
    const view = run.last();
    expect(
      view?.kind === 'offer' && view.problem?.reason === 'earlier_payment'
        ? view.problem.checkWallet
        : 'none',
    ).toBeUndefined();
    expect(run.bundle.connects).toBe(connects);
    expect(run.bundle.sends).toBe(1);
  });

  it('asks the wallet that answered a closed press about its bundle at the next press', async () => {
    // Discovery finds no wallet: only the wallet the closed press asked can answer.
    const run = await tempoSetup({ discovered: false });
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    expect(run.session.resetOnClose()).toBe(true);
    // The wallet answers the closed press: the bundle is saved on the order.
    release();
    await pressed;
    await settle(80);
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    const statusCalls = run.bundle.statusCalls;
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
    const view = run.last();
    expect(
      view?.kind === 'offer' && view.problem?.reason === 'earlier_payment'
        ? view.problem.checkWallet
        : 'none',
    ).toBeUndefined();
    expect(run.bundle.statusCalls).toBeGreaterThan(statusCalls);
    expect(run.bundle.sends).toBe(1);
  });

  it('asks the wallet nothing more about a bundle it said failed, though the failure could not be stored', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    // Every write of the failure is refused: the stored marker still names a live bundle.
    run.spy.refuseWrites(
      (method, args) =>
        method === 'updateMarker' &&
        typeof args[3] === 'object' &&
        args[3] !== null &&
        'bundleFailed' in args[3],
    );
    run.bundle.status = { status: 400 };
    await run.timers.tick();
    const left = tempoMarker(await onlyRecord(run.offer));
    expect(left.bundleId).toBe(BUNDLE);
    expect(left.bundleFailed).toBeUndefined();
    expect(problemOf(run.last())).toBe('wallet_payment_failed');
    const asked = run.bundle.statusCalls;
    expect(asked).toBeGreaterThan(0);
    await run.timers.tick();
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    expect(run.bundle.sends).toBe(1);
  });

  it('asks the wallet nothing more about a bundle it named the hash of, though the hash could not be stored', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    // Every write of the hash is refused: the stored marker still names a live bundle.
    run.spy.refuseWrites(
      (method, args) =>
        method === 'updateMarker' &&
        typeof args[3] === 'object' &&
        args[3] !== null &&
        'txHash' in args[3],
    );
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.timers.tick();
    expect(tempoMarker(await onlyRecord(run.offer)).txHash).toBeUndefined();
    const asked = run.bundle.statusCalls;
    expect(asked).toBeGreaterThan(0);
    await run.timers.tick();
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    expect(run.bundle.sends).toBe(1);
  });

  it('asks the wallet nothing more about its bundle once another tab stored that it failed', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    // Another tab of the page hears the failure first and stores it.
    run.bundle.status = { status: 400 };
    await run.reload().start();
    await settle(80);
    expect(tempoMarker(await onlyRecord(run.offer)).bundleFailed).toBe(true);
    const asked = run.bundle.statusCalls;
    await run.timers.tick();
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    expect(run.bundle.sends).toBe(1);
  });

  it('asks the wallet nothing more about its bundle once another tab stored its hash', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    // Another tab of the page hears the hash first and stores it.
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.reload().start();
    await settle(80);
    expect(tempoMarker(await onlyRecord(run.offer)).txHash).toBe(HASH);
    const asked = run.bundle.statusCalls;
    await run.timers.tick();
    await run.timers.tick();
    expect(run.bundle.statusCalls).toBe(asked);
    expect(run.bundle.sends).toBe(1);
  });

  it('follows an order another tab found paid while the wallet was open, not as a late approval', async () => {
    const run = await tempoSetup();
    let release: () => void = () => undefined;
    run.bundle.hold = new Promise((resolve) => {
      release = resolve;
    });
    let asked: () => void = () => undefined;
    const sendAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    run.bundle.onSend = asked;
    await run.session.start();
    const pressed = run.session.pay('MetaMask');
    await sendAsked;
    const record = await onlyRecord(run.offer);
    // Both legs land while the wallet is still open, and another tab finds them.
    run.landBoth(record.reference);
    await run.reload().start();
    await settle(80);
    expect((await onlyRecord(run.offer)).state).toBe('paid');
    // The wallet returns the bundle now: it cannot be stored on a paid order.
    release();
    await pressed;
    await settle(80);
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBeUndefined();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect(run.bundle.sends).toBe(1);
  });

  it('stops a press after a close that closes again while the wallet is asked about its bundle', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(run.offer)).bundleId).toBe(BUNDLE);
    expect(run.session.resetOnClose()).toBe(true);
    const sent = await onlyRecord(run.offer);
    let chainRequests = 0;
    const count = async () => {
      chainRequests += 1;
      run.chainGate.next = count;
    };
    let closedAt: View | undefined;
    let closed = false;
    // The modal closes again while the press's status read is out: the wallet says "pending".
    Object.defineProperty(run.bundle, 'status', {
      configurable: true,
      get: () => {
        if (!closed) {
          closed = true;
          expect(run.session.resetOnClose()).toBe(true);
          closedAt = run.last();
          run.chainGate.next = count;
        }
        return { status: 100 };
      },
    });
    await run.session.pay('MetaMask');
    await settle(50);
    run.chainGate.next = undefined;
    expect(closed).toBe(true);
    // The detached press runs no watch pass, draws nothing, ends nothing and sends nothing.
    expect(chainRequests).toBe(0);
    expect(run.last()).toBe(closedAt);
    expect(run.bundle.sends).toBe(1);
    expect(await onlyRecord(run.offer)).toEqual(sent);
  });
});

describe('a bundle observed after a reload', () => {
  it('asks the wallet that approved it without connecting, and releases the product at the deadline', async () => {
    const first = await tempoSetup();
    await first.session.start();
    await first.session.pay('MetaMask');
    first.session.dispose();
    first.bundle.status = { status: 400 };
    const connected = first.bundle.connects;
    const page = first.reload();
    await page.start();
    await settle(80);
    const observed = await onlyRecord(first.offer);
    expect(tempoMarker(observed).bundleFailed).toBe(true);
    expect(first.bundle.connects).toBe(connected);
    // The press sees a request counting down, not a confirming payment.
    await page.pay('MetaMask');
    const line = first.last();
    expect(line).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'tempo_request' },
    });
    expect(first.bundle.sends).toBe(1);
    // Past the late deadline with a vouched "none": the order ends `over`, the product is free.
    first.pastDeadline(observed);
    await page.pay('MetaMask');
    expect(await store.forProduct(first.offer.productAddress)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderId: observed.orderId,
          state: 'ended-unpaid',
          endedBy: 'over',
        }),
      ]),
    );
  });

  it('asks no wallet about a bundle already marked failed, and offers no "Check in wallet"', async () => {
    const first = await tempoSetup({ discovered: false });
    await first.session.start();
    await first.session.pay('MetaMask');
    first.bundle.status = { status: 400 };
    await first.timers.tick();
    const failed = await onlyRecord(first.offer);
    expect(tempoMarker(failed).bundleFailed).toBe(true);
    first.session.dispose();
    const asked = first.bundle.statusCalls;
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    expect(first.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'tempo_request' },
    });
    const view = first.last();
    expect(
      view?.kind === 'offer' && view.problem?.reason === 'earlier_payment'
        ? view.problem.checkWallet
        : 'none',
    ).toBeUndefined();
    expect(first.bundle.statusCalls).toBe(asked);
    expect(first.bundle.sends).toBe(1);
  });

  it('offers "Check in wallet" when no wallet answers, and asks after connecting', async () => {
    const first = await tempoSetup({ discovered: false });
    await first.session.start();
    await first.session.pay('MetaMask');
    first.session.dispose();
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    expect(first.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming', checkWallet: true },
    });
    const connects = first.bundle.connects;
    first.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await page.checkInWallet();
    expect(first.bundle.connects).toBe(connects + 1);
    expect(tempoMarker(await onlyRecord(first.offer)).txHash).toBe(HASH);
    expect(first.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming' },
    });
    const view = first.last();
    expect(
      view?.kind === 'offer' && view.problem?.reason === 'earlier_payment'
        ? view.problem.checkWallet
        : 'none',
    ).toBeUndefined();
    expect(first.bundle.sends).toBe(1);
  });

  it('shows the free offer when "Check in wallet" hears the bundle failed past the deadline', async () => {
    const first = await tempoSetup({ discovered: false });
    await first.session.start();
    await first.session.pay('MetaMask');
    first.session.dispose();
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    expect(first.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'confirming', checkWallet: true },
    });
    const held = await onlyRecord(first.offer);
    first.bundle.status = { status: 400 };
    first.pastDeadline(held);
    await page.checkInWallet();
    const ended = await onlyRecord(first.offer);
    expect(ended).toMatchObject({ state: 'ended-unpaid', endedBy: 'over' });
    const view = first.last();
    expect(view?.kind).toBe('offer');
    expect(view?.kind === 'offer' ? view.problem : 'none').toBeUndefined();
    expect(first.bundle.sends).toBe(1);
  });

  it('connects no other wallet than the one that approved the bundle at "Check in wallet"', async () => {
    const first = await tempoSetup({ discovered: false });
    await first.session.start();
    await first.session.pay('MetaMask');
    first.session.dispose();
    // The page now finds one wallet only, and it is another one.
    first.found.rdns = 'io.other';
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    const connects = first.bundle.connects;
    first.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await page.checkInWallet();
    expect(first.bundle.connects).toBe(connects);
    expect(problemOf(first.last())).toBe('no_wallet');
    expect(tempoMarker(await onlyRecord(first.offer)).txHash).toBeUndefined();
    expect(first.bundle.sends).toBe(1);
  });

  it('checks in through the one wallet the page finds when the approving wallet had no name', async () => {
    const first = await tempoSetup({ discovered: false });
    delete first.tempoWallet.rdns;
    await first.session.start();
    await first.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(first.offer)).bundleWallet).toBeUndefined();
    first.session.dispose();
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    const connects = first.bundle.connects;
    first.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await page.checkInWallet();
    expect(first.bundle.connects).toBe(connects + 1);
    expect(tempoMarker(await onlyRecord(first.offer)).txHash).toBe(HASH);
  });

  it('checks in through no wallet when the approving wallet had no name and the page finds two', async () => {
    const first = await tempoSetup({ discovered: false });
    delete first.tempoWallet.rdns;
    await first.session.start();
    await first.session.pay('MetaMask');
    expect(tempoMarker(await onlyRecord(first.offer)).bundleWallet).toBeUndefined();
    first.session.dispose();
    const findOne = first.deps.tempoWallets;
    first.deps.tempoWallets = (network) => {
      const [option] = findOne?.(network) ?? [];
      if (option === undefined) {
        throw new Error('the page finds a wallet');
      }
      return [option, { ...option, name: 'Other', rdns: 'io.other' }];
    };
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    const connects = first.bundle.connects;
    const asked = first.bundle.statusCalls;
    const marker = tempoMarker(await onlyRecord(first.offer));
    first.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await page.checkInWallet();
    expect(first.bundle.connects).toBe(connects);
    expect(first.bundle.statusCalls).toBe(asked);
    expect(problemOf(first.last())).toBe('no_wallet');
    expect(tempoMarker(await onlyRecord(first.offer))).toEqual(marker);
    expect(first.bundle.sends).toBe(1);
  });

  it('asks no wallet about a bundle whose hash is already stored', async () => {
    const first = await tempoSetup();
    await first.session.start();
    await first.session.pay('MetaMask');
    first.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await first.timers.tick();
    expect(tempoMarker(await onlyRecord(first.offer)).txHash).toBe(HASH);
    first.session.dispose();
    const asked = first.bundle.statusCalls;
    const page = first.reload();
    await page.start();
    await settle(80);
    await page.pay('MetaMask');
    expect(first.bundle.statusCalls).toBe(asked);
    expect(first.bundle.sends).toBe(1);
  });

  it('keeps an unanswered bundle held through a reload (the wallet does not know it)', async () => {
    const first = await tempoSetup();
    await first.session.start();
    await first.session.pay('MetaMask');
    first.session.dispose();
    first.bundle.status = new Error('5730 unknown bundle');
    const page = first.reload();
    await page.start();
    const record = await onlyRecord(first.offer);
    first.pastDeadline(record);
    await page.pay('MetaMask');
    expect((await onlyRecord(first.offer)).state).toBe('paying');
    expect(first.bundle.sends).toBe(1);
  });

  it('draws no problem on the order on screen when the bundle of another order fails', async () => {
    const first = await tempoSetup();
    first.bundle.ids = ['bundle-a', 'bundle-b'];
    await first.session.start();
    await first.session.pay('MetaMask');
    first.session.dispose();
    const earlier = await onlyRecord(first.offer);
    expect(tempoMarker(earlier).bundleId).toBe('bundle-a');
    // The reload asks the wallet about the earlier bundle; that first answer comes late.
    let answer: () => void = () => undefined;
    const answered = new Promise<CallsStatus>((resolve) => {
      answer = () => resolve({ status: 400 });
    });
    let askedEarlier = 0;
    first.bundle.statusFor = (bundleId) => {
      if (bundleId !== 'bundle-a') {
        return undefined;
      }
      askedEarlier += 1;
      return askedEarlier === 1 ? answered : Promise.resolve({ status: 400 });
    };
    const page = first.reload();
    await page.start();
    // The press hears the failure itself, ends the earlier order past its deadline,
    // and pays a new one once the buyer confirms the old prompt.
    first.pastDeadline(earlier);
    await page.pay('MetaMask');
    expect(first.last()?.kind).toBe('old_prompt');
    await page.confirmOldPrompt();
    await settle(80);
    const records = await store.forProduct(first.offer.productAddress);
    const shown = records.find((record) => record.orderId !== earlier.orderId);
    if (shown === undefined) {
      throw new Error('no new order');
    }
    expect(tempoMarker(shown).bundleId).toBe('bundle-b');
    expect(first.last()).toMatchObject({ kind: 'waiting_payment', signed: true });
    // Now the load's late answer about the earlier bundle comes: it failed.
    answer();
    await settle(80);
    await first.timers.tick();
    const failed = await store.get(earlier.orderId);
    if (failed === undefined) {
      throw new Error('no earlier order');
    }
    expect(tempoMarker(failed).bundleFailed).toBe(true);
    expect(askedEarlier).toBeGreaterThan(1);
    const view = first.last();
    expect(view).toMatchObject({ kind: 'waiting_payment', signed: true });
    expect(problemOf(view)).toBeUndefined();
  });

  it('lands both legs of the bundle: the order is paid', async () => {
    const run = await tempoSetup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const record = await onlyRecord(run.offer);
    run.landBoth(record.reference);
    run.bundle.status = { status: 200, atomic: true, receipts: [{ transactionHash: HASH }] };
    await run.timers.tick();
    await run.timers.tick();
    expect(await onlyRecord(run.offer)).toMatchObject({ state: 'paid', paidTx: HASH });
  });
});

describe('a close while the fee is checked before an order', () => {
  /** Fee terms that close the modal (the press is detached) before they answer. */
  function closingTerms(
    run: { session: CheckoutSession },
    terms: FeeTerms,
  ): SessionDeps['feeTerms'] {
    return async () => {
      expect(run.session.resetOnClose()).toBe(true);
      return terms;
    };
  }

  /** What the detached press leaves: no order, nothing sent, the plain offer. */
  async function nothingOrdered(run: {
    offer: Ready;
    relays: MemoryRelays;
    last: () => View | undefined;
  }): Promise<void> {
    expect(await store.forProduct(run.offer.productAddress)).toEqual([]);
    expect(run.relays.published).toHaveLength(0);
    const shown = run.last();
    expect(shown).toMatchObject({ kind: 'offer' });
    expect(shown?.kind === 'offer' ? shown.problem : 'none').toBeUndefined();
  }

  it('orders nothing on Solana when the modal closed while a zero fee was read', async () => {
    const run = await solanaSetup({ terms: [ZERO] });
    run.deps.feeTerms = closingTerms(run, ZERO);
    await run.session.start();
    await run.session.pay('Fake');
    await settle();
    await nothingOrdered(run);
    expect(run.wallet.requests).toBe(0);
  });

  it('draws no refusal on Solana when the modal closed while the terms were read', async () => {
    const run = await solanaSetup({ terms: [ZERO] });
    run.deps.feeTerms = closingTerms(run, { feeBps: 100, treasury: solanaAddress() });
    await run.session.start();
    await run.session.pay('Fake');
    await settle();
    await nothingOrdered(run);
    expect(run.wallet.requests).toBe(0);
  });

  it('orders nothing on Tempo when the modal closed while a zero fee was read', async () => {
    const run = await tempoSetup();
    run.deps.feeTerms = closingTerms(run, ZERO);
    await run.session.start();
    await run.session.pay('MetaMask');
    await settle();
    await nothingOrdered(run);
    expect(run.bundle.capabilityCalls).toBe(0);
    expect(run.bundle.sends).toBe(0);
  });

  it('draws no refusal on Tempo when the modal closed while the terms were read', async () => {
    const run = await tempoSetup({ feeSupport: false });
    run.deps.feeTerms = closingTerms(run, { feeBps: 100, treasury: TREASURY });
    await run.session.start();
    await run.session.pay('MetaMask');
    await settle();
    await nothingOrdered(run);
    expect(run.bundle.capabilityCalls).toBe(0);
    expect(run.bundle.sends).toBe(0);
  });

  it('draws no batching refusal when the modal closed while the wallet was asked', async () => {
    const run = await tempoSetup();
    run.tempoWallet.capabilities = async () => {
      run.bundle.capabilityCalls += 1;
      expect(run.session.resetOnClose()).toBe(true);
      return { atomic: false };
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    await settle();
    expect(run.bundle.capabilityCalls).toBe(1);
    await nothingOrdered(run);
    expect(run.bundle.sends).toBe(0);
  });

  it('orders nothing when the modal closed while a batching wallet was asked', async () => {
    const run = await tempoSetup();
    run.tempoWallet.capabilities = async () => {
      run.bundle.capabilityCalls += 1;
      expect(run.session.resetOnClose()).toBe(true);
      return { atomic: true };
    };
    await run.session.start();
    await run.session.pay('MetaMask');
    await settle();
    expect(run.bundle.capabilityCalls).toBe(1);
    await nothingOrdered(run);
    expect(run.bundle.sends).toBe(0);
  });
});
