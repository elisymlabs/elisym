import { type OrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import {
  type LoadedOffer,
  type OrderRecord,
  OrderStore,
  type TempoWallet,
  loadOffer,
} from '@elisym/commerce/buyer';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryRelays,
  NOW,
  type Shop,
  inboxList,
  makeShop,
} from '../../commerce/tests/buyer/fixtures';
import {
  TEMPO_TRANSFER_GUARD,
  TRANSFER_BLOCKED_TOPIC,
  TRANSFER_WITH_MEMO_TOPIC,
} from '../../pay-core/src/evm/constants';
import { type FakeChainOptions, fakeTempoChain } from '../../pay-core/tests/tempo-chain';
import {
  type Banner,
  CheckoutSession,
  type SessionDeps,
  REPUBLISH_EVERY_MS,
  UNSURE_AFTER_SECS,
  type View,
  WATCH_EVERY_MS,
} from '../src/app/session';
import { isTakingLong } from '../src/app/ui/UnansweredHint';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import type { CheckoutState } from '../src/embed/protocol';
/**
 * Closing the modal resets it, never a double spend (commerce-modal-reset.md),
 * on Tempo: a request that never expires, its hash, the old-prompt question.
 */
import { NO_FEE_TERMS } from './fee-fixtures';
import { gate, internals, settle, spyStore } from './reset-harness';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
/** Moderato pathUSD: the registry's devnet. */
const TEMPO_CAIP19 = `eip155:42431/erc20:${PATHUSD}`;
const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PRICE = 49_000_000n;
const HEAD = 40_000_000;
const LAND = HEAD + 10;
const LATER = HEAD + 1000;
const POLICY_YES = `0x${'0'.repeat(63)}1${'0'.repeat(64)}`;
const HASH = `0x${'ab'.repeat(32)}`;

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;
/** The store's backend: a test may write a record as another tab left it. */
let backend: IndexedDbOrderBackend;

beforeEach(async () => {
  backend = new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory()));
  store = new OrderStore(backend);
});

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

class Timers {
  private next = 1;
  readonly running = new Map<number, { handler: () => void; ms: number }>();
  set = (handler: () => void, ms: number) => {
    const id = this.next;
    this.next += 1;
    this.running.set(id, { handler, ms });
    return id;
  };
  clear = (id: unknown) => {
    this.running.delete(id as number);
  };
  async tick(ms?: number): Promise<void> {
    for (const timer of [...this.running.values()]) {
      if (ms === undefined || timer.ms === ms) {
        timer.handler();
      }
    }
    await settle(60);
  }
  count(ms: number): number {
    return [...this.running.values()].filter((timer) => timer.ms === ms).length;
  }
}

type Behaviour =
  | 'land'
  | 'drop'
  | 'reject'
  | 'fail'
  | 'ended-meanwhile'
  | 'ended-meanwhile-unseen'
  | 'answered-meanwhile';

async function setup(transform: (offer: Ready) => Ready = (offer) => offer) {
  const shop: Shop = makeShop({ caip19: TEMPO_CAIP19, payout: PAYOUT });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const load = async (now: number) => {
    const loaded = await loadOffer(shop.naddr, {
      client: relays,
      pageOrigin: PAGE,
      families: ['evm'],
      now,
    });
    return loaded.ok ? transform(loaded) : loaded;
  };
  const offer = (await load(NOW)) as Ready;
  if (!offer.ok) {
    throw new Error('offer');
  }
  const head = { number: HEAD };
  const options = {
    chainId: '0xa5bf',
    finalized: HEAD,
    timestamps: { [HEAD]: NOW + 30 } as Record<number, number>,
    receipts: {} as Record<string, unknown>,
    logs: [] as NonNullable<FakeChainOptions['logs']>,
    onCall: (_to: string, data: string) =>
      data.startsWith('0x70a08231') ? `0x${word(PRICE * 2n)}` : POLICY_YES,
  };
  const fake = fakeTempoChain(options);
  const client = {
    request: (args: { method: string; params?: readonly unknown[] }) =>
      fake.client.request(
        args.method === 'eth_getBlockByNumber' && args.params?.[0] === 'finalized'
          ? { method: args.method, params: [`0x${head.number.toString(16)}`, false] }
          : args,
      ),
  };
  const wallet = {
    behaviour: 'land' as Behaviour,
    requests: 0,
    /** The chain the wallet answers it is on, read right before the request. */
    chainId: async () => 42431,
    /** Run while the wallet "shows" the request, before it answers. */
    duringPrompt: undefined as (() => Promise<void>) | undefined,
  };
  const tempoWallet: TempoWallet = {
    address: PAYER,
    chainId: () => wallet.chainId(),
    sendCall: async (call) => {
      wallet.requests += 1;
      await wallet.duringPrompt?.();
      if (wallet.behaviour === 'reject') {
        throw Object.assign(new Error('User rejected'), { code: 4001 });
      }
      if (wallet.behaviour === 'fail') {
        throw new Error('gone');
      }
      if (wallet.behaviour === 'land') {
        land(`0x${call.data.slice(-64)}`);
      }
      if (wallet.behaviour === 'answered-meanwhile') {
        // The store delivers while the wallet is still open: the hash cannot be saved.
        land(`0x${call.data.slice(-64)}`);
        const [open] = await store.forProduct(offer.productAddress);
        if (open !== undefined) {
          await completed(open);
        }
      }
      if (wallet.behaviour === 'ended-meanwhile' || wallet.behaviour === 'ended-meanwhile-unseen') {
        // Another tab ended the order while this prompt was open; the buyer approves anyway
        // (unseen: the chain does not show it yet).
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
        if (wallet.behaviour === 'ended-meanwhile') {
          land(`0x${call.data.slice(-64)}`);
        }
      }
      return HASH;
    },
  };
  function land(memo: string): void {
    options.timestamps[LAND] = NOW + 40;
    options.timestamps[LATER] = options.timestamps[LATER] ?? NOW + 60;
    head.number = LATER;
    const log = {
      address: PATHUSD,
      topics: [TRANSFER_WITH_MEMO_TOPIC, `0x${word(PAYER)}`, `0x${word(PAYOUT)}`, memo],
      data: `0x${word(PRICE)}`,
      blockNumber: LAND,
      transactionHash: HASH,
      logIndex: 0,
    };
    options.logs.push(log);
    options.receipts[HASH] = {
      transactionHash: HASH,
      status: '0x1',
      blockNumber: `0x${LAND.toString(16)}`,
      blockHash: `0x${'cd'.repeat(32)}`,
      logs: [
        {
          ...log,
          blockNumber: `0x${LAND.toString(16)}`,
          logIndex: '0x0',
          blockHash: `0x${'cd'.repeat(32)}`,
        },
      ],
    };
  }
  /** The store's delivery of `record`, heard by the widget. */
  async function completed(record: OrderRecord): Promise<void> {
    const status = {
      type: 'status',
      buyerPubkey: record.buyerPubkey,
      orderId: record.orderId,
      status: 'completed',
      delivery: { method: 'access', value: 'https://shop.example/course' },
    } as OrderMessage;
    await relays.publish(
      INBOX,
      wrapOrderMessage(
        buildOrderMessage(status, NOW + 100),
        shop.store.secretKey,
        record.buyerPubkey,
      ).recipientWrap,
    );
    await settle();
  }
  /** Past the request's late deadline, with the traffic that lets "none" be vouched. */
  function pastDeadline(record: OrderRecord): void {
    const request = JSON.parse(record.paymentRequest ?? '{}') as {
      created_at: number;
      expiry_secs: number;
    };
    head.number = LATER;
    options.timestamps[LATER] = request.created_at + request.expiry_secs + 1800 + 10;
    for (const [index, blockNumber] of [HEAD - 50, LATER - 100].entries()) {
      options.timestamps[blockNumber] = NOW;
      options.logs.push({
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
  /** The guard's `TransferBlocked` for this request's provider leg: the payout's policy refused it. */
  function blockedLeg(memo: string): void {
    const words = [
      word(PRICE),
      word(1n),
      word(0x60n),
      word(320n),
      word(1n),
      word(PATHUSD),
      word(PAYER),
      word(PAYER),
      word(PAYOUT),
      word(0n),
      word(0n),
      word(0n),
      word(0n),
      word(memo),
    ];
    options.logs.push({
      address: TEMPO_TRANSFER_GUARD,
      topics: [TRANSFER_BLOCKED_TOPIC, `0x${word(PATHUSD)}`, `0x${word(PAYOUT)}`, `0x${word(1n)}`],
      data: `0x${words.join('')}`,
      blockNumber: LATER - 200,
      transactionHash: `0x${'ef'.repeat(32)}`,
      logIndex: 0,
    });
  }
  const timers = new Timers();
  const views: View[] = [];
  const statuses: CheckoutState[] = [];
  const banners: (Banner | undefined)[] = [];
  const spy = spyStore(store);
  let clock = NOW + 30;
  const deps: SessionDeps = {
    store: spy.store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => undefined,
    feeTerms: NO_FEE_TERMS,
    wallets: () => [],
    tempoFor: () => client,
    tempoWallets: () => [{ name: 'MetaMask', connect: async () => tempoWallet }],
    tempoChainTime: async () => clock,
    reloadOffer: () => load(clock),
    now: () => clock,
    chainTime: async () => clock,
    setInterval: timers.set,
    clearInterval: timers.clear,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    onView: (view) => views.push(view),
    onStatus: (state) => statuses.push(state),
    onBanner: (banner) => banners.push(banner),
    readAll: () => backend.all(),
  };
  return {
    shop,
    relays,
    offer,
    deps,
    wallet,
    timers,
    views,
    statuses,
    banners,
    spy,
    land,
    pastDeadline,
    blockedLeg,
    completed,
    receipts: options.receipts,
    session: new CheckoutSession(offer, deps),
    advance: (seconds: number) => {
      clock += seconds;
    },
    now: () => clock,
    last: () => views.at(-1),
  };
}

type Run = Awaited<ReturnType<typeof setup>>;

async function records(run: Run): Promise<OrderRecord[]> {
  return store.forProduct(run.offer.productAddress);
}

async function only(run: Run): Promise<OrderRecord> {
  const all = await records(run);
  const [record] = all;
  if (all.length !== 1 || record === undefined) {
    throw new Error(`expected one order, found ${all.length}`);
  }
  return record;
}

/** The request's late deadline, from the stored record. */
function deadlineOf(record: OrderRecord): number {
  const request = JSON.parse(record.paymentRequest ?? '{}') as {
    created_at: number;
    expiry_secs: number;
  };
  return request.created_at + request.expiry_secs + 1800;
}

function lineOf(view: View | undefined) {
  return view?.kind === 'offer' && view.problem?.reason === 'earlier_payment'
    ? view.problem
    : undefined;
}

function after(run: Run) {
  const views = run.views.length;
  const statuses = run.statuses.length;
  return {
    views: () => run.views.slice(views),
    statuses: () => run.statuses.slice(statuses),
  };
}

/** A Tempo press whose wallet request is held open: resolves once the wallet was asked. */
async function requestHeld(run: Run) {
  const prompt = gate();
  const asked = gate();
  run.wallet.duringPrompt = async () => {
    asked.open();
    await prompt.promise;
  };
  const pressed = run.session.pay('MetaMask');
  await asked.promise;
  await settle();
  run.wallet.duringPrompt = undefined;
  return { pressed, answer: prompt.open };
}

describe('Tempo: a close during the wallet request', () => {
  it('the request goes on in the background; its hash is saved and its receipt sent (R-e, M46)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    expect(internals(run.session).followers.has(order.orderId)).toBe(true);
    const later = after(run);
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    const stored = await only(run);
    expect(stored.marker?.rail === 'tempo' ? stored.marker.txHash : undefined).toBe(HASH);
    expect(stored.receiptWrap).toBeDefined();
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    // A reload stand-in: the press sees an approved request (no countdown), and at the
    // late deadline the attempt is still held, never judged over.
    run.session.dispose();
    const again = new CheckoutSession(run.offer, {
      ...run.deps,
      onView: (view) => run.views.push(view),
    });
    await again.start();
    await again.pay('MetaMask');
    expect(lineOf(run.last())).toEqual({ reason: 'earlier_payment', phase: 'confirming' });
    run.pastDeadline(stored);
    run.advance(deadlineOf(stored) - (NOW + 30) + 10);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await only(run)).state).toBe('paying');
    expect(run.wallet.requests).toBe(1);
  });

  it('a press meanwhile: "your wallet already has a request open", with the countdown; a rejection clears it (R-c, M49)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(1);
    const now = NOW + 30;
    expect(lineOf(run.last())).toEqual({
      reason: 'earlier_payment',
      phase: 'tempo_request',
      retryIn: { seconds: deadlineOf(order) - now, at: now },
    });
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect(lineOf(run.last())).toBeUndefined();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(2);
  });

  it('a hash returned after a close but not stored: the press passes it to its pass, which stores it (M29, M30)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    expect(run.session.resetOnClose()).toBe(true);
    // The hash write is lost: only the session knows the hash now.
    run.spy.refuseWrites(
      (method, args) =>
        method === 'updateMarker' &&
        typeof args[3] === 'object' &&
        args[3] !== null &&
        'txHash' in args[3],
    );
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    run.spy.refuseWrites(undefined);
    const order = await only(run);
    expect(order.marker?.rail === 'tempo' ? order.marker.txHash : 'none').toBeUndefined();
    await run.session.pay('MetaMask');
    expect(lineOf(run.last())).toEqual({ reason: 'earlier_payment', phase: 'confirming' });
    const stored = await only(run);
    expect(stored.marker?.rail === 'tempo' ? stored.marker.txHash : undefined).toBe(HASH);
    expect(run.wallet.requests).toBe(1);
  });

  it('a follower whose tick stopped while its republishing runs: marked again by another tab, its tick is armed again (round 2 LOW-3)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    expect(run.session.resetOnClose()).toBe(true);
    const hashWrite = (method: string, args: unknown[]) =>
      method === 'updateMarker' &&
      typeof args[3] === 'object' &&
      args[3] !== null &&
      'txHash' in args[3];
    // The hash write is lost: the background tick passes the hash to its pass.
    run.spy.refuseWrites(hashWrite);
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    run.spy.refuseWrites(undefined);
    const order = await only(run);
    const firstMarker = order.marker;
    if (firstMarker?.rail !== 'tempo') {
      throw new Error('no Tempo marker');
    }
    const armed = internals(run.session).followers.get(order.orderId);
    expect(armed?.timer).toBeDefined();
    expect(armed?.republish).toBeDefined();
    // The tick's hash write meets another tab's decline: the tick stops, the republishing stays.
    const write = run.spy.hold('updateMarker', (args) => hashWrite('updateMarker', args));
    await run.timers.tick(WATCH_EVERY_MS);
    await write.reached;
    const marked = await only(run);
    await store.clearMarker(marked.orderId, marked.version, firstMarker.attemptId, 'ordered');
    write.release();
    await settle(60);
    const halfArmed = internals(run.session).followers.get(order.orderId);
    expect(halfArmed?.timer).toBeUndefined();
    expect(halfArmed?.republish).toBeDefined();
    const republishHandle = halfArmed?.republish;
    // Another tab pays it again; the press meets its line.
    const cleared = await only(run);
    const remarked = await store.setMarker(cleared.orderId, cleared.version, {
      ...firstMarker,
      attemptId: 'another-tab',
    });
    expect(remarked.ok).toBe(true);
    await run.session.pay('MetaMask');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    const rearmed = internals(run.session).followers.get(order.orderId);
    expect(rearmed?.timer).toBeDefined();
    expect(rearmed?.republish).toBe(republishHandle);
    expect(run.timers.count(REPUBLISH_EVERY_MS)).toBe(1);
    expect(run.timers.count(WATCH_EVERY_MS)).toBe(1);
    // Its payment lands: the background tick records it, then the store's answer clears the line.
    run.land(order.reference);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await only(run)).state).toBe('paid');
    await run.completed(order);
    expect((await only(run)).state).toBe('completed');
    expect(lineOf(run.last())).toBeUndefined();
    expect(internals(run.session).followers.has(order.orderId)).toBe(false);
    expect(run.wallet.requests).toBe(1);
  });

  it('past the late deadline, the press ends it and asks the old-prompt question first (R-f, M74)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    run.pastDeadline(order);
    run.advance(deadlineOf(order) - (NOW + 30) + 10);
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt', orders: 1 });
    expect(run.wallet.requests).toBe(1);
    expect(await store.get(order.orderId)).toMatchObject({
      state: 'ended-unpaid',
      endedBy: 'over',
    });
    expect(internals(run.session).background.has(order.orderId)).toBe(true);
    const later = after(run);
    await run.completed(order);
    expect((await store.get(order.orderId))?.state).toBe('completed');
    expect(later.statuses()).toEqual([]);
    void held;
  });

  it('a wrong chain cleared just before the close: the order stays the open one (M60)', async () => {
    const run = await setup();
    await run.session.start();
    let read: { reached: Promise<void>; release(): void } | undefined;
    run.wallet.chainId = async () => {
      // The session's own read after the rail answered is held.
      read = run.spy.hold('get');
      return 1;
    };
    const pressed = run.session.pay('MetaMask');
    for (let turn = 0; turn < 100 && read === undefined; turn += 1) {
      await settle(1);
    }
    if (read === undefined) {
      throw new Error('the wallet was never asked for its chain');
    }
    await read.reached;
    const order = await only(run);
    expect(order.state).toBe('ordered');
    expect(run.session.resetOnClose()).toBe(true);
    const state = internals(run.session);
    expect(state.record?.orderId).toBe(order.orderId);
    expect(state.silent).toBe(order.orderId);
    expect(state.followers.has(order.orderId)).toBe(false);
    read.release();
    await pressed;
  });
});

describe('Tempo: the probe', () => {
  it('U-e before the late deadline it waits; after it the order ends `over` (U-c4, M13, M22)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'working', step: 'signing' });
    // The probe's countdown is the request's late deadline (Tempo has no retry estimate).
    const now = NOW + 30;
    const marker = (await only(run)).marker;
    if (marker === undefined) {
      throw new Error('no marker');
    }
    expect(run.last()).toMatchObject({
      startOverIn: { seconds: deadlineOf(order) - now, at: now },
      unsureAt: marker.setAt + UNSURE_AFTER_SECS,
    });
    run.pastDeadline(order);
    run.advance(deadlineOf(order) - (NOW + 30) + 10);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'attempt_over' } });
    expect(await store.get(order.orderId)).toMatchObject({
      state: 'ended-unpaid',
      endedBy: 'over',
    });
    // A press now: the old-prompt question before any wallet request.
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt' });
    expect(run.wallet.requests).toBe(1);
    run.session.cancelOldPrompt();
    // The old request approved after all: watched, and said so when idle.
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    // Watched: the product stays held until it is found.
    const requests = run.wallet.requests;
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(requests);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
  });
});

describe('Tempo: the probe past the late deadline (round 17)', () => {
  /** The working view's fields, when the last view is the signing step. */
  function signingOf(view: View | undefined) {
    return view?.kind === 'working' && view.step === 'signing' ? view : undefined;
  }

  it('the chain clock lags: the drawn countdown stays at the deadline, and says taking long after it (MED-1)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    const deadline = deadlineOf(order);
    // The device clock is past the deadline; the chain's newest block is not, so
    // the verifier cannot prove the request over (`not_yet_due`).
    run.advance(deadline - run.now() + 5);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(signingOf(run.last())?.startOverIn).toEqual({ seconds: 0, at: deadline });
    const drawn = run.views.length;
    for (const step of [5, 60, 120, 300]) {
      run.advance(step);
      await run.timers.tick(WATCH_EVERY_MS);
    }
    // Nothing moved: no redraw, so the hint is never reset to "checking".
    expect(run.views).toHaveLength(drawn);
    run.advance(deadline + UNSURE_AFTER_SECS - run.now());
    await run.timers.tick(WATCH_EVERY_MS);
    const shown = signingOf(run.last());
    expect(shown?.startOverIn).toEqual({ seconds: 0, at: deadline });
    expect(isTakingLong(run.now(), shown?.startOverIn, shown?.unsureAt)).toBe(true);
    expect(internals(run.session).busy).toBe(true);
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
  });

  it('a payment the payout’s policy blocked, the wallet still silent: the press ends on `blocked` (LOW-2)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    const request = JSON.parse(order.paymentRequest ?? '{}') as { memo: string };
    run.pastDeadline(order);
    run.blockedLeg(request.memo);
    run.advance(deadlineOf(order) - run.now() + 10);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'blocked' });
    expect(internals(run.session).busy).toBe(false);
    expect((await store.get(order.orderId))?.state).toBe('blocked');
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'blocked' });
  });
});

describe('Tempo: the load', () => {
  it('L-b the first view and "ready" come before the Tempo chain is read (M44)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    run.session.dispose();
    const hung = { request: () => new Promise<never>(() => undefined) };
    const statuses: CheckoutState[] = [];
    const views: View[] = [];
    const again = new CheckoutSession(run.offer, {
      ...run.deps,
      tempoFor: () => hung,
      onStatus: (state) => statuses.push(state),
      onView: (view) => views.push(view),
    });
    void again.start();
    await settle();
    expect(statuses).toEqual(['ready']);
    expect(views.at(-1)).toMatchObject({ kind: 'offer' });
  });
});

describe('Tempo: banners and the late hash after a close', () => {
  it('R-p a close clears the banner; a refused close does not (M76)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile';
    await run.session.start();
    await run.session.pay('MetaMask');
    await run.timers.tick();
    expect(run.banners).toEqual([expect.objectContaining({ state: 'paid' })]);
    expect(run.session.resetOnClose()).toBe(true);
    expect(run.banners).toEqual([expect.objectContaining({ state: 'paid' }), undefined]);
    run.session.dispose();
    expect(run.session.resetOnClose()).toBe(false);
    expect(run.banners).toHaveLength(2);
  });

  it('R-l a quiet late hash at the press: the earlier-payment line, not the old banner text (M77)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile-unseen';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    expect(run.session.resetOnClose()).toBe(true);
    run.wallet.behaviour = 'land';
    const requests = run.wallet.requests;
    await run.session.pay('MetaMask');
    expect(lineOf(run.last())).toEqual({ reason: 'earlier_payment', phase: 'confirming' });
    // Its stored order ended long ago: the line stays while the hash is not found (round 8).
    await settle();
    expect(lineOf(run.last())).toEqual({ reason: 'earlier_payment', phase: 'confirming' });
    expect(run.wallet.requests).toBe(requests);
  });
});

describe('Tempo: a late hash of the order continued at load (round 12)', () => {
  it('the continued order is not quiet: its late approval holds with its own line, then its banner', async () => {
    const first = await setup();
    // A wallet on the wrong chain: the order is created, never paid.
    first.wallet.chainId = async () => 1;
    await first.session.start();
    await first.session.pay('MetaMask');
    const order = await only(first);
    expect(order.state).toBe('ordered');
    expect(first.wallet.requests).toBe(0);
    first.session.dispose();
    first.wallet.chainId = async () => 42431;
    // The reload: the open order is continued silently in the open modal.
    const run = { ...first, session: new CheckoutSession(first.offer, first.deps) };
    await run.session.start();
    expect(internals(run.session).silent).toBe(order.orderId);
    // The buyer pays it; another tab ends it while the wallet is open; the buyer approves.
    run.wallet.behaviour = 'ended-meanwhile-unseen';
    await run.session.pay('MetaMask');
    expect((await only(run)).orderId).toBe(order.orderId);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    // A second press while the hash is not found: the late-approval line, not the earlier-payment one.
    const requests = run.wallet.requests;
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(requests);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    expect(lineOf(run.last())).toBeUndefined();
    // The hash lands: the watch finds it paid and shows its banner.
    run.land(order.reference);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(order.orderId))?.state).toBe('paid');
    expect(run.banners).toEqual([
      expect.objectContaining({ orderId: order.orderId, state: 'paid' }),
    ]);
  });
});

describe('Tempo: a late hash replaced while its check runs (deepsec)', () => {
  it('the replaced check, found paid, never stops the later watch: it keeps polling and holding presses', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile-unseen';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    const first = await only(run);
    const watcher = run.session as unknown as {
      lateHash: { orderId: string; hash: string; timer: unknown } | undefined;
      watchLateHash(record: OrderRecord, hash: string): void;
    };
    const firstEntry = watcher.lateHash;
    if (firstEntry === undefined) {
      throw new Error('the first hash is not watched');
    }
    // The first watch's check is held at its read of the order.
    const read = run.spy.hold('get', (args) => args[0] === first.orderId);
    run.timers.running.get(firstEntry.timer as number)?.handler();
    await read.reached;
    // A second ended order's approval replaces the watch meanwhile (its hash not seen yet).
    const second: OrderRecord = {
      ...first,
      orderId: 'f'.repeat(64),
      reference: `0x${'77'.repeat(32)}`,
      createdAt: first.createdAt + 1,
    };
    await backend.transactProduct(first.productAddress, () => ({
      write: [second],
      result: undefined,
    }));
    watcher.watchLateHash(second, `0x${'ee'.repeat(32)}`);
    await settle();
    const secondEntry = watcher.lateHash;
    expect(secondEntry?.orderId).toBe(second.orderId);
    // The replaced watch no longer polls.
    expect(run.timers.running.has(firstEntry.timer as number)).toBe(false);
    // The first hash lands: its held check finds it paid.
    run.land(first.reference);
    read.release();
    await settle(60);
    expect((await store.get(first.orderId))?.state).toBe('paid');
    expect(run.banners).toEqual([
      expect.objectContaining({ orderId: first.orderId, state: 'paid' }),
    ]);
    expect(watcher.lateHash).toBe(secondEntry);
    expect(run.timers.running.has(secondEntry?.timer as number)).toBe(true);
    // Its payment is still unfound: a press stays held, no wallet request.
    const requests = run.wallet.requests;
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(requests);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
  });

  it('the replaced check resolving after a close shows no banner (round 11)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile-unseen';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    const first = await only(run);
    const watcher = run.session as unknown as {
      lateHash: { orderId: string; hash: string; timer: unknown } | undefined;
      watchLateHash(record: OrderRecord, hash: string): void;
    };
    const firstEntry = watcher.lateHash;
    if (firstEntry === undefined) {
      throw new Error('the first hash is not watched');
    }
    const read = run.spy.hold('get', (args) => args[0] === first.orderId);
    run.timers.running.get(firstEntry.timer as number)?.handler();
    await read.reached;
    const second: OrderRecord = {
      ...first,
      orderId: 'f'.repeat(64),
      reference: `0x${'77'.repeat(32)}`,
      createdAt: first.createdAt + 1,
    };
    await backend.transactProduct(first.productAddress, () => ({
      write: [second],
      result: undefined,
    }));
    watcher.watchLateHash(second, `0x${'ee'.repeat(32)}`);
    await settle();
    expect(watcher.lateHash?.orderId).toBe(second.orderId);
    // The store's answer to the first order is heard meanwhile: its banner, and no longer followed.
    await run.completed(first);
    expect((await store.get(first.orderId))?.state).toBe('completed');
    expect(run.banners).toEqual([
      expect.objectContaining({ orderId: first.orderId, state: 'completed' }),
    ]);
    // The modal closes while the replaced check is still held.
    expect(run.session.resetOnClose()).toBe(true);
    const shown = run.banners.length;
    read.release();
    await settle(60);
    // Its outcome is stored, never shown after the close.
    expect(run.banners.slice(shown)).toEqual([]);
  });
});

describe('Tempo: the old-prompt question after a close', () => {
  async function asked(run: Run) {
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    const [paying] = await records(run);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt' });
  }

  for (const at of ['read', 'write'] as const) {
    it(`a confirmation paused at its ${at}, then a close: nothing is paid (M25)`, async () => {
      const run = await setup();
      await asked(run);
      const requests = run.wallet.requests;
      const pause = at === 'read' ? run.spy.hold('get') : run.spy.hold('update');
      const confirming = run.session.confirmOldPrompt();
      await pause.reached;
      expect(run.session.resetOnClose()).toBe(true);
      const later = after(run);
      pause.release();
      await confirming;
      await settle();
      expect(run.wallet.requests).toBe(requests);
      expect(later.views()).toEqual([]);
    });
  }

  it('the question’s own read, then a close: no question on the first step (M22, Rev 22 b)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    const [paying] = await records(run);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    run.wallet.behaviour = 'land';
    // The press reads the product's orders three times before asking: D5, D5c, the question.
    const read = run.spy.holdNth('forProduct', 3);
    const pressed = run.session.pay('MetaMask');
    await read.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    read.release();
    await pressed;
    expect(later.views()).toEqual([]);
  });
});

describe('Tempo: the earlier-payment line (round 7)', () => {
  const hashWrite = (method: string, args: unknown[]) =>
    method === 'updateMarker' &&
    typeof args[3] === 'object' &&
    args[3] !== null &&
    'txHash' in args[3];

  it('a line, then the old-prompt question: a redraw never brings the line back (LOW 1)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('MetaMask');
    expect(lineOf(run.last())?.phase).toBe('tempo_request');
    // At 0:00 the buyer presses again: the holder is proven over and ended, and the
    // new order's marker answers with the old-prompt question.
    run.pastDeadline(order);
    run.advance(deadlineOf(order) - (NOW + 30) + 10);
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt', orders: 1 });
    expect(await store.get(order.orderId)).toMatchObject({ state: 'ended-unpaid' });
    // A wallet announces itself later: the screen is drawn again, with no line.
    const later = after(run);
    run.session.refresh();
    expect(later.views()).not.toHaveLength(0);
    expect(later.views().filter((view) => lineOf(view) !== undefined)).toEqual([]);
    expect(run.wallet.requests).toBe(1);
    void held;
  });

  it('a holder the store records blocked: its line clears by itself (A13)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('MetaMask');
    expect(lineOf(run.last())?.phase).toBe('tempo_request');
    const order = await only(run);
    const blocked = await store.update(order.orderId, order.version, { state: 'blocked' });
    expect(blocked.ok).toBe(true);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    expect(internals(run.session).followers.get(order.orderId)?.timer).toBeUndefined();
    void held;
  });

  it('a hash approved but never stored: the line says it is being confirmed, not a request open (B7)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    expect(run.session.resetOnClose()).toBe(true);
    // Every hash write is lost, the press's own pass included: only the session knows it.
    run.spy.refuseWrites(hashWrite);
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    await run.session.pay('MetaMask');
    run.spy.refuseWrites(undefined);
    const order = await only(run);
    expect(order.marker?.rail === 'tempo' ? order.marker.txHash : 'none').toBeUndefined();
    expect(lineOf(run.last())).toEqual({ reason: 'earlier_payment', phase: 'confirming' });
    expect(run.wallet.requests).toBe(1);
  });
});

describe('Tempo: the earlier-payment line (round 8)', () => {
  it('a bundle approved with no hash yet: the line says it is being confirmed, not a request open (P8)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    expect(run.session.resetOnClose()).toBe(true);
    // Another tab's wallet approved the call as a bundle (`wallet_sendCalls`): its hash comes later.
    const order = await only(run);
    if (order.marker?.rail !== 'tempo') {
      throw new Error('a Tempo attempt');
    }
    const approved: OrderRecord = {
      ...order,
      version: order.version + 1,
      marker: { ...order.marker, bundleId: 'bundle-1' },
    };
    await backend.transactProduct(order.productAddress, () => ({
      write: [approved],
      result: undefined,
    }));
    await run.session.pay('MetaMask');
    // No wallet here can be asked about another tab's bundle without a connection:
    // the line offers "Check in wallet" beside it.
    expect(lineOf(run.last())).toEqual({
      reason: 'earlier_payment',
      phase: 'confirming',
      checkWallet: true,
    });
    expect(run.wallet.requests).toBe(1);
    void held;
  });
});

describe('Tempo: a late approval while the old-prompt question is up (round 13)', () => {
  it('the old request approved under the question: the question stays, no late-approval note over it (K9)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await requestHeld(run);
    const order = await only(run);
    await run.timers.tick(WATCH_EVERY_MS);
    run.pastDeadline(order);
    run.advance(deadlineOf(order) - (NOW + 30) + 10);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'attempt_over' } });
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt' });
    const requests = run.wallet.requests;
    const later = after(run);
    run.wallet.behaviour = 'drop';
    held.answer();
    await held.pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'old_prompt' });
    expect(later.views().some((view) => view.kind === 'offer')).toBe(false);
    expect(run.wallet.requests).toBe(requests);
  });
});

describe('Tempo: a press after a close while the detached press places its order', () => {
  it('the press waits for that placement and pays that order: never two open orders', async () => {
    const run = await setup();
    await run.session.start();
    const held = run.spy.hold('add');
    const first = run.session.pay('MetaMask');
    await held.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const second = run.session.pay('MetaMask');
    await settle();
    held.release();
    await Promise.all([first, second]);
    await settle();
    const all = await records(run);
    expect(all).toHaveLength(1);
    expect(all[0]?.marker?.rail === 'tempo' ? all[0].marker.txHash : undefined).toBe(HASH);
    expect(run.wallet.requests).toBe(1);
  });
});
