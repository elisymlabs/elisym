/**
 * Closing the modal resets it, never a double spend (commerce-modal-reset.md):
 * the view-only reset (D1), the load (D1c), the detached press (D3), the press
 * after a close (D5, D5c), the background follower (D5b), on Solana.
 */
import { type OrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import {
  type LoadedOffer,
  type OrderRecord,
  OrderStore,
  RELAY_PUBLISH_DEADLINE_MS,
  RELAY_QUERY_DEADLINE_MS,
  endOrder,
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
import { FakeSolana, FakeWallet } from '../../commerce/tests/buyer/solana-fixtures';
import {
  type Banner,
  CheckoutSession,
  PLACING_WAIT_MS,
  REPUBLISH_EVERY_MS,
  type SessionDeps,
  type View,
  WATCH_EVERY_MS,
} from '../src/app/session';
import { isTakingLong } from '../src/app/ui/UnansweredHint';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import type { CheckoutState } from '../src/embed/protocol';
import { gate, holdRpc, internals, settle, spyStore } from './reset-harness';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;
let backend: IndexedDbOrderBackend;

beforeEach(async () => {
  backend = new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory()));
  store = new OrderStore(backend);
});

/** Intervals the test runs by hand, with the period each was set for. */
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
  /** Run every timer of period `ms` (all timers when not given) once. */
  async tick(ms?: number): Promise<void> {
    for (const timer of [...this.running.values()]) {
      if (ms === undefined || timer.ms === ms) {
        timer.handler();
      }
    }
    await settle();
  }
  count(ms: number): number {
    return [...this.running.values()].filter((timer) => timer.ms === ms).length;
  }
}

async function loaded(shop: Shop, relays: MemoryRelays, now = NOW): Promise<Ready> {
  const offer = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['solana'],
    now,
  });
  if (!offer.ok) {
    throw new Error(offer.message);
  }
  return offer;
}

async function setup(options: { shop?: Shop; transform?: (offer: Ready) => Ready } = {}) {
  const shop = options.shop ?? makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const transform = options.transform ?? ((offer: Ready) => offer);
  const offer = transform(await loaded(shop, relays));
  const wallet = await FakeWallet.create();
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.blockTime = NOW + 60;
  const timers = new Timers();
  const views: View[] = [];
  const statuses: CheckoutState[] = [];
  const banners: (Banner | undefined)[] = [];
  const spy = spyStore(store);
  let clock = NOW + 30;
  let connects = 0;
  const deps: SessionDeps = {
    store: spy.store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => chain.rpc,
    wallets: () => [
      {
        name: 'Fake',
        connect: async () => {
          connects += 1;
          return wallet;
        },
      },
    ],
    reloadOffer: async () => transform(await loaded(shop, relays, clock)),
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
  const session = new CheckoutSession(offer, deps);
  return {
    shop,
    relays,
    offer,
    wallet,
    chain,
    timers,
    views,
    statuses,
    banners,
    spy,
    deps,
    session,
    connects: () => connects,
    advance: (seconds: number) => {
      clock += seconds;
    },
    now: () => clock,
    last: () => views.at(-1),
  };
}

type Run = Awaited<ReturnType<typeof setup>>;

/** The store's status for `record`, published to the relays the widget listens on. */
async function storeSays(run: Run, record: OrderRecord, message: Partial<OrderMessage> = {}) {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course' },
    ...message,
  } as OrderMessage;
  await run.relays.publish(
    INBOX,
    wrapOrderMessage(
      buildOrderMessage(status, NOW + 100),
      run.shop.store.secretKey,
      record.buyerPubkey,
    ).recipientWrap,
  );
  await settle();
}

const CANCEL: Partial<OrderMessage> = { status: 'cancelled', delivery: undefined };
const REFUND = {
  status: 'cancelled',
  delivery: undefined,
  refund: { tx: '6'.repeat(88), amount: '49000000' },
} as Partial<OrderMessage>;

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

/** A fresh session on the same page (a reload), its views and statuses recorded apart. */
function reload(run: Run, extra: Partial<SessionDeps> = {}) {
  const views: View[] = [];
  const statuses: CheckoutState[] = [];
  const session = new CheckoutSession(run.offer, {
    ...run.deps,
    onView: (view) => views.push(view),
    onStatus: (state) => statuses.push(state),
    ...extra,
  });
  return { session, views, statuses, last: () => views.at(-1) };
}

/** What a close leaves: true, the plain offer, "ready" last, nothing written or sent at once. */
function closes(run: Run): void {
  const writes = run.spy.writes.length;
  const published = run.relays.published.length;
  const requests = run.wallet.requests;
  expect(run.session.resetOnClose()).toBe(true);
  expect(run.spy.writes).toHaveLength(writes);
  expect(run.relays.published).toHaveLength(published);
  expect(run.wallet.requests).toBe(requests);
  const shown = run.last();
  expect(shown).toMatchObject({ kind: 'offer' });
  expect(shown?.kind === 'offer' ? shown.problem : 'none').toBeUndefined();
  expect(run.statuses.at(-1)).toBe('ready');
}

/** A press made while the wallet's signature is held: resolves once the wallet was asked. */
async function signingHeld(run: Run) {
  const prompt = gate();
  const asked = gate();
  run.wallet.duringPrompt = async () => {
    asked.open();
    await prompt.promise;
  };
  const pressed = run.session.pay('Fake');
  await asked.promise;
  await settle();
  return { pressed, answer: prompt.open };
}

/** The views and statuses drawn after this point. */
function after(run: Run) {
  const views = run.views.length;
  const statuses = run.statuses.length;
  return {
    views: () => run.views.slice(views),
    statuses: () => run.statuses.slice(statuses),
  };
}

describe('R-a: a close resets every state, writing nothing', () => {
  it('an offer with a problem: the open order is kept, silent, with its listener (M48, M54, M84)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'insufficient_token' } });
    expect(run.statuses.at(-1)).toBe('ordered');
    const open = await only(run);
    closes(run);
    const state = internals(run.session);
    expect(state.record?.orderId).toBe(open.orderId);
    expect(state.silent).toBe(open.orderId);
    expect(state.listening?.orderId).toBe(open.orderId);
    // A store cancel arriving after the close is stored through the kept listener:
    // nothing drawn, nothing told.
    const later = after(run);
    await storeSays(run, open, CANCEL);
    expect((await store.get(open.orderId))?.status?.status).toBe('cancelled');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect(internals(run.session).record).toBeUndefined();
  });

  it('the wallet connect pending: detached, no wallet, no order (M24)', async () => {
    const run = await setup();
    await run.session.start();
    const connected = gate();
    const reached = gate();
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: async () => {
          reached.open();
          await connected.promise;
          return run.wallet;
        },
      },
    ];
    const pressed = run.session.pay('Fake');
    await reached.promise;
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    closes(run);
    const later = after(run);
    connected.open();
    await pressed;
    await settle();
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect(run.wallet.requests).toBe(0);
    expect(await records(run)).toEqual([]);
  });

  it('signing: the marked order goes on in the background, never shown again (R-e, M12, M17, M50)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const marked = await only(run);
    expect(marked.marker).toBeDefined();
    closes(run);
    const state = internals(run.session);
    expect(state.record).toBeUndefined();
    expect(state.listening).toBeUndefined();
    expect(state.quiet.has(marked.orderId)).toBe(true);
    expect(state.followers.has(marked.orderId)).toBe(true);
    const later = after(run);
    held.answer();
    await held.pressed;
    await settle();
    // Signed, written and broadcast by the detached press: drawn nowhere.
    expect((await store.get(marked.orderId))?.marker).toMatchObject({
      signature: expect.any(String),
    });
    expect(later.views()).toEqual([]);
    // The background follower records the payment, then the store's completion.
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(marked.orderId))?.state).toBe('paid');
    await storeSays(run, marked);
    expect((await store.get(marked.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    const purchases = await run.session.purchases();
    expect(purchases.map((purchase) => purchase.status)).toEqual(['delivered']);
    expect(run.wallet.requests).toBe(1);
  });

  it('waiting for the payment to confirm: followed in the background', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false });
    const paying = await only(run);
    closes(run);
    expect(internals(run.session).followers.has(paying.orderId)).toBe(true);
    // The follower's rail tick keeps going; the screen stays on the first step.
    const later = after(run);
    run.chain.dropSends = false;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(paying.orderId))?.state).toBe('paid');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('a retry on screen: followed; the follower ends the attempt only after proving it again (M1, M16, M27, M47)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const over = await only(run);
    const writes = run.spy.writes.length;
    closes(run);
    // Microtasks only: nothing is written by the close or by the follower's start.
    await settle();
    expect(run.spy.writes.slice(writes)).toEqual([]);
    // One interval: a pass proves it over, `endOrder` proves it again, one clear.
    const listings = () =>
      run.chain.calls.filter((call) => call === 'getSignaturesForAddress').length;
    const before = listings();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.spy.succeeded('clearMarker')).toHaveLength(1);
    expect(listings() - before).toBe(2);
    expect((await store.get(over.orderId))?.state).toBe('ended-unpaid');
    expect(internals(run.session).followers.has(over.orderId)).toBe(false);
    // The rail tick stopped: no more chain calls; its store answer is still heard.
    const calls = run.chain.calls.length;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.chain.calls).toHaveLength(calls);
    expect(internals(run.session).background.has(over.orderId)).toBe(true);
    expect(internals(run.session).followers.has(over.orderId)).toBe(false);
  });

  /** A retry on screen, closed: the follower's next pass proves the attempt over. */
  async function closedOnRetry(run: Run): Promise<OrderRecord> {
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const over = await only(run);
    closes(run);
    await settle();
    return over;
  }

  it('a follower whose end is lost (a lost clear) keeps following, and ends it on the next pass (round 5 LOW-1)', async () => {
    const run = await setup();
    const over = await closedOnRetry(run);
    run.spy.refuseWrites((method) => method === 'clearMarker');
    await run.timers.tick(WATCH_EVERY_MS);
    run.spy.refuseWrites(undefined);
    expect(run.spy.writes.filter((write) => write.method === 'clearMarker')).toHaveLength(1);
    expect((await store.get(over.orderId))?.state).toBe('paying');
    expect(internals(run.session).followers.has(over.orderId)).toBe(true);
    expect(internals(run.session).quiet.has(over.orderId)).toBe(true);
    // Still republished as a live order.
    const published = run.relays.published.length;
    await run.timers.tick(REPUBLISH_EVERY_MS);
    expect(run.relays.published.length).toBeGreaterThan(published);
    // The next pass proves it over again and ends it.
    const later = after(run);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.spy.succeeded('clearMarker')).toHaveLength(1);
    expect((await store.get(over.orderId))?.state).toBe('ended-unpaid');
    expect(internals(run.session).followers.has(over.orderId)).toBe(false);
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('a follower whose end finds a payment between the proofs keeps following it to the store’s answer (round 5 LOW-1)', async () => {
    const run = await setup();
    const over = await closedOnRetry(run);
    // The pass proves it over; another device's payment lands before the end's own proof.
    let listings = 0;
    run.chain.onList = async () => {
      listings += 1;
      if (listings === 2) {
        await run.chain.injectPayment(JSON.parse(over.paymentRequest ?? '{}'));
      }
    };
    await run.timers.tick(WATCH_EVERY_MS);
    run.chain.onList = undefined;
    expect(listings).toBe(2);
    expect(run.spy.writes.filter((write) => write.method === 'clearMarker')).toEqual([]);
    expect((await store.get(over.orderId))?.paidTx).toBeDefined();
    expect(internals(run.session).followers.has(over.orderId)).toBe(true);
    const published = run.relays.published.length;
    await run.timers.tick(REPUBLISH_EVERY_MS);
    expect(run.relays.published.length).toBeGreaterThan(published);
    const later = after(run);
    await storeSays(run, over);
    expect((await store.get(over.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('waiting for the store: republished in the background, its relay move followed (R-k, M26)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    const paid = await only(run);
    closes(run);
    await settle();
    const publishes = () =>
      run.relays.published.filter((each) => each.event.id === paid.orderWrap?.id).length;
    const first = publishes();
    expect(first).toBeGreaterThan(0);
    // The store reads elsewhere now: the next republish moves there, and its answer is heard.
    const moved = ['wss://moved.example.com'];
    run.relays.publish(INBOX, inboxList(run.shop.store, moved, NOW + 5));
    await run.timers.tick(REPUBLISH_EVERY_MS);
    expect(publishes()).toBeGreaterThan(first);
    const later = after(run);
    const status = {
      type: 'status',
      buyerPubkey: paid.buyerPubkey,
      orderId: paid.orderId,
      status: 'completed',
    } as OrderMessage;
    await run.relays.publish(
      moved,
      wrapOrderMessage(
        buildOrderMessage(status, NOW + 100),
        run.shop.store.secretKey,
        paid.buyerPubkey,
      ).recipientWrap,
    );
    await settle();
    expect((await store.get(paid.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  for (const [name, message, kind] of [
    ['delivered', {}, 'delivered'],
    ['refunded', REFUND, 'refunded'],
  ] as const) {
    it(`a finished order (${name}): the first step, nothing followed`, async () => {
      const run = await setup();
      await run.session.start();
      await run.session.pay('Fake');
      await run.timers.tick();
      await storeSays(run, await only(run), message);
      expect(run.last()).toMatchObject({ kind });
      closes(run);
      expect(internals(run.session).record).toBeUndefined();
      expect(internals(run.session).followers.size).toBe(0);
      // A press after it places a new order beside the finished one.
      await run.session.pay('Fake');
      expect(await records(run)).toHaveLength(2);
    });
  }

  it('a blocked payment: followed (listener, republish), its refund stored, no rail calls (R-m, M39)', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    const paying = await only(run);
    await backend.transactProduct(paying.productAddress, () => ({
      write: [{ ...paying, version: paying.version + 1, state: 'blocked' }],
      result: undefined,
    }));
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'blocked' });
    closes(run);
    const follower = internals(run.session).followers.get(paying.orderId);
    expect(follower?.republish).toBeDefined();
    expect(follower?.timer).toBeUndefined();
    const calls = run.chain.calls.length;
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.chain.calls).toHaveLength(calls);
    const later = after(run);
    await storeSays(run, paying, REFUND);
    expect((await store.get(paying.orderId))?.state).toBe('refunded');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect((await run.session.purchases()).map((purchase) => purchase.status)).toEqual([
      'refunded',
    ]);
  });

  it('an unpaid order the store cancelled: the first step, the order dropped', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    await run.session.start();
    await run.session.pay('Fake');
    await storeSays(run, await only(run), CANCEL);
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
    closes(run);
    expect(internals(run.session).record).toBeUndefined();
  });
});

describe('R-b: what a close refuses', () => {
  it('a page that only follows an order: false, nothing changes', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    const followed = reload(run, {
      followOnly: {
        reason: 'offer_refused',
        message: 'Withdrawn.',
        orderId: (await only(run)).orderId,
      },
    });
    await followed.session.start();
    const views = followed.views.length;
    expect(followed.session.resetOnClose()).toBe(false);
    expect(followed.views).toHaveLength(views);
  });

  it('a refused page: false', async () => {
    const run = await setup();
    run.deps.rpcFor = () => undefined;
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'refused' });
    expect(run.session.resetOnClose()).toBe(false);
    expect(run.statuses).toEqual(['refused']);
  });

  it('a page refused by the press’s re-verification: false, no view, no status', async () => {
    const run = await setup();
    await run.session.start();
    run.advance(600);
    run.deps.reloadOffer = async () => ({
      ok: false,
      refusal: 'product_not_on_sale',
      message: 'The listing is hidden',
    });
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'refused', reason: 'sold_out' });
    expect(run.statuses.at(-1)).toBe('refused');
    const later = after(run);
    const writes = run.spy.writes.length;
    expect(run.session.resetOnClose()).toBe(false);
    await settle();
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect(run.spy.writes).toHaveLength(writes);
    expect(run.last()).toMatchObject({ kind: 'refused' });
  });

  it('after the session ended: false', async () => {
    const run = await setup();
    await run.session.start();
    run.session.dispose();
    expect(run.session.resetOnClose()).toBe(false);
  });

  it('before the first view: false, and the page then hears only "refused" (M83)', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    // A page refusing to sell, with an order to follow: its session is created first.
    const read = run.spy.hold('forProduct');
    const statuses: CheckoutState[] = [];
    const followed = new CheckoutSession(run.offer, {
      ...run.deps,
      onStatus: (state) => statuses.push(state),
      rpcFor: (network) => (network === 'devnet' ? undefined : run.chain.rpc),
    });
    const started = followed.start();
    await read.reached;
    expect(followed.resetOnClose()).toBe(false);
    read.release();
    await started;
    expect(statuses).toEqual(['refused']);
  });

  it('the fresh offer: true, nothing drawn, nothing posted', async () => {
    const run = await setup();
    await run.session.start();
    const views = run.views.length;
    expect(run.session.resetOnClose()).toBe(true);
    expect(run.views).toHaveLength(views);
    expect(run.statuses).toEqual(['ready']);
  });

  it('the offer after "ordered" and a cancelled press: "ready" is posted (M57)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const connected = gate();
    run.deps.wallets = () => [
      { name: 'Fake', connect: async () => connected.promise.then(() => run.wallet) },
    ];
    const pressed = run.session.pay('Fake');
    await settle();
    run.session.cancel();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(run.statuses.at(-1)).toBe('ordered');
    expect(run.session.resetOnClose()).toBe(true);
    expect(run.statuses.at(-1)).toBe('ready');
    connected.open();
    await pressed;
  });
});

/** The line on the offer, if it is the earlier-payment one. */
function lineOf(view: View | undefined) {
  return view?.kind === 'offer' && view.problem?.reason === 'earlier_payment'
    ? view.problem
    : undefined;
}

/** A payment out that does not land yet, then the modal closed. */
async function closedWhilePaying(run: Run): Promise<OrderRecord> {
  run.chain.dropSends = true;
  await run.session.start();
  await run.session.pay('Fake');
  expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
  const paying = await only(run);
  expect(run.session.resetOnClose()).toBe(true);
  return paying;
}

describe('R-c: a press while an earlier payment may still land', () => {
  it('asks the wallet nothing and counts down from the holder’s own attempt (M3, M4, M6)', async () => {
    const run = await setup();
    const paying = await closedWhilePaying(run);
    const connects = run.connects();
    await run.session.pay('Fake');
    expect(run.connects()).toBe(connects);
    expect(run.wallet.requests).toBe(1);
    expect(await records(run)).toHaveLength(1);
    const marker = paying.marker;
    if (marker?.rail !== 'solana') {
      throw new Error('a Solana attempt');
    }
    const blocks = BigInt(marker.lastValidBlockHeight) + 32n - run.chain.height;
    expect(lineOf(run.last())).toEqual({
      reason: 'earlier_payment',
      phase: 'confirming',
      retryIn: { seconds: Math.ceil(Number(blocks) * 0.4), at: run.now() },
    });
  });

  it('holds the press while it checks: a redraw never covers it (M23)', async () => {
    const run = await setup();
    await closedWhilePaying(run);
    const read = run.spy.hold('forProduct');
    const pressed = run.session.pay('Fake');
    await read.reached;
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    run.session.refresh();
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    read.release();
    await pressed;
    expect(lineOf(run.last())?.phase).toBe('confirming');
  });

  it('the line clears by itself once the holder it found is paid and answered (M41)', async () => {
    const run = await setup();
    await run.session.start();
    // Another tab pays meanwhile, and its payment does not land yet.
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    run.chain.dropSends = false;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    const holder = await only(run);
    expect(holder.state).toBe('paid');
    await storeSays(run, holder);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
  });

  it('paid and waiting for the store: its line, with no countdown', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('Fake');
    expect(lineOf(run.last())).toEqual({ reason: 'earlier_payment', phase: 'waiting_store' });
    expect(run.wallet.requests).toBe(1);
  });

  it('paid, and cancelled by the store without a refund: said so (M75)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    await storeSays(run, await only(run), CANCEL);
    expect(run.last()).toMatchObject({ kind: 'waiting_store', cancelled: true });
    expect(run.session.resetOnClose()).toBe(true);
    await run.session.pay('Fake');
    expect(lineOf(run.last())).toEqual({
      reason: 'earlier_payment',
      phase: 'waiting_store',
      cancelled: true,
    });
    expect(run.wallet.requests).toBe(1);
  });

  it('a holder that cannot be proven over (a short ledger): "in a moment", never anything else (M42)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.firstAvailableBlock = 10n ** 12n;
    run.advance(11 * 60);
    expect(run.session.resetOnClose()).toBe(true);
    run.wallet.behaviour = 'sign';
    await run.session.pay('Fake');
    expect(lineOf(run.last())).toEqual({
      reason: 'earlier_payment',
      phase: 'confirming',
      retryIn: { seconds: 0, at: run.now() },
    });
    expect(run.wallet.requests).toBe(1);
  });

  it('a holder on a network with no RPC here: no verdict, still its line (M42)', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    const paying = await only(run);
    run.session.dispose();
    // The same order, as if paid on a network this widget does not read.
    const elsewhere: OrderRecord = {
      ...paying,
      payout: {
        ...paying.payout,
        caip19: paying.payout.caip19.replace(
          /^solana:[^/]+/,
          'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        ),
      },
    };
    await backend.transactProduct(paying.productAddress, () => ({
      write: [elsewhere],
      result: undefined,
    }));
    const again = reload(run, {
      rpcFor: (network) => (network === 'devnet' ? run.chain.rpc : undefined),
    });
    await again.session.start();
    const connects = run.connects();
    await again.session.pay('Fake');
    expect(lineOf(again.last())).toEqual({ reason: 'earlier_payment', phase: 'confirming' });
    // Stopped at the check itself: not even a connect, and no second order.
    expect(run.connects()).toBe(connects);
    expect(await records(run)).toHaveLength(1);
    expect(run.wallet.requests).toBe(1);
  });
});

describe('R-d: a press once the earlier attempt provably ended', () => {
  it('ends it (proven again) and pays a new order: one connect, one wallet request', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const first = await only(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    expect(run.session.resetOnClose()).toBe(true);
    run.wallet.behaviour = 'sign';
    const connects = run.connects();
    const clears = run.spy.succeeded('clearMarker').length;
    await run.session.pay('Fake');
    expect(run.spy.succeeded('clearMarker')).toHaveLength(clears + 1);
    expect((await store.get(first.orderId))?.state).toBe('ended-unpaid');
    expect(run.connects()).toBe(connects + 1);
    expect(run.wallet.requests).toBe(2);
  });

  it('when the second proof fails: nothing new, its line', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    expect(run.session.resetOnClose()).toBe(true);
    // The pass proves it over; the chain is unreadable for the end's own proof.
    let listings = 0;
    run.chain.onList = async () => {
      listings += 1;
      if (listings === 1) {
        run.chain.failing = true;
      }
    };
    run.wallet.behaviour = 'sign';
    await run.session.pay('Fake');
    run.chain.failing = false;
    expect(await records(run)).toHaveLength(1);
    expect(run.wallet.requests).toBe(1);
    expect(lineOf(run.last())?.phase).toBe('confirming');
  });
});

describe('R-g: the store refuses the marker for an earlier payment of this account', () => {
  it('shows its line, never that order again (M4)', async () => {
    const run = await setup();
    await run.session.start();
    const connected = gate();
    const reached = gate();
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: async () => {
          reached.open();
          await connected.promise;
          return run.wallet;
        },
      },
    ];
    const pressed = run.session.pay('Fake');
    await reached.promise;
    // Another tab pays meanwhile, past this press's check.
    run.chain.dropSends = true;
    const other = reload(run, {
      wallets: () => [{ name: 'Fake', connect: async () => run.wallet }],
    });
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const requests = run.wallet.requests;
    connected.open();
    await pressed;
    expect(run.wallet.requests).toBe(requests);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(run.views.some((view) => view.kind === 'waiting_payment')).toBe(false);
  });

  it('follows that earlier payment: its line clears by itself once it is paid and answered', async () => {
    const run = await setup();
    await run.session.start();
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    // Another tab pays meanwhile, past this press's check, and its payment does not land yet.
    run.chain.dropSends = true;
    const other = reload(run, {
      wallets: () => [{ name: 'Fake', connect: async () => run.wallet }],
    });
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const holder = await only(run);
    expect(holder.marker).toBeDefined();
    const requests = run.wallet.requests;
    connect.release();
    await pressed;
    expect(run.wallet.requests).toBe(requests);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(internals(run.session).followers.has(holder.orderId)).toBe(true);
    run.chain.dropSends = false;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(holder.orderId))?.state).toBe('paid');
    await storeSays(run, holder);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    expect(run.wallet.requests).toBe(requests);
  });
});

/**
 * A press paused at one await, the modal closed there, then the await
 * resolved: nothing more is drawn or told, nothing is asked of the wallet,
 * and no attempt is started.
 */
async function detachedAt(
  run: Run,
  press: () => Promise<void>,
  pause: { reached: Promise<void>; release(): void },
) {
  const pressed = press();
  await pause.reached;
  const markers = run.spy.writes.length;
  const connects = run.connects();
  const requests = run.wallet.requests;
  expect(run.session.resetOnClose()).toBe(true);
  const later = after(run);
  pause.release();
  await pressed;
  await settle();
  expect(later.views()).toEqual([]);
  expect(later.statuses()).toEqual([]);
  expect(run.connects()).toBe(connects);
  expect(run.wallet.requests).toBe(requests);
  const started = run.spy.writes
    .slice(markers)
    .filter(
      (write) => (write.method === 'setMarker' || write.method === 'updateMarker') && write.ok,
    );
  expect(started).toEqual([]);
}

describe('R-a per-await: a press detached at each await never reaches the wallet (M22, M24, M45, M46)', () => {
  const pay = (run: Run) => () => run.session.pay('Fake');

  it('in the earlier-payment check', async () => {
    const run = await setup();
    await run.session.start();
    await detachedAt(run, pay(run), run.spy.hold('forProduct'));
  });

  it('in the offer’s re-verification', async () => {
    const run = await setup();
    await run.session.start();
    run.advance(600);
    const reloaded = gate();
    const reached = gate();
    const reload = run.deps.reloadOffer;
    run.deps.reloadOffer = async () => {
      reached.open();
      await reloaded.promise;
      // The store changed its price meanwhile: a press still current would show it.
      const fresh = await reload();
      return fresh.ok
        ? {
            ...fresh,
            payouts: fresh.payouts.map((payout) => ({ ...payout, amount: payout.amount + 1n })),
          }
        : fresh;
    };
    await detachedAt(run, pay(run), { reached: reached.promise, release: reloaded.open });
    expect(await records(run)).toEqual([]);
  });

  it('in the chain-time read', async () => {
    const run = await setup();
    await run.session.start();
    const read = gate();
    const reached = gate();
    run.deps.chainTime = async () => {
      reached.open();
      await read.promise;
      // Unreadable: a press still current would say so on the offer.
      throw new Error('node down');
    };
    await detachedAt(run, pay(run), { reached: reached.promise, release: read.open });
    expect(await records(run)).toEqual([]);
  });

  it('in the read of the open orders (D5c)', async () => {
    const run = await setup();
    await run.session.start();
    await detachedAt(run, pay(run), run.spy.holdNth('forProduct', 2));
    expect(await records(run)).toEqual([]);
  });

  it('in the read of the open orders (D5c), beside a second open order: nothing written (M22m)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const first = await only(run);
    await backend.transactProduct(first.productAddress, () => ({
      write: [{ ...first, orderId: 'e'.repeat(64), createdAt: first.createdAt - 5, version: 1 }],
      result: undefined,
    }));
    const read = run.spy.holdNth('forProduct', 2);
    const pressed = run.session.pay('Fake');
    await read.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const writes = run.spy.writes.length;
    read.release();
    await pressed;
    await settle();
    expect(run.spy.writes.slice(writes)).toEqual([]);
    expect((await store.get('e'.repeat(64)))?.state).toBe('ordered');
  });

  it('in the re-read of the order on screen', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    // D5's holder read, D5c's read, its re-check, then orderFor's own read of it.
    await detachedAt(
      run,
      pay(run),
      run.spy.holdNth('get', 1, (args) => args[0] === open.orderId),
    );
  });

  it('in the end of another open order (D5c)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const first = await only(run);
    // A second open order of this account, seeded beside the one on screen.
    await backend.transactProduct(first.productAddress, () => ({
      write: [{ ...first, orderId: 'e'.repeat(64), createdAt: first.createdAt - 5, version: 1 }],
      result: undefined,
    }));
    await detachedAt(
      run,
      pay(run),
      run.spy.hold('update', (args) => args[0] === 'e'.repeat(64)),
    );
  });

  it('in the placing of the order: no record shown, the placed order adopted by the next press', async () => {
    const run = await setup();
    await run.session.start();
    await detachedAt(run, pay(run), run.spy.hold('add'));
    const placed = await only(run);
    expect(internals(run.session).record).toBeUndefined();
    await run.session.pay('Fake');
    expect((await records(run)).map((record) => record.orderId)).toEqual([placed.orderId]);
    expect((await only(run)).marker).toBeDefined();
  });

  it('in the composing of the payment', async () => {
    const run = await setup();
    await run.session.start();
    await detachedAt(
      run,
      pay(run),
      run.spy.hold(
        'update',
        (args) => typeof args[2] === 'object' && args[2] !== null && 'paymentRequest' in args[2],
      ),
    );
  });

  for (const method of ['getBalance', 'getLatestBlockhash'] as const) {
    it(`inside the rail before its marker (${method})`, async () => {
      const run = await setup();
      await run.session.start();
      const held = holdRpc(run.chain.rpc, method);
      run.deps.rpcFor = () => held.rpc;
      await detachedAt(run, pay(run), held);
      expect((await only(run)).marker).toBeUndefined();
    });
  }

  it('in the store read after a failure (guard’s catch)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    // The compose write fails: the press ends in its catch, which reads the record.
    run.spy
      .hold(
        'update',
        (args) => typeof args[2] === 'object' && args[2] !== null && 'paymentRequest' in args[2],
        true,
      )
      .release();
    const failed = run.spy.holdNth('get', 3, (args) => args[0] === open.orderId);
    await detachedAt(run, pay(run), failed);
  });

  it('in a retry’s store read and its rail', async () => {
    for (const where of ['store', 'rail'] as const) {
      const run = await setup();
      run.wallet.behaviour = 'throw';
      await run.session.start();
      await run.session.pay('Fake');
      run.chain.expire();
      run.chain.nextBlockhash();
      await run.timers.tick();
      expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
      run.wallet.behaviour = 'sign';
      const open = await only(run);
      const held = holdRpc(run.chain.rpc, 'getLatestBlockhash');
      if (where === 'rail') {
        run.deps.rpcFor = () => held.rpc;
      }
      const pause =
        where === 'store' ? run.spy.hold('get', (args) => args[0] === open.orderId) : held;
      await detachedAt(run, () => run.session.retry('Fake'), pause);
      expect((await store.get(open.orderId))?.marker?.attemptId).toBe(open.marker?.attemptId);
    }
  });
});

describe('a decline after a close (D3, D5c)', () => {
  it('only the listener follows the open order; the next press pays it, adopted (M59, M61, M65)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect((await store.get(order.orderId))?.state).toBe('ordered');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    // Not republished: the foreground never republishes an acknowledged open order.
    expect(internals(run.session).followers.get(order.orderId)?.republish).toBeUndefined();
    expect(internals(run.session).followers.get(order.orderId)?.timer).toBeUndefined();
    const published = run.relays.published.length;
    await run.timers.tick(REPUBLISH_EVERY_MS);
    expect(run.relays.published).toHaveLength(published);
    // The next press pays the same order: no second order, one marker on it.
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    const markers = run.spy.writes.length;
    await run.session.pay('Fake');
    expect((await records(run)).map((record) => record.orderId)).toEqual([order.orderId]);
    expect(
      run.spy.writes
        .slice(markers)
        .filter((write) => write.method === 'setMarker' && write.ok === true)
        .map((write) => write.orderId),
    ).toEqual([order.orderId]);
    const state = internals(run.session);
    expect(state.listening?.orderId).toBe(order.orderId);
    expect(state.quiet.has(order.orderId)).toBe(false);
    expect(state.followers.has(order.orderId)).toBe(false);
  });

  it('a press already running when the decline lands pays that same order (M61, M62)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    // The next press, paused in its pass over the holder.
    const pass = holdRpc(run.chain.rpc, 'getEpochInfo');
    run.deps.rpcFor = () => pass.rpc;
    const second = run.session.pay('Fake');
    await pass.reached;
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    pass.release();
    await second;
    expect((await records(run)).map((record) => record.orderId)).toEqual([order.orderId]);
    expect((await only(run)).state).toBe('paying');
    expect(lineOf(run.last())).toBeUndefined();
    expect(run.wallet.requests).toBe(2);
  });
});

describe('a marker write in flight at the close (D3a latch)', () => {
  it('lands after the close: followed in the background, off the screen (M51)', async () => {
    const run = await setup();
    await run.session.start();
    const write = run.spy.hold('setMarker');
    const prompt = gate();
    run.wallet.duringPrompt = () => prompt.promise;
    const pressed = run.session.pay('Fake');
    await write.reached;
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    write.release();
    await settle();
    const state = internals(run.session);
    expect(state.followers.has(order.orderId)).toBe(true);
    expect(state.quiet.has(order.orderId)).toBe(true);
    expect(state.record).toBeUndefined();
    expect(state.listening).toBeUndefined();
    prompt.open();
    await pressed;
  });

  it('a press started before it lands meets the line, never a connect (M52)', async () => {
    const run = await setup();
    await run.session.start();
    const write = run.spy.hold('setMarker');
    const prompt = gate();
    run.wallet.duringPrompt = () => prompt.promise;
    const first = run.session.pay('Fake');
    await write.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const check = run.spy.hold('forProduct');
    const connects = run.connects();
    const second = run.session.pay('Fake');
    await check.reached;
    write.release();
    await settle();
    check.release();
    await second;
    expect(run.connects()).toBe(connects);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    prompt.open();
    await first;
  });
});

describe('round 16: what a close follows on, and a marker landing under a new press', () => {
  it('a close follows the order on the relays the store was last heard on, before any republish (R16-R4)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    const paid = await only(run);
    // The store reads elsewhere now: the foreground republish moves the session's relays.
    const moved = ['wss://moved.example.com'];
    await run.relays.publish(INBOX, inboxList(run.shop.store, moved, NOW + 5));
    await run.timers.tick(REPUBLISH_EVERY_MS);
    const heardOn = [...internals(run.session).relays];
    const shown = internals(run.session).record;
    if (shown === undefined) {
      throw new Error('no record on screen');
    }
    expect(heardOn).toContain('wss://moved.example.com');
    const onlySessionRelays = heardOn.filter((relay) => !shown.inboxRelays.includes(relay));
    expect(onlySessionRelays.length).toBeGreaterThan(0);
    // From now on every resume fails: no background republish can move the follower.
    const relays = run.relays;
    run.deps.clientFor = () =>
      new Proxy(relays, {
        get(target, property) {
          if (property === 'publish') {
            return async () => {
              throw new Error('relay down');
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    closes(run);
    await settle();
    expect(internals(run.session).followers.get(paid.orderId)?.relays).toEqual(heardOn);
    const later = after(run);
    const status = {
      type: 'status',
      buyerPubkey: paid.buyerPubkey,
      orderId: paid.orderId,
      status: 'completed',
    } as OrderMessage;
    await run.relays.publish(
      onlySessionRelays,
      wrapOrderMessage(
        buildOrderMessage(status, NOW + 100),
        run.shop.store.secretKey,
        paid.buyerPubkey,
      ).recipientWrap,
    );
    await settle();
    expect((await store.get(paid.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('a marker landing after the close leaves the record to the press running (R16-C8)', async () => {
    const run = await setup();
    await run.session.start();
    const write = run.spy.hold('setMarker');
    const prompt = gate();
    run.wallet.duringPrompt = () => prompt.promise;
    const first = run.session.pay('Fake');
    await write.reached;
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    // The new press passes its earlier-payment check (no marker yet) and waits for the connect.
    const connect = connectHeld(run);
    const second = run.session.pay('Fake');
    await connect.reached;
    expect(internals(run.session).pressing).toBe(true);
    write.release();
    await settle();
    // Landed under a running press: the record stays for that press to settle.
    expect(internals(run.session).record?.orderId).toBe(order.orderId);
    expect(internals(run.session).followers.has(order.orderId)).toBe(true);
    connect.release();
    await second;
    await settle();
    expect((await records(run)).map((record) => record.orderId)).toEqual([order.orderId]);
    expect(later.statuses()).not.toContain('ordered');
    expect(lineOf(run.last())).toBeDefined();
    prompt.open();
    await first;
  });
});

describe('a late answer after a probe verdict, the modal still open', () => {
  it('a late signature: the order stays on screen, re-drawn, never backgrounded (M58)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const later = after(run);
    held.answer();
    await held.pressed;
    await settle();
    const state = internals(run.session);
    expect(state.record?.orderId).toBe(order.orderId);
    expect(state.quiet.has(order.orderId)).toBe(false);
    expect(state.followers.has(order.orderId)).toBe(false);
    expect(later.views().at(-1)).toMatchObject({ kind: 'waiting_payment', canRetry: true });
  });

  it('a late decline: the retry screen gives way to the offer (M15)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect((await only(run)).state).toBe('ordered');
  });

  it('a late decline: a retry pressed afterwards never connects (Z09)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    const connects = run.connects();
    await run.session.retry('Fake');
    await settle();
    expect(run.connects()).toBe(connects);
  });

  it('a late signature while a retry press reads the store: nothing drawn over it (Z30)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.duringPrompt = undefined;
    const read = run.spy.hold('get', (args) => args[0] === order.orderId);
    const retried = run.session.retry('Fake');
    await read.reached;
    const later = after(run);
    held.answer();
    await held.pressed;
    await settle();
    expect(later.views()).toEqual([]);
    read.release();
    await retried;
  });
});

/** An acknowledged order of this page, left open with no attempt (another tab's funds check). */
async function openOrderBy(run: Run): Promise<OrderRecord> {
  const other = reload(run);
  await other.session.start();
  run.chain.tokens = 1n;
  await other.session.pay('Fake');
  run.chain.tokens = 1_000_000_000n;
  other.session.dispose();
  const open = (await records(run)).find((record) => record.state === 'ordered');
  if (open === undefined) {
    throw new Error('no open order');
  }
  return open;
}

/** A copy of `record` written as another tab would have left it. */
async function seed(record: OrderRecord, changes: Partial<OrderRecord>): Promise<OrderRecord> {
  const seeded: OrderRecord = { ...record, version: 1, ...changes };
  await backend.transactProduct(seeded.productAddress, () => ({
    write: [seeded],
    result: undefined,
  }));
  return seeded;
}

const ID = (letter: string) => letter.repeat(64);

describe('D5c: the open orders of this account at the press', () => {
  it('pays the newest one on these terms, and ends every other open one (M66, M70, M71, M72)', async () => {
    const run = await setup();
    const base = await openOrderBy(run);
    await store.update(base.orderId, base.version, { state: 'ended-unpaid' });
    const older = await seed(base, {
      orderId: ID('a'),
      createdAt: base.createdAt - 30,
      state: 'ordered',
    });
    const otherTerms = await seed(base, {
      orderId: ID('b'),
      createdAt: base.createdAt - 20,
      state: 'ordered',
      amount: (BigInt(base.amount) + 1n).toString(),
    });
    const lingering = await seed(base, {
      orderId: ID('c'),
      createdAt: base.createdAt - 10,
      state: 'created',
    });
    const cancelled = await seed(base, {
      orderId: ID('d'),
      createdAt: base.createdAt - 5,
      state: 'ordered',
      status: { status: 'cancelled', at: NOW },
    });
    await run.session.start();
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    const after = new Map((await records(run)).map((record) => [record.orderId, record]));
    expect(after.get(older.orderId)?.state).toBe('paying');
    expect(after.get(otherTerms.orderId)?.state).toBe('ended-unpaid');
    expect(after.get(cancelled.orderId)?.state).toBe('ended-unpaid');
    // A `created` order holds nothing: its end writes nothing, and it is never paid.
    expect(after.get(lingering.orderId)).toMatchObject({ state: 'created', version: 1 });
    expect([...after.values()].filter((record) => record.state === 'ordered')).toEqual([]);
    const state = internals(run.session);
    for (const ended of [otherTerms.orderId, cancelled.orderId]) {
      expect(state.background.has(ended)).toBe(true);
      expect(state.quiet.has(ended)).toBe(true);
      expect(state.followers.has(ended)).toBe(false);
    }
    expect(state.background.has(lingering.orderId)).toBe(false);
    expect(run.wallet.requests).toBe(1);
  });

  it('the order on screen comes first when it is on these terms', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const shown = await only(run);
    const newer = await seed(shown, { orderId: ID('e'), createdAt: shown.createdAt + 10 });
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    expect((await store.get(shown.orderId))?.state).toBe('paying');
    expect((await store.get(newer.orderId))?.state).toBe('ended-unpaid');
  });

  it('a lost end is read again and ended (M69)', async () => {
    const run = await setup();
    const base = await openOrderBy(run);
    await run.session.start();
    // `base` is continued at load (on screen); the other open one is to be ended, and
    // a benign write (a listener's status) bumps it meanwhile.
    const other = await seed(base, { orderId: ID('e'), createdAt: base.createdAt + 10 });
    const end = run.spy.hold('update', (args) => args[0] === other.orderId);
    run.chain.dropSends = true;
    const pressed = run.session.pay('Fake');
    await end.reached;
    const current = await store.get(other.orderId);
    if (current === undefined) {
      throw new Error('no record');
    }
    await store.update(current.orderId, current.version, { acknowledgedRelays: [...INBOX] });
    end.release();
    await pressed;
    expect((await store.get(other.orderId))?.state).toBe('ended-unpaid');
    expect((await store.get(base.orderId))?.state).toBe('paying');
  });

  it('a lost end of an order the store cancelled is read again and ended (M69, round 6 LOW-2)', async () => {
    const run = await setup();
    const base = await openOrderBy(run);
    await run.session.start();
    // Another open order the store cancelled unpaid: it ends at the press, and a
    // benign write bumps it meanwhile.
    const other = await seed(base, {
      orderId: ID('e'),
      createdAt: base.createdAt + 10,
      status: { status: 'cancelled', at: NOW },
    });
    const end = run.spy.hold('update', (args) => args[0] === other.orderId);
    run.chain.dropSends = true;
    const pressed = run.session.pay('Fake');
    await end.reached;
    const current = await store.get(other.orderId);
    if (current === undefined) {
      throw new Error('no record');
    }
    await store.update(current.orderId, current.version, { acknowledgedRelays: [...INBOX] });
    end.release();
    await pressed;
    expect(run.spy.writes.filter((write) => write.orderId === other.orderId)).toHaveLength(2);
    expect((await store.get(other.orderId))?.state).toBe('ended-unpaid');
    expect((await store.get(base.orderId))?.state).toBe('paying');
  });

  it('an end lost every time: nothing paid or placed, the offer says it failed (M73)', async () => {
    const run = await setup();
    const base = await openOrderBy(run);
    await run.session.start();
    const other = await seed(base, { orderId: ID('e'), createdAt: base.createdAt + 10 });
    const ends = Array.from({ length: 5 }, () =>
      run.spy.hold('update', (args) => args[0] === other.orderId),
    );
    const pressed = run.session.pay('Fake');
    for (const end of ends) {
      await end.reached;
      const current = await store.get(other.orderId);
      if (current === undefined) {
        throw new Error('no record');
      }
      await backend.transactProduct(current.productAddress, () => ({
        write: [{ ...current, version: current.version + 1 }],
        result: undefined,
      }));
      end.release();
    }
    await pressed;
    expect(run.spy.succeeded('setMarker')).toEqual([]);
    expect(await records(run)).toHaveLength(2);
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'failed' } });
    expect(run.wallet.requests).toBe(0);
  });

  it('an end lost to another tab’s marker: left alone, no "failed", the store’s exclusion holds (M73)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const shown = await only(run);
    const older = await seed(shown, { orderId: ID('e'), createdAt: shown.createdAt - 10 });
    const end = run.spy.hold('update', (args) => args[0] === older.orderId);
    run.chain.dropSends = true;
    const pressed = run.session.pay('Fake');
    await end.reached;
    await store.setMarker(older.orderId, older.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    end.release();
    await pressed;
    expect((await store.get(older.orderId))?.state).toBe('paying');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'earlier_payment' } });
    expect(run.wallet.requests).toBe(0);
  });

  it('an older open order ended by a press that then fails: its late completion is stored only (round 2 LOW-2)', async () => {
    const run = await setup();
    await run.session.start();
    const open = await openOrderBy(run);
    const older = await seed(open, {
      orderId: ID('a'),
      createdAt: open.createdAt - 10,
      state: 'ordered',
    });
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    expect((await store.get(older.orderId))?.state).toBe('ended-unpaid');
    expect((await store.get(open.orderId))?.state).toBe('ordered');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'insufficient_token' } });
    const later = after(run);
    await storeSays(run, older);
    expect((await store.get(older.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect(run.banners.filter((banner) => banner !== undefined)).toEqual([]);
  });

  it('an ended candidate’s follower is closed; an ended-order listener hears it (M70)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const first = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect(internals(run.session).followers.has(first.orderId)).toBe(true);
    const newer = await seed(await only(run), {
      orderId: ID('e'),
      createdAt: first.createdAt + 10,
    });
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    expect((await store.get(first.orderId))?.state).toBe('ended-unpaid');
    expect((await store.get(newer.orderId))?.state).toBe('paying');
    const state = internals(run.session);
    expect(state.followers.has(first.orderId)).toBe(false);
    expect(state.background.has(first.orderId)).toBe(true);
  });

  it('a candidate is read for held store answers before it is adopted: a held cancel ends it (M68)', async () => {
    const run = await setup();
    // B: a payment whose wallet failed (its attempt lives); A: an older open order.
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const paying = await only(run);
    run.session.dispose();
    const older = await seed(paying, {
      orderId: ID('a'),
      createdAt: paying.createdAt - 10,
      state: 'ordered',
    });
    const { marker: _marker, ...unmarked } = older;
    await seed(unmarked as OrderRecord, {});
    await storeSays(run, older, CANCEL);
    expect((await store.get(older.orderId))?.status).toBeUndefined();
    // B ends: the press proves it over first.
    run.chain.expire();
    run.chain.nextBlockhash();
    run.wallet.behaviour = 'sign';
    const again = reload(run);
    await again.session.start();
    await again.session.pay('Fake');
    expect((await store.get(older.orderId))?.marker).toBeUndefined();
    expect((await store.get(older.orderId))?.state).toBe('ended-unpaid');
    const placed = (await records(run)).filter(
      (record) => record.orderId !== older.orderId && record.orderId !== paying.orderId,
    );
    expect(placed).toHaveLength(1);
    expect(placed[0]?.marker).toBeDefined();
  });

  it('the continued order ended by another tab before the press: a new order, no line (round 6 LOW-3)', async () => {
    const run = await setup();
    const base = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).record?.orderId).toBe(base.orderId);
    await store.update(base.orderId, base.version, { state: 'ended-unpaid' });
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    const placed = (await records(run)).filter((record) => record.orderId !== base.orderId);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.state).toBe('paying');
    expect((await store.get(base.orderId))?.state).toBe('ended-unpaid');
    expect(lineOf(run.last())).toBeUndefined();
    expect(run.views.some((view) => lineOf(view) !== undefined)).toBe(false);
    expect(run.wallet.requests).toBe(1);
  });

  it('a candidate ended by another tab while the press reads it: skipped, a new order, no line (round 6 LOW-3)', async () => {
    const run = await setup();
    await run.session.start();
    const base = await openOrderBy(run);
    expect(internals(run.session).record).toBeUndefined();
    // The press reads the open orders, then the candidate again: ended in between.
    const read = run.spy.hold('get', (args) => args[0] === base.orderId);
    run.chain.dropSends = true;
    const pressed = run.session.pay('Fake');
    await read.reached;
    await store.update(base.orderId, base.version, { state: 'ended-unpaid' });
    read.release();
    await pressed;
    const placed = (await records(run)).filter((record) => record.orderId !== base.orderId);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.state).toBe('paying');
    expect((await store.get(base.orderId))?.state).toBe('ended-unpaid');
    expect(run.views.some((view) => lineOf(view) !== undefined)).toBe(false);
    expect(run.wallet.requests).toBe(1);
  });

  it('a backgrounded open order another tab marked is never adopted: its line (M67)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    const open = await only(run);
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    run.wallet.behaviour = 'sign';
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect((await store.get(order.orderId))?.marker?.attemptId).toBe('another-tab');
    expect(run.wallet.requests).toBe(1);
  });

  it('a narrowed follower whose order another tab marked is armed again: its rail ends it, the line clears (LOW-1)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect(internals(run.session).followers.get(order.orderId)?.timer).toBeUndefined();
    const open = await only(run);
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    run.wallet.behaviour = 'sign';
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    const follower = internals(run.session).followers.get(order.orderId);
    expect(follower?.timer).toBeDefined();
    expect(follower?.republish).toBeDefined();
    expect(run.timers.count(REPUBLISH_EVERY_MS)).toBe(1);
    expect(run.timers.count(WATCH_EVERY_MS)).toBe(1);
    // The other tab's attempt can no longer land: the background rail ends it.
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(order.orderId))?.state).toBe('ended-unpaid');
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    expect(run.wallet.requests).toBe(1);
  });
});

/** The wallet's connect held open; `reached` once asked. */
function connectHeld(run: Run, answer: () => Promise<void> = async () => undefined) {
  const connected = gate();
  const reached = gate();
  run.deps.wallets = () => [
    {
      name: 'Fake',
      connect: async () => {
        reached.open();
        await connected.promise;
        await answer();
        return run.wallet;
      },
    },
  ];
  return { reached: reached.promise, release: connected.open };
}

/** No view the buyer reads as an order shown, and no status after "ready", from here on. */
function nothingShown(later: ReturnType<typeof after>): void {
  for (const view of later.views()) {
    expect([
      'delivered',
      'refunded',
      'cancelled',
      'waiting_payment',
      'waiting_store',
    ]).not.toContain(view.kind);
  }
  for (const state of later.statuses()) {
    expect(['completed', 'refunded', 'paying', 'paid']).not.toContain(state);
  }
}

describe('R-q: an open order continued silently, finished by the store', () => {
  for (const [name, message, state] of [
    ['completed by hand', {}, 'completed'],
    ['cancelled', CANCEL, 'ordered'],
  ] as const) {
    it(`at load (${name}): stored only, nothing drawn or told; the next press places a new order (M78)`, async () => {
      const run = await setup();
      const open = await openOrderBy(run);
      await run.session.start();
      expect(internals(run.session).silent).toBe(open.orderId);
      const later = after(run);
      await storeSays(run, open, message);
      expect((await store.get(open.orderId))?.state).toBe(state);
      expect(later.views()).toEqual([]);
      expect(later.statuses()).toEqual([]);
      expect(internals(run.session).record).toBeUndefined();
      run.chain.dropSends = true;
      await run.session.pay('Fake');
      expect(await records(run)).toHaveLength(2);
      expect((await store.get(open.orderId))?.marker).toBeUndefined();
    });
  }

  it('kept on a close: stored only (M78)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    await storeSays(run, open);
    expect((await store.get(open.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('an order the buyer took in the open modal keeps today’s behaviour: shown and told (M78)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rejected' } });
    await storeSays(run, await only(run));
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(run.statuses.at(-1)).toBe('completed');
  });

  it('a close after Start over: the ended order’s late completion is stored only (M78)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.timers.tick();
    await run.session.startOver();
    expect(run.statuses).toContain('ended');
    const ended = await only(run);
    expect(ended.state).toBe('ended-unpaid');
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    await storeSays(run, ended);
    expect((await store.get(ended.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect(run.banners.filter((banner) => banner !== undefined)).toEqual([]);
  });

  it('a completion held behind the earlier-payment line shows at the next press (LOW-3)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.timers.tick();
    await run.session.startOver();
    const ended = await only(run);
    expect(ended.state).toBe('ended-unpaid');
    // Another tab pays meanwhile, and its payment does not land yet.
    run.chain.nextBlockhash();
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    // The ended order's completion is held behind the line.
    await storeSays(run, ended);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(true);
    const requests = run.wallet.requests;
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(false);
    expect(run.wallet.requests).toBe(requests);
  });

  it('a status that finishes nothing, then a completion: still stored only (M79)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    const later = after(run);
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    expect(internals(run.session).silent).toBe(open.orderId);
    await storeSays(run, open);
    expect((await store.get(open.orderId))?.state).toBe('completed');
    expect(later.statuses()).toEqual([]);
    expect(later.views().filter((view) => view.kind !== 'offer')).toEqual([]);
  });

  it('finished during the press’s read of the open orders: dropped, a new order (M80)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    const read = run.spy.holdNth('forProduct', 2);
    run.chain.dropSends = true;
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await read.reached;
    await storeSays(run, open);
    read.release();
    await pressed;
    expect(later.views().some((view) => view.kind === 'delivered')).toBe(false);
    expect(later.statuses()).not.toContain('completed');
    expect(await records(run)).toHaveLength(2);
    expect((await store.get(open.orderId))?.marker).toBeUndefined();
  });

  it('marked by another tab during the press’s read: its line, followed, nothing drawn (M80, M85)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    const read = run.spy.holdNth('forProduct', 2);
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await read.reached;
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    read.release();
    await pressed;
    nothingShown(later);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(internals(run.session).followers.has(open.orderId)).toBe(true);
    expect(run.wallet.requests).toBe(0);
  });

  it('marked by another tab during the connect: never re-shown, a later status draws nothing (M85)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    const connect = connectHeld(run);
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    connect.release();
    await pressed;
    nothingShown(later);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(internals(run.session).followers.has(open.orderId)).toBe(true);
    const views = run.views.length;
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    expect(run.views).toHaveLength(views);
  });

  it('marked by another tab during the connect: its line, never a new order or a wallet request (M85)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    const writes = run.spy.writes.length;
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    connect.release();
    await pressed;
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(await records(run)).toHaveLength(1);
    expect(run.spy.writes.slice(writes).filter((write) => write.method === 'add')).toEqual([]);
    expect(run.wallet.requests).toBe(0);
    expect(internals(run.session).record).toBeUndefined();
  });

  it('marked by another tab before the press: its line drops it from the screen, a later status draws nothing (round 2 LOW-1)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    const later = after(run);
    await run.session.pay('Fake');
    nothingShown(later);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(internals(run.session).record).toBeUndefined();
    expect(run.wallet.requests).toBe(0);
    const line = after(run);
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    expect(line.views()).toEqual([]);
    expect(line.statuses()).not.toContain('paying');
    expect(line.statuses()).not.toContain('paid');
  });

  it('the buyer’s own order finished during the connect: shown, the press stops (M82)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    await run.session.start();
    await run.session.pay('Fake');
    run.wallet.behaviour = 'sign';
    const open = await only(run);
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    await storeSays(run, open);
    connect.release();
    await pressed;
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(await records(run)).toHaveLength(1);
    expect(run.wallet.requests).toBe(1);
  });

  it('the buyer’s own order ended by another tab during the connect: followed as today, the press stops (LOW-2)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    await run.session.start();
    await run.session.pay('Fake');
    run.wallet.behaviour = 'sign';
    const open = await only(run);
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    const current = await store.get(open.orderId);
    if (current === undefined) {
      throw new Error('no record');
    }
    await store.update(current.orderId, current.version, { state: 'ended-unpaid' });
    connect.release();
    await pressed;
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(await records(run)).toHaveLength(1);
    expect(run.wallet.requests).toBe(1);
    const state = internals(run.session);
    expect(state.record).toBeUndefined();
    expect(state.background.has(open.orderId)).toBe(true);
  });

  for (const [name, end] of [
    ['the connect refused', 'refused'],
    ['the press cancelled', 'cancel'],
    ['the press failing', 'throw'],
    ['the modal closed', 'close'],
  ] as const) {
    it(`finished while the press waits for the connect, then ${name}: dropped unseen (M89)`, async () => {
      const run = await setup();
      const open = await openOrderBy(run);
      await run.session.start();
      const connect = connectHeld(run, async () => {
        if (end === 'refused') {
          throw Object.assign(new Error('declined'), { code: 4001 });
        }
      });
      if (end === 'throw') {
        run.advance(600);
        run.deps.reloadOffer = async () => {
          throw new Error('relay down');
        };
      }
      const later = after(run);
      const pressed = run.session.pay('Fake');
      await connect.reached;
      await storeSays(run, open);
      if (end === 'cancel') {
        run.session.cancel();
      }
      if (end === 'close') {
        expect(run.session.resetOnClose()).toBe(true);
      }
      connect.release();
      await pressed;
      await settle();
      nothingShown(later);
      expect(internals(run.session).record).toBeUndefined();
      if (end === 'throw') {
        expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'failed' } });
      }
      if (end === 'close') {
        // "ready" was the last status already: the close posts nothing new.
        expect(later.statuses()).toEqual([]);
      }
      run.deps.reloadOffer = async () => loaded(run.shop, run.relays, run.now());
      run.deps.wallets = () => [{ name: 'Fake', connect: async () => run.wallet }];
      run.chain.dropSends = true;
      await run.session.pay('Fake');
      expect(await records(run)).toHaveLength(2);
    });
  }

  it('a silent order the store cancels while the press waits for the connect: dropped, never drawn (M89)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    const connect = connectHeld(run, async () => {
      throw Object.assign(new Error('declined'), { code: 4001 });
    });
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    await storeSays(run, open, CANCEL);
    connect.release();
    await pressed;
    nothingShown(later);
    expect(internals(run.session).record).toBeUndefined();
  });

  it('a silent order that is not acknowledged at the press: its problem shows, it is no longer silent (M88)', async () => {
    const run = await setup();
    run.relays.refuse = INBOX;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const created = await only(run);
    expect(created.state).toBe('created');
    await run.session.start();
    expect(internals(run.session).silent).toBe(created.orderId);
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'order_not_acknowledged' },
    });
    expect(internals(run.session).silent).toBeUndefined();
  });

  it('a candidate whose held-status read misses, finished as its listener starts: dropped, a new order (M86, M87)', async () => {
    const run = await setup();
    // B: a payment whose wallet failed (shown at load: nothing continued); A: older, open.
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const paying = await only(run);
    run.session.dispose();
    const { marker: _marker, ...unmarked } = paying;
    const older = await seed(unmarked as OrderRecord, {
      orderId: ID('a'),
      createdAt: paying.createdAt - 10,
      state: 'ordered',
    });
    // A's completion is on the relays; the one-shot read of held answers never answers.
    await storeSays(run, older);
    expect((await store.get(older.orderId))?.state).toBe('ordered');
    const reached = gate();
    const deafToQueries = new Proxy(run.relays, {
      get(target, property) {
        if (property === 'query') {
          return (...args: Parameters<MemoryRelays['query']>) => {
            const [, filters] = args;
            if (filters.some((filter) => filter['#p'] !== undefined)) {
              reached.open();
              return new Promise(() => undefined);
            }
            return target.query(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    run.chain.expire();
    run.chain.nextBlockhash();
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    const again = reload(run, { clientFor: () => deafToQueries });
    await again.session.start();
    expect(internals(again.session).record).toBeUndefined();
    // The order's own re-read at the press (after the held read, the check's re-read,
    // and the listener's own read of the replayed answer) resolves once that answer is stored.
    const reread = run.spy.holdNth('get', 4, (args) => args[0] === older.orderId);
    const pressed = again.session.pay('Fake');
    await reached.promise;
    await run.timers.tick(2_000);
    await reread.reached;
    await settle();
    expect((await store.get(older.orderId))?.state).toBe('completed');
    reread.release();
    await pressed;
    expect(again.views.some((view) => view.kind === 'delivered')).toBe(false);
    expect(again.statuses).not.toContain('completed');
    expect((await store.get(older.orderId))?.state).toBe('completed');
    expect((await store.get(older.orderId))?.marker).toBeUndefined();
    const placed = (await records(run)).filter(
      (record) => record.orderId !== older.orderId && record.orderId !== paying.orderId,
    );
    expect(placed).toHaveLength(1);
  });

  it('finished by the store while a failed press re-reads it: dropped, never shown (Z24)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    await settle();
    expect(internals(run.session).silent).toBe(open.orderId);
    const failing = run.spy.hold('get', (args) => args[0] === open.orderId, true);
    run.chain.dropSends = true;
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await failing.reached;
    const reread = run.spy.hold('get', (args) => args[0] === open.orderId);
    failing.release();
    await reread.reached;
    await storeSays(run, open);
    reread.release();
    await pressed;
    await settle();
    expect(later.views().some((view) => view.kind === 'delivered')).toBe(false);
    expect(later.statuses()).not.toContain('completed');
  });
});

describe('R-q (j): the commit site', () => {
  it('an answer stored while the press read an older copy: dropped there, never committed (M87, M89)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    const stale = await store.get(open.orderId);
    if (stale === undefined) {
      throw new Error('no record');
    }
    // orderFor's own read of the order on screen (after D5c's read and its re-check).
    const reread = run.spy.holdStale(1, open.orderId, stale);
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await reread.reached;
    await storeSays(run, open);
    expect((await store.get(open.orderId))?.state).toBe('completed');
    reread.release();
    await pressed;
    expect(later.statuses()).toEqual([]);
    expect(later.views().some((view) => view.kind === 'delivered')).toBe(false);
    // The plain offer: no line for a finished order, no "failed", nothing followed.
    const shown = run.last();
    expect(shown).toMatchObject({ kind: 'offer' });
    expect(shown?.kind === 'offer' ? shown.problem : 'none').toBeUndefined();
    expect(internals(run.session).followers.has(open.orderId)).toBe(false);
    expect(internals(run.session).record).toBeUndefined();
    expect(await records(run)).toHaveLength(1);
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    expect(await records(run)).toHaveLength(2);
  });
});

describe('R-l: quiet after a close', () => {
  it('a completion held for an earlier order is never shown after a close (M56)', async () => {
    const run = await setup();
    // E: an earlier order that ended; then R, a payment that does not land yet.
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    await run.session.startOver();
    const ended = await only(run);
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    // E's completion is held back by R.
    await storeSays(run, ended);
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(true);
    expect(run.session.resetOnClose()).toBe(true);
    expect(internals(run.session).pendingAnswers.size).toBe(0);
    const later = after(run);
    await run.session.pay('Fake');
    expect(later.views().some((view) => view.kind === 'delivered')).toBe(false);
    expect(later.statuses()).not.toContain('completed');
    expect(lineOf(run.last())?.phase).toBe('confirming');
  });

  it('a close on the plain offer drops a held refund too (M64)', async () => {
    const run = await setup();
    // E ended, then refunded while a newer open order is on screen: held (a refund waits).
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    await run.session.startOver();
    const ended = await only(run);
    run.wallet.behaviour = 'sign';
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    await storeSays(run, ended, REFUND);
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(true);
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(later.views().some((view) => view.kind === 'refunded')).toBe(false);
    expect(later.statuses()).not.toContain('refunded');
  });

  it('a close while a held answer ends the order on screen: its listener is still quiet (R-l, M22)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    await run.session.startOver();
    const ended = await only(run);
    run.wallet.behaviour = 'sign';
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const live = (await records(run)).find((record) => record.state === 'ordered');
    if (live === undefined) {
      throw new Error('no open order');
    }
    // E's completion ends the open order on screen; the close comes during that end.
    const end = run.spy.hold('update', (args) => args[0] === live.orderId);
    await storeSays(run, ended);
    await end.reached;
    expect(run.session.resetOnClose()).toBe(true);
    end.release();
    await settle();
    expect((await store.get(live.orderId))?.state).toBe('ended-unpaid');
    const state = internals(run.session);
    expect(state.quiet.has(live.orderId)).toBe(true);
    expect(state.background.has(live.orderId)).toBe(true);
    const later = after(run);
    await storeSays(run, live);
    expect((await store.get(live.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });
});

describe('R-j: actions that are not a press, after a close', () => {
  for (const at of ['read', 'end'] as const) {
    it(`Start over paused at its ${at}: no "ended", no offer drawn (M25)`, async () => {
      const run = await setup();
      run.wallet.behaviour = 'throw';
      await run.session.start();
      await run.session.pay('Fake');
      run.chain.expire();
      await run.timers.tick();
      const order = await only(run);
      const pause =
        at === 'read'
          ? run.spy.hold('get', (args) => args[0] === order.orderId)
          : run.spy.hold('clearMarker');
      const started = run.session.startOver();
      await pause.reached;
      expect(run.session.resetOnClose()).toBe(true);
      const later = after(run);
      pause.release();
      await started;
      await settle();
      expect(later.views()).toEqual([]);
      expect(later.statuses()).toEqual([]);
      if (at === 'end') {
        // The end the buyer asked for stands, and its store answer is still heard, quietly.
        expect((await store.get(order.orderId))?.state).toBe('ended-unpaid');
        expect(internals(run.session).background.has(order.orderId)).toBe(true);
        expect(internals(run.session).quiet.has(order.orderId)).toBe(true);
      }
    });
  }

  it('Buy again paused at its read, then a close: no offer drawn again (M25)', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    const order = await only(run);
    await storeSays(run, order);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    const pause = run.spy.hold('get', (args) => args[0] === order.orderId);
    const started = run.session.startOver();
    await pause.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    pause.release();
    await started;
    await settle();
    expect(later.views()).toEqual([]);
  });
});

/** The working view's fields, when the last view is the signing step. */
function signingOf(view: View | undefined) {
  return view?.kind === 'working' && view.step === 'signing' ? view : undefined;
}

/** The record's Solana marker, or a failure. */
function solanaMarker(record: OrderRecord | undefined) {
  const marker = record?.marker;
  if (marker?.rail !== 'solana') {
    throw new Error('a Solana attempt');
  }
  return marker;
}

describe('D2: the wallet has not answered (the probe)', () => {
  it('U-a counts down to when the attempt can be proven over, posting nothing (M9)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const statuses = run.statuses.length;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    const marker = solanaMarker(await only(run));
    const blocks = BigInt(marker.lastValidBlockHeight) + 32n - run.chain.height;
    const shown = signingOf(run.last());
    expect(shown?.startOverIn?.seconds).toBe(Math.ceil(Number(blocks) * 0.4));
    // The clock has not moved since the read resolved: the countdown starts at that moment.
    expect(shown?.startOverIn?.at).toBe(run.now());
    expect(shown?.unsureAt).toBe(marker.setAt + 600);
    expect(run.statuses).toHaveLength(statuses);
    held.answer();
    await held.pressed;
  });

  it('U-a2 an estimate at 0 with blocks still left keeps its zero moment: taking long 10 minutes after it (round 17)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    const estimate = signingOf(run.last())?.startOverIn;
    if (estimate === undefined) {
      throw new Error('no estimate');
    }
    const zeroAt = estimate.at + estimate.seconds;
    // The device clock runs on, the chain does not: the estimate reaches 0 with
    // blocks still left, and every later read finds it there.
    run.advance(zeroAt - run.now() + 5);
    for (let tick = 0; tick < 4; tick += 1) {
      run.advance(30);
      await run.timers.tick(WATCH_EVERY_MS);
    }
    const drawn = signingOf(run.last())?.startOverIn;
    expect(drawn === undefined ? undefined : drawn.at + drawn.seconds).toBe(zeroAt);
    run.advance(zeroAt + 600 - run.now());
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    const shown = signingOf(run.last());
    expect(isTakingLong(run.now(), shown?.startOverIn, shown?.unsureAt)).toBe(true);
    held.answer();
    await held.pressed;
  });

  it('U-b never ends the press before the proof; a second press does nothing', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    run.chain.advance(100n);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(signingOf(run.last())).toBeDefined();
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    expect(internals(run.session).busy).toBe(true);
    held.answer();
    await held.pressed;
  });

  it('U-c proven over in the press: the retry; Start over ends it; a late signature lands nowhere', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    await run.session.startOver();
    expect(run.statuses).toContain('ended');
    expect((await only(run)).state).toBe('ended-unpaid');
    const later = after(run);
    const sent = run.chain.sent.length;
    held.answer();
    await held.pressed;
    await settle();
    expect(run.chain.sent).toHaveLength(sent);
    expect(later.views()).toEqual([]);
  });

  it('U-c2 a retry: the predecessor is never judged; the new attempt is counted (M7, M8)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'sign';
    const replace = run.spy.hold('updateMarker');
    const prompt = gate();
    run.wallet.duringPrompt = () => prompt.promise;
    const retried = run.session.retry('Fake');
    await replace.reached;
    await run.timers.tick(WATCH_EVERY_MS);
    // The predecessor (proven over) is still stored: never judged again.
    expect(run.last()).toMatchObject({ kind: 'working', step: 'signing' });
    expect(internals(run.session).busy).toBe(true);
    replace.release();
    await settle();
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    const marker = solanaMarker(await only(run));
    const blocks = BigInt(marker.lastValidBlockHeight) + 32n - run.chain.height;
    expect(signingOf(run.last())?.startOverIn?.seconds).toBe(Math.ceil(Number(blocks) * 0.4));
    prompt.open();
    await retried;
  });

  it('U-c3 adopts the marker into the record on screen (M10)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    expect(internals(run.session).record?.marker).toBeUndefined();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(internals(run.session).record?.marker).toBeDefined();
    held.answer();
    await held.pressed;
  });

  it('U-c3b another tab replaced the attempt during the pass: its order is followed (M91c)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    run.chain.expire();
    run.chain.nextBlockhash();
    const listing = gate();
    const listed = gate();
    let first = true;
    run.chain.onList = async () => {
      if (first) {
        first = false;
        listed.open();
        await listing.promise;
      }
    };
    void run.timers.tick(WATCH_EVERY_MS);
    await listed.promise;
    const current = await only(run);
    const marker = solanaMarker(current);
    const { signature: _signature, signedTransaction: _signed, ...unsigned } = marker;
    await store.updateMarker(current.orderId, current.version, marker.attemptId, {
      ...unsigned,
      attemptId: 'another-tab',
      lastValidBlockHeight: String(run.chain.height + 10_000n),
    });
    listing.open();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false });
    expect(run.timers.count(REPUBLISH_EVERY_MS)).toBe(1);
    held.answer();
    await held.pressed;
  });

  it('U-c5 a payment found by the probe is followed: its receipt sent again, "paid" once (M90, M91)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    // Paid from another device; every receipt publish fails for now.
    const request = JSON.parse(order.paymentRequest ?? '{}');
    await run.chain.injectPayment(request);
    // The pass's own receipt is lost (its write refused); the follow resends it.
    let refused = 0;
    run.spy.refuseWrites((method, args) => {
      const receipt =
        method === 'update' &&
        typeof args[2] === 'object' &&
        args[2] !== null &&
        'receiptWrap' in args[2];
      if (receipt && refused === 0) {
        refused += 1;
        return true;
      }
      return false;
    });
    await run.timers.tick(WATCH_EVERY_MS);
    expect(refused).toBe(1);
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect((await only(run)).receiptWrap).toBeDefined();
    expect(run.timers.count(REPUBLISH_EVERY_MS)).toBe(1);
    const paid = run.statuses.indexOf('paid');
    expect(paid).toBeGreaterThan(-1);
    expect(run.statuses.slice(paid)).toEqual(['paid']);
    // The wallet never answers: the order is followed all the same.
    void held;
  });

  it('U-c5 the store answers during the probe’s pass: the finished order shows, nothing told twice (M91, M91b)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const order = await only(run);
    await run.chain.injectPayment(JSON.parse(order.paymentRequest ?? '{}'));
    const listing = gate();
    const listed = gate();
    let first = true;
    run.chain.onList = async () => {
      if (first) {
        first = false;
        listed.open();
        await listing.promise;
      }
    };
    void run.timers.tick(WATCH_EVERY_MS);
    await listed.promise;
    await storeSays(run, order);
    listing.open();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    const after = run.statuses.slice(run.statuses.indexOf('ordered') + 1);
    expect(after.filter((state) => state === 'completed')).toHaveLength(1);
    expect(after.slice(after.indexOf('completed'))).not.toContain('paying');
    void held;
  });

  it('U-c5 a late wallet failure after the store answered: the stored order, never the rail’s copy (M43)', async () => {
    const run = await setup();
    await run.session.start();
    const prompt = gate();
    const asked = gate();
    run.wallet.duringPrompt = async () => {
      asked.open();
      await prompt.promise;
      throw new Error('the wallet broke');
    };
    const pressed = run.session.pay('Fake');
    await asked.promise;
    await settle();
    const order = await only(run);
    await run.chain.injectPayment(JSON.parse(order.paymentRequest ?? '{}'));
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    await storeSays(run, order);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    prompt.open();
    await pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('U-c5 an earlier order’s held completion shows after the probe’s skipped verdict (M91b)', async () => {
    const run = await setup();
    // X: an earlier order that ended; Y: the order being signed.
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    await run.session.startOver();
    const earlier = await only(run);
    run.wallet.behaviour = 'sign';
    const held = await signingHeld(run);
    const signing = (await records(run)).find((record) => record.orderId !== earlier.orderId);
    if (signing === undefined) {
      throw new Error('no order');
    }
    await storeSays(run, earlier);
    expect(internals(run.session).pendingAnswers.has(earlier.orderId)).toBe(true);
    await run.chain.injectPayment(JSON.parse(signing.paymentRequest ?? '{}'));
    const listing = gate();
    const listed = gate();
    let first = true;
    run.chain.onList = async () => {
      if (first) {
        first = false;
        listed.open();
        await listing.promise;
      }
    };
    void run.timers.tick(WATCH_EVERY_MS);
    await listed.promise;
    await storeSays(run, signing);
    listing.open();
    await settle();
    expect(internals(run.session).pendingAnswers.has(earlier.orderId)).toBe(false);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    void held;
  });

  it('U-f the store answers while the wallet is open: the press stays until the wallet answers (M11)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    await storeSays(run, await only(run));
    await run.timers.tick(WATCH_EVERY_MS);
    expect(signingOf(run.last())).toBeDefined();
    expect(internals(run.session).busy).toBe(true);
    held.answer();
    await held.pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('U-g a decline releases at once, and the probe stops', async () => {
    const run = await setup();
    await run.session.start();
    run.wallet.behaviour = 'reject';
    await run.session.pay('Fake');
    expect((await only(run)).state).toBe('ordered');
    expect(internals(run.session).unanswered).toBeUndefined();
  });

  it('U-h it never starts while checking or ordering, and stops on a close and on dispose', async () => {
    const run = await setup();
    await run.session.start();
    const connect = connectHeld(run);
    const prompt = gate();
    run.wallet.duringPrompt = () => prompt.promise;
    const pressed = run.session.pay('Fake');
    await connect.reached;
    expect(internals(run.session).unanswered).toBeUndefined();
    connect.release();
    await settle();
    expect(internals(run.session).unanswered).toBeDefined();
    expect(run.session.resetOnClose()).toBe(true);
    expect(internals(run.session).unanswered).toBeUndefined();
    void pressed;
    const second = await setup();
    await second.session.start();
    await signingHeld(second);
    second.session.dispose();
    expect(internals(second.session).unanswered).toBeUndefined();
  });

  for (const where of ['read', 'pass'] as const) {
    it(`U-h a tick running at the close (its ${where}) draws nothing and ends no newer press (M22)`, async () => {
      const run = await setup();
      await run.session.start();
      const held = await signingHeld(run);
      const order = await only(run);
      run.chain.expire();
      run.chain.nextBlockhash();
      const listing = gate();
      const listed = gate();
      let first = true;
      if (where === 'pass') {
        run.chain.onList = async () => {
          if (first) {
            first = false;
            listed.open();
            await listing.promise;
          }
        };
      }
      const read = run.spy.hold('get', (args) => args[0] === order.orderId);
      void run.timers.tick(WATCH_EVERY_MS);
      await read.reached;
      if (where === 'pass') {
        read.release();
        await listed.promise;
      }
      expect(run.session.resetOnClose()).toBe(true);
      // A newer press after reopening, paused in its own check.
      const check = run.spy.hold('forProduct');
      const newer = run.session.pay('Fake');
      const later = after(run);
      if (where === 'read') {
        read.release();
      } else {
        listing.open();
      }
      await settle();
      // Only the newer press's own progress: never the old press's signing step.
      expect(
        later.views().filter((view) => !(view.kind === 'working' && view.step === 'checking')),
      ).toEqual([]);
      expect(internals(run.session).record).toBeUndefined();
      // The newer press was never ended by the old tick: the attempt proven over, it
      // reaches the wallet.
      check.release();
      for (let turn = 0; turn < 200 && run.wallet.requests < 2; turn += 1) {
        await settle(1);
      }
      expect(run.wallet.requests).toBe(2);
      held.answer();
      await held.pressed;
      await newer;
    });
  }

  it('the probe carries when the attempt is unsure even while no countdown can be read (Y20)', async () => {
    const run = await setup();
    await run.session.start();
    const prompt = gate();
    const asked = gate();
    run.wallet.duringPrompt = async () => {
      run.chain.failing = true;
      asked.open();
      await prompt.promise;
    };
    const pressed = run.session.pay('Fake');
    await asked.promise;
    await settle();
    await run.timers.tick(WATCH_EVERY_MS);
    await settle();
    const view = run.last();
    expect(view).toMatchObject({ kind: 'working', step: 'signing' });
    expect(signingOf(view)?.unsureAt).toBeDefined();
    run.chain.failing = false;
    prompt.open();
    await pressed;
  });
});

describe('D1c: the load', () => {
  async function inProgress(kind: 'paying' | 'signed' | 'paid' | 'blocked' | 'cancelled_paid') {
    const run = await setup();
    run.chain.dropSends = kind !== 'paid' && kind !== 'cancelled_paid';
    if (kind === 'paying') {
      run.wallet.behaviour = 'throw';
    }
    await run.session.start();
    await run.session.pay('Fake');
    if (kind === 'paid' || kind === 'cancelled_paid') {
      await run.timers.tick();
    }
    if (kind === 'cancelled_paid') {
      await storeSays(run, await only(run), CANCEL);
    }
    if (kind === 'blocked') {
      const paying = await only(run);
      await backend.transactProduct(paying.productAddress, () => ({
        write: [{ ...paying, version: paying.version + 1, state: 'blocked' }],
        result: undefined,
      }));
    }
    run.session.dispose();
    run.chain.dropSends = true;
    run.wallet.behaviour = 'sign';
    return { run, record: await only(run) };
  }

  for (const kind of ['paying', 'signed', 'paid', 'blocked', 'cancelled_paid'] as const) {
    it(`L-a/L-b an order ${kind}: the offer, "ready" only, followed and quiet; a press asks the wallet nothing (M32, M33)`, async () => {
      const { run, record } = await inProgress(kind);
      const fresh = await setup();
      await fresh.session.start();
      const again = reload(run);
      await again.session.start();
      expect(again.views).toHaveLength(1);
      expect(again.statuses).toEqual(['ready']);
      // The same card as for a visitor with no history.
      const shown = again.last();
      const plain = fresh.last();
      expect(shown?.kind).toBe('offer');
      expect(shown?.kind === 'offer' ? shown.problem : 'none').toBeUndefined();
      expect(plain?.kind).toBe('offer');
      const state = internals(again.session);
      expect(state.followers.has(record.orderId)).toBe(true);
      expect(state.quiet.has(record.orderId)).toBe(true);
      expect(state.record).toBeUndefined();
      const requests = run.wallet.requests;
      await again.session.pay('Fake');
      if (kind !== 'blocked') {
        expect(run.wallet.requests).toBe(requests);
        expect(lineOf(again.last())).toBeDefined();
      }
    });
  }

  it('L-a several orders: every one that holds or is blocked is followed (M40)', async () => {
    const { run, record } = await inProgress('paying');
    const blocked = await seed(record, {
      orderId: ID('b'),
      createdAt: record.createdAt - 10,
      state: 'blocked',
    });
    const answered = await seed(record, {
      orderId: ID('c'),
      createdAt: record.createdAt + 10,
      state: 'paying',
      status: { status: 'confirmed', at: NOW },
    });
    const again = reload(run);
    await again.session.start();
    const followers = internals(again.session).followers;
    for (const orderId of [record.orderId, blocked.orderId, answered.orderId]) {
      expect(followers.has(orderId)).toBe(true);
    }
    expect(followers.get(blocked.orderId)?.timer).toBeUndefined();
    expect(followers.get(record.orderId)?.timer).toBeDefined();
  });

  it('L-b the first view and "ready" come before any relay round trip (M44)', async () => {
    const { run } = await inProgress('paid');
    const never = new Proxy(run.relays, {
      get(target, property) {
        if (property === 'query') {
          return () => new Promise(() => undefined);
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const again = reload(run, { readClient: never, clientFor: () => never });
    const started = again.session.start();
    await settle();
    expect(again.statuses).toEqual(['ready']);
    expect(again.last()).toMatchObject({ kind: 'offer' });
    void started;
  });

  it('L-c a paid order whose receipt was lost is published at once at load, and again later (M34)', async () => {
    const { run, record } = await inProgress('paid');
    const lost = await seed(record, { version: record.version + 1 });
    const { receiptWrap: _receipt, ...withoutReceipt } = lost;
    await seed(withoutReceipt as OrderRecord, { version: lost.version + 1 });
    const orderPublishes = () =>
      run.relays.published.filter((each) => each.event.id === record.orderWrap?.id).length;
    const before = orderPublishes();
    const again = reload(run);
    await again.session.start();
    await settle();
    expect(orderPublishes()).toBe(before + 1);
    await run.timers.tick(REPUBLISH_EVERY_MS);
    expect(orderPublishes()).toBe(before + 2);
    // Its rail tick sends the lost receipt.
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(record.orderId))?.receiptWrap).toBeDefined();
    await storeSays(run, record);
    expect((await again.session.purchases()).map((purchase) => purchase.status)).toEqual([
      'delivered',
    ]);
    expect(again.statuses).toEqual(['ready']);
  });
});

/** The same offer with a second payout of the same coin to `address`, a little dearer. */
function withSecondPayout(offer: Ready, address: string): Ready {
  const [first] = offer.payouts;
  if (first === undefined) {
    throw new Error('no payout');
  }
  const target = { ...first.target, address };
  return {
    ...offer,
    offer: { ...offer.offer, payouts: [...offer.offer.payouts, target] },
    payouts: [...offer.payouts, { target, amount: first.amount + 5n }],
  };
}

describe('more of the plan’s cases', () => {
  it('a close on the plain offer detaches a press not yet in its guard (M53)', async () => {
    const run = await setup();
    await run.session.start();
    const writes = run.spy.writes.length;
    const views = run.views.length;
    const pressed = run.session.pay('Fake');
    expect(run.session.resetOnClose()).toBe(true);
    await pressed;
    await settle();
    expect(run.connects()).toBe(0);
    expect(run.wallet.requests).toBe(0);
    expect(run.views).toHaveLength(views);
    expect(run.statuses).toEqual(['ready']);
    expect(run.spy.writes.slice(writes)).toEqual([]);
  });

  it('R-q (g) a candidate’s held answers are read on its own relays (M81)', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const shown = await only(run);
    const own = ['wss://own-inbox.example.com'];
    await seed(shown, { orderId: ID('a'), createdAt: shown.createdAt + 10, inboxRelays: own });
    // A typed email: the order on screen is not paid as it is; the other one is checked.
    run.session.setEmail('buyer@example.com');
    const queried = run.relays.queried.length;
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    expect(run.relays.queried.slice(queried)).toContainEqual(own);
  });

  it('R-q (g) the order on screen finished while a candidate is read: shown, the candidate never adopted (M81b)', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const shown = await only(run);
    const own = ['wss://own-inbox.example.com'];
    const candidate = await seed(shown, {
      orderId: ID('a'),
      createdAt: shown.createdAt + 10,
      inboxRelays: own,
    });
    // A typed email: the order on screen is not paid as it is; the other one is checked.
    run.session.setEmail('buyer@example.com');
    const read = run.spy.hold('get', (args) => args[0] === candidate.orderId);
    run.chain.dropSends = true;
    const pressed = run.session.pay('Fake');
    await read.reached;
    expect(internals(run.session).record?.orderId).toBe(shown.orderId);
    await storeSays(run, shown);
    read.release();
    await pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(internals(run.session).record?.orderId).toBe(shown.orderId);
    expect((await store.get(candidate.orderId))?.state).toBe('ordered');
    expect(run.wallet.requests).toBe(0);
  });

  it('R-q (m) an order adopted and committed while "ordered" was told already is no longer silent (M86)', async () => {
    const second = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    await run.session.start();
    // Press 1 commits X ("ordered"), then its payment cannot be composed.
    run.spy.refuseWrites(
      (method, args) =>
        method === 'update' &&
        typeof args[2] === 'object' &&
        args[2] !== null &&
        'paymentRequest' in args[2],
    );
    await run.session.pay('Fake');
    run.spy.refuseWrites(undefined);
    expect(run.statuses.at(-1)).toBe('ordered');
    const first = await only(run);
    const chosen = run.offer.payouts[1];
    if (chosen === undefined) {
      throw new Error('two payouts');
    }
    // A: an older open order on the second payout's terms.
    await seed(first, {
      orderId: ID('a'),
      createdAt: first.createdAt - 10,
      payout: { ...first.payout, address: chosen.target.address },
      amount: chosen.amount.toString(),
    });
    run.session.choosePayout(1);
    const hold = gate();
    run.wallet.duringPrompt = () => hold.promise;
    const pressed = run.session.pay('Fake');
    await settle();
    expect(internals(run.session).record?.orderId).toBe(ID('a'));
    expect(internals(run.session).silent).toBeUndefined();
    hold.open();
    await pressed;
  });
});

describe('the last stale check before each draw', () => {
  it('guard’s catch: a close during its read follows nothing (M22a)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    // The press's own read of the order fails: it ends in its catch, which reads again.
    const failing = run.spy.hold('get', (args) => args[0] === open.orderId, true);
    const pressed = run.session.pay('Fake');
    await failing.reached;
    const read = run.spy.hold('get', (args) => args[0] === open.orderId);
    failing.release();
    await read.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    read.release();
    await pressed;
    await settle();
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('the earlier-payment check: a close while it reads the holder’s countdown draws no line (M22)', async () => {
    const run = await setup();
    await closedWhilePaying(run);
    // The pass reads the height first, the countdown second.
    const held = holdRpc(run.chain.rpc, 'getEpochInfo', 2);
    run.deps.rpcFor = () => held.rpc;
    await detachedAt(run, () => run.session.pay('Fake'), held);
  });

  it('the composing of the payment, failing after a close: nothing drawn (M45)', async () => {
    const run = await setup();
    await run.session.start();
    const compose = run.spy.hold(
      'update',
      (args) => typeof args[2] === 'object' && args[2] !== null && 'paymentRequest' in args[2],
    );
    const pressed = run.session.pay('Fake');
    await compose.reached;
    run.spy.refuseWrites(
      (method, args) =>
        method === 'update' &&
        typeof args[2] === 'object' &&
        args[2] !== null &&
        'paymentRequest' in args[2],
    );
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    compose.release();
    await pressed;
    await settle();
    run.spy.refuseWrites(undefined);
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });

  it('the end of an adopted order on other terms, then a close: nothing placed or drawn (M45)', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const shown = await only(run);
    const adopted = await seed(shown, { orderId: ID('a'), createdAt: shown.createdAt + 10 });
    run.session.setEmail('buyer@example.com');
    // The shown order ends with the others first; then the adopted one, on a typed email.
    const end = run.spy.hold('update', (args) => args[0] === adopted.orderId);
    const pressed = run.session.pay('Fake');
    await end.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    end.release();
    await pressed;
    await settle();
    expect(later.views()).toEqual([]);
    expect(await records(run)).toHaveLength(2);
  });
});

/** Another tab's payment for this product, out but not landed yet; then this tab's press meets its line. */
async function lineOfOtherTab(run: Run): Promise<OrderRecord> {
  await run.session.start();
  run.chain.dropSends = true;
  const other = reload(run);
  await other.session.start();
  await other.session.pay('Fake');
  other.session.dispose();
  await run.session.pay('Fake');
  expect(lineOf(run.last())?.phase).toBe('confirming');
  const holder = (await records(run)).find((record) => record.state === 'paying');
  if (holder === undefined) {
    throw new Error('no holder');
  }
  return holder;
}

/** The session's own record of which order the line on screen names. */
function lineHolderOf(run: Run): string | undefined {
  return (run.session as unknown as { lineHolder: string | undefined }).lineHolder;
}

describe('round 7: the earlier-payment line gives way only to its own holder', () => {
  it('another own order freeing leaves the line of the holder it names (A3, A9)', async () => {
    const run = await setup();
    await run.session.start();
    const held = await signingHeld(run);
    const mine = await only(run);
    const marker = mine.marker;
    if (marker === undefined) {
      throw new Error('no marker');
    }
    expect(run.session.resetOnClose()).toBe(true);
    // Another tab's attempt holds the product; this tab's own attempt was cleared there.
    const holder = await seed(mine, { orderId: ID('e'), createdAt: mine.createdAt + 1 });
    const cleared = await store.clearMarker(
      mine.orderId,
      mine.version,
      marker.attemptId,
      'ordered',
    );
    expect(cleared.ok).toBe(true);
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(holder.orderId);
    // The cleared order's follower narrows: it frees nothing the line names.
    await run.timers.tick(REPUBLISH_EVERY_MS);
    expect(internals(run.session).followers.get(mine.orderId)?.republish).toBeUndefined();
    expect(lineOf(run.last())?.phase).toBe('confirming');
    // Its wallet answers late (a decline): still nothing the line names.
    run.wallet.behaviour = 'reject';
    held.answer();
    await held.pressed;
    await settle();
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(holder.orderId);
  });

  it('another tab clears the holder’s marker: its line clears by itself (A16)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    const marked = await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    if (!marked.ok) {
      throw new Error('not marked');
    }
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(open.orderId);
    // The other tab's wallet declined before signing: its order is open again.
    const cleared = await store.clearMarker(
      open.orderId,
      marked.record.version,
      'another-tab',
      'ordered',
    );
    expect(cleared.ok).toBe(true);
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
  });

  it('the rail finds the holder’s payment the store already answered: its line clears (A14)', async () => {
    const run = await setup();
    const holder = await lineOfOtherTab(run);
    run.chain.dropSends = false;
    // Another tab heard the store first; this tab's two passes still read the copy from before.
    const answered = await store.update(holder.orderId, holder.version, { state: 'completed' });
    expect(answered.ok).toBe(true);
    run.spy.holdStale(1, holder.orderId, holder).release();
    run.spy.holdStale(1, holder.orderId, holder).release();
    await run.timers.tick(WATCH_EVERY_MS);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    await run.timers.tick(WATCH_EVERY_MS);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
  });

  it('a candidate another tab marks while the press reads it: its line clears once that attempt ends (A21)', async () => {
    const run = await setup();
    await run.session.start();
    const open = await openOrderBy(run);
    expect(internals(run.session).record).toBeUndefined();
    const requests = run.wallet.requests;
    // The candidate's own re-read, before it is adopted.
    const read = run.spy.hold('get', (args) => args[0] === open.orderId);
    const pressed = run.session.pay('Fake');
    await read.reached;
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    read.release();
    await pressed;
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(open.orderId);
    expect(run.wallet.requests).toBe(requests);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(open.orderId))?.state).toBe('ended-unpaid');
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
  });

  it('the silent order on screen marked while the press reads: its line clears once that attempt ends (A22)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    const read = run.spy.holdNth('forProduct', 2);
    const pressed = run.session.pay('Fake');
    await read.reached;
    await store.setMarker(open.orderId, open.version, {
      rail: 'solana',
      attemptId: 'another-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
      slot: '1',
    });
    read.release();
    await pressed;
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(open.orderId);
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(open.orderId))?.state).toBe('ended-unpaid');
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
  });

  it('a completion held behind the line shows once the line clears by itself (B3)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.timers.tick();
    await run.session.startOver();
    const ended = await only(run);
    expect(ended.state).toBe('ended-unpaid');
    // Another tab pays meanwhile, and its payment does not land yet.
    run.chain.nextBlockhash();
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    await storeSays(run, ended);
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(true);
    const holder = (await records(run)).find((record) => record.orderId !== ended.orderId);
    if (holder === undefined) {
      throw new Error('no holder');
    }
    const requests = run.wallet.requests;
    // The holder lands and the store answers it: the line clears, the held completion shows.
    run.chain.dropSends = false;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(holder.orderId))?.state).toBe('paid');
    await storeSays(run, holder);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(false);
    expect(run.wallet.requests).toBe(requests);
  });

  it('a product freed before a press’s line never clears that line (round 7 B12)', async () => {
    const run = await setup();
    const holder = await lineOfOtherTab(run);
    // As left by a holder freed earlier in the press, before the line below was drawn.
    (run.session as unknown as { exclusionFreed: boolean }).exclusionFreed = true;
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(holder.orderId);
  });
});

describe('round 8: a holder freed while its line is computed', () => {
  it('answered during the countdown read: the line it draws clears by itself (round 8 LOW)', async () => {
    const run = await setup();
    await run.session.start();
    // Another tab's payment for this product is out but not landed yet.
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const holder = await only(run);
    // The press's own countdown read (its second height read) is held.
    const countdown = holdRpc(run.chain.rpc, 'getEpochInfo', 2);
    run.deps.rpcFor = () => countdown.rpc;
    const pressed = run.session.pay('Fake');
    await countdown.reached;
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    // Meanwhile the holder lands and the store answers it: its follower stops.
    run.chain.dropSends = false;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(holder.orderId))?.state).toBe('paid');
    await storeSays(run, holder);
    expect((await store.get(holder.orderId))?.state).toBe('completed');
    expect(internals(run.session).followers.has(holder.orderId)).toBe(false);
    const requests = run.wallet.requests;
    countdown.release();
    await pressed;
    await settle();
    expect(run.views.some((view) => lineOf(view)?.phase === 'confirming')).toBe(true);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    expect(lineHolderOf(run)).toBeUndefined();
    expect(run.wallet.requests).toBe(requests);
  });
});

/**
 * A press paused at the holder's countdown read (its line about to be drawn),
 * the modal closed there, then the read answered: nothing more is drawn or told.
 */
async function closedAtCountdown(
  run: Run,
  pressed: Promise<void>,
  countdown: { reached: Promise<void>; release(): void },
) {
  await countdown.reached;
  expect(run.last()).toMatchObject({ kind: 'working' });
  closes(run);
  const later = after(run);
  countdown.release();
  await pressed;
  await settle();
  expect(later.views()).toEqual([]);
  expect(later.statuses()).toEqual([]);
  expect(lineHolderOf(run)).toBeUndefined();
  expect(run.wallet.requests).toBe(0);
}

/** A marker another tab set on `record`, its attempt live. */
async function markedElsewhere(run: Run, record: OrderRecord): Promise<OrderRecord> {
  const marked = await store.setMarker(record.orderId, record.version, {
    rail: 'solana',
    attemptId: 'another-tab',
    setAt: run.now(),
    blockhash: run.chain.blockhash,
    lastValidBlockHeight: String(run.chain.height + 150n),
    slot: '1',
  });
  if (!marked.ok) {
    throw new Error('not marked');
  }
  return marked.record;
}

/** The `nth` store read of `orderId` from now, held (and failing once opened, when `reject`). */
function holdRead(run: Run, orderId: string, nth: number, reject = false) {
  let seen = 0;
  return run.spy.hold(
    'get',
    (args) => {
      if (args[0] !== orderId) {
        return false;
      }
      seen += 1;
      return seen === nth;
    },
    reject,
  );
}

describe('round 9: the races around a line being drawn', () => {
  it('the silent order on screen marked during the connect: a close at its countdown draws no line (F23)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    await markedElsewhere(run, open);
    const countdown = holdRpc(run.chain.rpc, 'getEpochInfo');
    run.deps.rpcFor = () => countdown.rpc;
    connect.release();
    await closedAtCountdown(run, pressed, countdown);
  });

  it('a candidate marked while the press reads it: a close at its countdown draws no line (F24)', async () => {
    const run = await setup();
    await run.session.start();
    const open = await openOrderBy(run);
    expect(internals(run.session).record).toBeUndefined();
    const read = run.spy.hold('get', (args) => args[0] === open.orderId);
    const pressed = run.session.pay('Fake');
    await read.reached;
    await markedElsewhere(run, open);
    const countdown = holdRpc(run.chain.rpc, 'getEpochInfo');
    run.deps.rpcFor = () => countdown.rpc;
    read.release();
    await closedAtCountdown(run, pressed, countdown);
  });

  it('the store refuses the marker for an earlier payment: a close at its countdown draws no line (F32)', async () => {
    const run = await setup();
    await run.session.start();
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    run.chain.dropSends = true;
    const other = reload(run, {
      wallets: () => [{ name: 'Fake', connect: async () => run.wallet }],
    });
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const requests = run.wallet.requests;
    const refused = run.spy.hold('setMarker');
    connect.release();
    await refused.reached;
    const countdown = holdRpc(run.chain.rpc, 'getEpochInfo');
    run.deps.rpcFor = () => countdown.rpc;
    refused.release();
    await countdown.reached;
    expect(run.last()).toMatchObject({ kind: 'working' });
    closes(run);
    const later = after(run);
    countdown.release();
    await pressed;
    await settle();
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect(lineHolderOf(run)).toBeUndefined();
    expect(run.wallet.requests).toBe(requests);
  });

  it('a holder that became blocked before the refusal is read: followed, its line clears (F22)', async () => {
    const run = await setup();
    await run.session.start();
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    run.chain.dropSends = true;
    const other = reload(run, {
      wallets: () => [{ name: 'Fake', connect: async () => run.wallet }],
    });
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const holder = await only(run);
    expect(holder.marker).toBeDefined();
    const requests = run.wallet.requests;
    const refused = run.spy.hold('setMarker');
    connect.release();
    await refused.reached;
    // The store refuses the marker for the holder; the store blocks that payment before it is read.
    const read = run.spy.hold('get', (args) => args[0] === holder.orderId);
    refused.release();
    await read.reached;
    const current = await store.get(holder.orderId);
    if (current === undefined) {
      throw new Error('no holder');
    }
    await seed(current, { state: 'blocked', version: current.version + 1 });
    read.release();
    await pressed;
    await settle();
    expect(run.wallet.requests).toBe(requests);
    const follower = internals(run.session).followers.get(holder.orderId);
    expect(follower).toBeDefined();
    expect(follower?.republish).toBeDefined();
    expect(follower?.timer).toBeUndefined();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    expect(lineHolderOf(run)).toBeUndefined();
  });

  it('a holder’s re-read that resolves after another holder’s line is up leaves that line (F6)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const first = await only(run);
    // The re-read of the first holder once its line is up (after the press's own two reads).
    const readAgain = holdRead(run, first.orderId, 3);
    await run.session.pay('Fake');
    await readAgain.reached;
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(first.orderId);
    // Meanwhile the first is answered, and another attempt of this account holds the product.
    const answered = await store.update(first.orderId, first.version, { state: 'completed' });
    expect(answered.ok).toBe(true);
    const second = await seed(first, { orderId: ID('e'), createdAt: first.createdAt + 1 });
    await run.session.pay('Fake');
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(second.orderId);
    const later = after(run);
    readAgain.release();
    await settle();
    expect(later.views()).toEqual([]);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(second.orderId);
  });

  it('a holder’s re-read that fails leaves its line (F7)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const holder = await only(run);
    const readAgain = holdRead(run, holder.orderId, 3, true);
    await run.session.pay('Fake');
    await readAgain.reached;
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(holder.orderId);
    const later = after(run);
    readAgain.release();
    await settle();
    expect(later.views()).toEqual([]);
    expect(lineOf(run.last())?.phase).toBe('confirming');
    expect(lineHolderOf(run)).toBe(holder.orderId);
  });
});

/** Another account's attempt for this product, out and holding it. */
async function otherAccountHolds(run: Run, like: OrderRecord): Promise<OrderRecord> {
  const marker = like.marker;
  if (marker?.rail !== 'solana') {
    throw new Error('no Solana marker');
  }
  return seed(like, {
    orderId: ID('z'),
    createdAt: run.now(),
    customerRef: 'user_b',
    state: 'paying',
    marker: {
      ...marker,
      attemptId: 'user-b-tab',
      setAt: run.now(),
      blockhash: run.chain.blockhash,
      lastValidBlockHeight: String(run.chain.height + 150n),
    },
  });
}

function otherNoteOf(view: View | undefined) {
  return view?.kind === 'offer' && view.problem?.reason === 'other_purchase'
    ? view.problem
    : undefined;
}

describe('round 10: a product freed outside a press never clears a later press’s note', () => {
  it('freed during Start over: another account’s note met by the next press stays', async () => {
    const run = await setup();
    await run.session.start();
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    run.chain.dropSends = true;
    const other = reload(run, {
      wallets: () => [{ name: 'Fake', connect: async () => run.wallet }],
    });
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const holder = await only(run);
    connect.release();
    await pressed;
    expect(lineHolderOf(run)).toBe(holder.orderId);
    const record = internals(run.session).record;
    if (record === undefined) {
      throw new Error('no order on screen');
    }
    // Start over's read is held; meanwhile the holder's attempt is proven over and ended.
    const read = run.spy.hold('get', (args) => args[0] === record.orderId);
    const leaving = run.session.startOver();
    await read.reached;
    run.chain.dropSends = false;
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick(WATCH_EVERY_MS);
    expect((await store.get(holder.orderId))?.state).toBe('ended-unpaid');
    read.release();
    await leaving;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    // Another account's attempt holds the product now: the next press meets its note.
    await otherAccountHolds(run, holder);
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    await settle();
    expect(otherNoteOf(run.last())).toBeDefined();
  });

  it('freed during a press’s own delivery check: another account’s note met later in that press stays (round 10 LOW-1)', async () => {
    const run = await setup();
    await run.session.start();
    // This account's order is open on screen (the wallet could not pay it).
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    expect(open.state).toBe('ordered');
    expect(internals(run.session).record?.orderId).toBe(open.orderId);
    const accountHolds = (letter: string, customerRef: string) =>
      seed(open, {
        orderId: ID(letter),
        createdAt: run.now(),
        customerRef,
        state: 'paying',
        marker: {
          rail: 'solana',
          attemptId: `${customerRef}-tab`,
          setAt: run.now(),
          blockhash: run.chain.blockhash,
          lastValidBlockHeight: String(run.chain.height + 150n),
          slot: '1',
        },
      });
    // Another account's attempt X holds the product: the press meets its note.
    const holderX = await accountHolds('x', 'user_b');
    await run.session.pay('Fake');
    expect(otherNoteOf(run.last())).toBeDefined();
    expect(internals(run.session).followers.has(holderX.orderId)).toBe(true);
    // A completion of an earlier order of this account waits; the open order will not end.
    const delivered = await seed(open, {
      orderId: ID('c'),
      createdAt: open.createdAt - 10,
      state: 'completed',
    });
    internals(run.session).pendingAnswers.set(delivered.orderId, delivered);
    let refused = 0;
    run.spy.refuseWrites((method, args) => {
      if (method !== 'update' || args[0] !== open.orderId) {
        return false;
      }
      refused += 1;
      return true;
    });
    // The next press's delivery check is held at its read; meanwhile X stops holding.
    const read = run.spy.hold('get', (args) => args[0] === open.orderId);
    const pressed = run.session.pay('Fake');
    await read.reached;
    await seed(holderX, { state: 'completed', marker: undefined });
    await run.timers.tick(WATCH_EVERY_MS);
    expect(internals(run.session).followers.has(holderX.orderId)).toBe(false);
    // Another account's attempt Y holds it now: this press meets Y's refusal.
    const holderY = await accountHolds('y', 'user_c');
    read.release();
    await pressed;
    await settle();
    expect(refused).toBeGreaterThan(0);
    expect(internals(run.session).pendingAnswers.has(delivered.orderId)).toBe(true);
    expect(internals(run.session).followers.has(holderY.orderId)).toBe(true);
    expect(otherNoteOf(run.last())).toBeDefined();
  });

  it('freed during a press the buyer cancels: another account’s note met by the next press stays', async () => {
    const run = await setup();
    await run.session.start();
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    // As left by a product freed earlier in this press (the press never reaches its end).
    (run.session as unknown as { exclusionFreed: boolean }).exclusionFreed = true;
    run.session.cancel();
    connect.release();
    await pressed;
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    // That attempt of this account was answered; another account's attempt holds the product.
    const answered = await only(run);
    const completed = await store.update(answered.orderId, answered.version, {
      state: 'completed',
    });
    expect(completed.ok).toBe(true);
    await otherAccountHolds(run, answered);
    await run.session.pay('Fake');
    await settle();
    expect(otherNoteOf(run.last())).toBeDefined();
  });
});

/** A Solana attempt proven over: the retry screen, its order still paying. */
async function onRetryScreen(run: Run): Promise<OrderRecord> {
  run.wallet.behaviour = 'throw';
  await run.session.start();
  await run.session.pay('Fake');
  run.chain.expire();
  run.chain.nextBlockhash();
  await run.timers.tick();
  expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
  run.wallet.behaviour = 'sign';
  return only(run);
}

describe('round 11: the actions around a press', () => {
  it('Start over meets a payment that landed meanwhile: it follows that order, no retry left over it (L10)', async () => {
    const run = await setup();
    const order = await onRetryScreen(run);
    const read = run.spy.hold('get', (args) => args[0] === order.orderId);
    const leaving = run.session.startOver();
    await read.reached;
    // Another device pays it before Start over's end proves it over.
    await run.chain.injectPayment(JSON.parse(order.paymentRequest ?? '{}'));
    read.release();
    await leaving;
    await settle();
    expect((await only(run)).paidTx).toBeDefined();
    expect(run.statuses).not.toContain('ended');
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('Start over paused, a close, then Buy on the reopened modal: the press runs (L12)', async () => {
    const run = await setup();
    const order = await onRetryScreen(run);
    const read = run.spy.hold('get', (args) => args[0] === order.orderId);
    const leaving = run.session.startOver();
    await read.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const later = after(run);
    const pressed = run.session.pay('Fake');
    await settle();
    expect(later.views().length).toBeGreaterThan(0);
    read.release();
    await leaving;
    await pressed;
  });

  it('an answer held during the connect shows once the buyer cancels (C2)', async () => {
    const run = await setup();
    await onRetryScreen(run);
    await run.session.startOver();
    const ended = await only(run);
    expect(ended.state).toBe('ended-unpaid');
    const connect = connectHeld(run);
    const pressed = run.session.pay('Fake');
    await connect.reached;
    // The store delivers the ended order while the press waits on the wallet: held.
    await storeSays(run, ended);
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(true);
    run.session.cancel();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(internals(run.session).pendingAnswers.has(ended.orderId)).toBe(false);
    connect.release();
    await pressed;
  });

  it('an order the store cancelled during the retry’s connect never gets a retry (RT1)', async () => {
    const run = await setup();
    const order = await onRetryScreen(run);
    const requests = run.wallet.requests;
    const sent = run.chain.sent.length;
    const connect = connectHeld(run);
    const retried = run.session.retry('Fake');
    await connect.reached;
    await storeSays(run, order, CANCEL);
    expect((await only(run)).status?.status).toBe('cancelled');
    const later = after(run);
    connect.release();
    await retried;
    await settle();
    // The cancelled order shows as it is: no signing step is ever drawn for it.
    expect(later.views().some((view) => signingOf(view) !== undefined)).toBe(false);
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
    expect(run.wallet.requests).toBe(requests);
    expect(run.chain.sent).toHaveLength(sent);
    expect(solanaMarker(await only(run)).attemptId).toBe(solanaMarker(order).attemptId);
  });

  it('a press whose delivery check cannot read the store: "failed", and nothing more (N18)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    expect(internals(run.session).record?.orderId).toBe(open.orderId);
    const delivered = await seed(open, {
      orderId: ID('c'),
      createdAt: open.createdAt - 10,
      state: 'completed',
    });
    internals(run.session).pendingAnswers.set(delivered.orderId, delivered);
    const read = run.spy.hold('get', (args) => args[0] === open.orderId, true);
    const connects = run.connects();
    const pressed = run.session.pay('Fake');
    await read.reached;
    read.release();
    await pressed;
    await settle();
    expect(run.last()).toMatchObject({ problem: { reason: 'failed' } });
    expect(run.connects()).toBe(connects);
    expect(internals(run.session).pendingAnswers.has(delivered.orderId)).toBe(true);
  });
});

describe('round 13: a silent order another tab moves on is dropped unseen', () => {
  /** What the screen must still show: the plain offer, step 1, nothing told. */
  function stillStepOne(run: Run, later: ReturnType<typeof after>): void {
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    const shown = run.last();
    expect(shown).toMatchObject({ kind: 'offer' });
    expect(shown?.kind === 'offer' ? shown.problem : 'none').toBeUndefined();
  }

  /** Another tab of the same account pays `open`: its attempt is marked, waiting. */
  async function paidByOtherTab(run: Run, open: OrderRecord): Promise<void> {
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    expect((await store.get(open.orderId))?.state).toBe('paying');
  }

  /** Another tab ends `open` with nothing paid (Start over there). */
  async function endedByOtherTab(run: Run, open: OrderRecord): Promise<void> {
    const fresh = await store.get(open.orderId);
    if (fresh === undefined) {
      throw new Error('no order');
    }
    const ended = await endOrder(fresh, {
      store,
      readClient: run.relays,
      clientFor: () => run.relays,
      now: run.now,
      rpc: run.chain.rpc,
    });
    expect(ended.ended).toBe(true);
    expect(ended.record.state).toBe('ended-unpaid');
  }

  it('paid by another tab, then confirmed and completed: nothing drawn or told, the outcome stored quietly (R13-A)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    await paidByOtherTab(run, open);
    const later = after(run);
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    stillStepOne(run, later);
    const state = internals(run.session);
    expect(state.record).toBeUndefined();
    expect(state.listening).toBeUndefined();
    expect(state.quiet.has(open.orderId)).toBe(true);
    expect(state.followers.has(open.orderId)).toBe(true);
    await storeSays(run, open);
    stillStepOne(run, later);
    expect((await store.get(open.orderId))?.state).toBe('completed');
  });

  it('the same after a close: the hidden frame stays at step 1, the next Buy meets the earlier payment (R13-B)', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const open = await only(run);
    closes(run);
    expect(internals(run.session).silent).toBe(open.orderId);
    await paidByOtherTab(run, open);
    const later = after(run);
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    stillStepOne(run, later);
    expect(internals(run.session).quiet.has(open.orderId)).toBe(true);
    const requests = run.wallet.requests;
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'waiting_store' },
    });
    expect(run.wallet.requests).toBe(requests);
  });

  it('ended by another tab, a cancel, then a completion by hand: stored only, never drawn or told (R13-C)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    await endedByOtherTab(run, open);
    const later = after(run);
    await storeSays(run, open, CANCEL);
    stillStepOne(run, later);
    const state = internals(run.session);
    expect(state.record).toBeUndefined();
    expect(state.quiet.has(open.orderId)).toBe(true);
    expect(state.background.has(open.orderId)).toBe(true);
    await storeSays(run, open);
    stillStepOne(run, later);
    expect((await store.get(open.orderId))?.state).toBe('completed');
    expect(internals(run.session).pendingAnswers.has(open.orderId)).toBe(false);
  });

  it('the same after a close, with a confirmed status first (R13-D)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    closes(run);
    await endedByOtherTab(run, open);
    const later = after(run);
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    stillStepOne(run, later);
    await storeSays(run, open);
    stillStepOne(run, later);
    expect((await store.get(open.orderId))?.state).toBe('completed');
  });
});

describe('round 14: a silent order answered while it is followed or pressed', () => {
  it('its later answers are heard on the relays it was followed on, not the moved ones (R14-P2)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    const moved = ['wss://inbox-c.example.com', 'wss://inbox-d.example.com'];
    await run.relays.publish(INBOX, inboxList(run.shop.store, moved, NOW + 1));
    await run.session.start();
    await settle();
    expect(internals(run.session).silent).toBe(open.orderId);
    expect(internals(run.session).relays).toEqual([...moved, ...INBOX]);
    const fresh = await store.get(open.orderId);
    if (fresh === undefined) {
      throw new Error('no order');
    }
    expect(fresh.inboxRelays).toEqual(moved);
    // Ended by another tab with nothing paid (Start over there).
    const ended = await endOrder(fresh, {
      store,
      readClient: run.relays,
      clientFor: () => run.relays,
      now: run.now,
      rpc: run.chain.rpc,
    });
    expect(ended.ended).toBe(true);
    const later = after(run);
    await storeSays(run, open, CANCEL);
    await storeSays(run, open);
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
    expect((await store.get(open.orderId))?.state).toBe('completed');
  });

  it('paid by another tab while a press read an older copy: followed, its line shown, no wallet (R14-P1)', async () => {
    const run = await setup();
    const open = await openOrderBy(run);
    await run.session.start();
    expect(internals(run.session).silent).toBe(open.orderId);
    const stale = await store.get(open.orderId);
    if (stale === undefined) {
      throw new Error('no record');
    }
    const reread = run.spy.holdStale(1, open.orderId, stale);
    const requests = run.wallet.requests;
    const pressed = run.session.pay('Fake');
    await reread.reached;
    await backend.transactProduct(open.productAddress, () => ({
      write: [{ ...stale, version: stale.version + 1, state: 'paid', paidTx: '5'.repeat(88) }],
      result: undefined,
    }));
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    // Heard during the press: followed at once, in the background.
    expect(internals(run.session).followers.has(open.orderId)).toBe(true);
    reread.release();
    await pressed;
    expect(internals(run.session).followers.has(open.orderId)).toBe(true);
    expect(run.wallet.requests).toBe(requests);
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'earlier_payment', phase: 'waiting_store' },
    });
    expect(await records(run)).toHaveLength(1);
  });
});

/**
 * The session's next read of `orderId` made while `when` holds is answered by
 * `answer` instead (every other call goes to the store as it is).
 */
function readAnsweredBy(
  run: Run,
  orderId: string,
  when: () => boolean,
  answer: () => Promise<OrderRecord | undefined>,
) {
  const real = run.deps.store;
  let used = false;
  run.deps.store = new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (property !== 'get') {
        return value.bind(target);
      }
      return (id: string) => {
        if (!used && id === orderId && when()) {
          used = true;
          return answer();
        }
        return target.get(id);
      };
    },
  });
  return { used: () => used };
}

/** A silent order of this page, its press paused at its own re-read (an older copy). */
async function silentPressedAtReread(run: Run) {
  const open = await openOrderBy(run);
  await run.session.start();
  expect(internals(run.session).silent).toBe(open.orderId);
  const stale = await store.get(open.orderId);
  if (stale === undefined) {
    throw new Error('no record');
  }
  const reread = run.spy.holdStale(1, open.orderId, stale);
  const pressed = run.session.pay('Fake');
  await reread.reached;
  return { open, stale, reread, pressed };
}

/** The commit site's read of the silent order: the press has just dropped it from the screen. */
function atCommitSite(run: Run): boolean {
  return internals(run.session).record === undefined;
}

describe('round 15: the commit site and a line freed as a press ends', () => {
  it('marked by another tab while a press read an older copy: a close at its countdown draws no line (R15-C9)', async () => {
    const run = await setup();
    const { open, stale, reread, pressed } = await silentPressedAtReread(run);
    await markedElsewhere(run, stale);
    await storeSays(run, open, { status: 'confirmed', delivery: undefined });
    expect(internals(run.session).followers.has(open.orderId)).toBe(true);
    // The commit site's countdown read for the marked holder is held.
    const countdown = holdRpc(run.chain.rpc, 'getEpochInfo');
    run.deps.rpcFor = () => countdown.rpc;
    reread.release();
    await closedAtCountdown(run, pressed, countdown);
  });

  it('a close at the commit site’s read, then a new press: the old press draws nothing over it (R15-C4)', async () => {
    const run = await setup();
    const { open, reread, pressed } = await silentPressedAtReread(run);
    await storeSays(run, open);
    expect((await store.get(open.orderId))?.state).toBe('completed');
    const commit = run.spy.hold('get', (args) => args[0] === open.orderId && atCommitSite(run));
    reread.release();
    await commit.reached;
    closes(run);
    const connect = connectHeld(run);
    const later = after(run);
    const again = run.session.pay('Fake');
    await connect.reached;
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    commit.release();
    await pressed;
    await settle();
    expect(later.views().some((view) => view.kind === 'offer')).toBe(false);
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    run.chain.dropSends = true;
    connect.release();
    await again;
  });

  it('the order gone from the store at the commit site: the plain offer, never "failed" (R15-C5)', async () => {
    const run = await setup();
    const { open, reread, pressed } = await silentPressedAtReread(run);
    await storeSays(run, open);
    expect((await store.get(open.orderId))?.state).toBe('completed');
    const missing = readAnsweredBy(
      run,
      open.orderId,
      () => atCommitSite(run),
      async () => undefined,
    );
    const later = after(run);
    reread.release();
    await pressed;
    await settle();
    expect(missing.used()).toBe(true);
    expect(later.statuses()).toEqual([]);
    const shown = run.last();
    expect(shown).toMatchObject({ kind: 'offer' });
    expect(shown?.kind === 'offer' ? shown.problem : 'none').toBeUndefined();
    expect(internals(run.session).followers.has(open.orderId)).toBe(false);
    expect(run.wallet.requests).toBe(0);
  });

  it('a holder found freed just after the press’s guard ends: its line clears as the press ends (R15-O2)', async () => {
    const run = await setup();
    await run.session.start();
    // Another tab's payment for this product is out but not landed yet.
    run.chain.dropSends = true;
    const other = reload(run);
    await other.session.start();
    await other.session.pay('Fake');
    other.session.dispose();
    const holder = await only(run);
    const countdown = holdRpc(run.chain.rpc, 'getEpochInfo', 2);
    run.deps.rpcFor = () => countdown.rpc;
    const pressed = run.session.pay('Fake');
    await countdown.reached;
    // Meanwhile the holder lands and the store answers it: its follower stops.
    run.chain.dropSends = false;
    await run.timers.tick(WATCH_EVERY_MS);
    await run.timers.tick(WATCH_EVERY_MS);
    await storeSays(run, holder);
    const freed = await store.get(holder.orderId);
    expect(freed?.state).toBe('completed');
    expect(internals(run.session).followers.has(holder.orderId)).toBe(false);
    // The read once the line is up answers only once the guard let go of the press.
    let pressingWhenAnswered: boolean | undefined;
    const reread = readAnsweredBy(
      run,
      holder.orderId,
      () => true,
      () =>
        new Promise<OrderRecord | undefined>((resolve) => {
          let turns = 0;
          const poll = () => {
            turns += 1;
            if (internals(run.session).busy && turns < 10_000) {
              queueMicrotask(poll);
              return;
            }
            pressingWhenAnswered = internals(run.session).pressing;
            resolve(freed);
          };
          queueMicrotask(poll);
        }),
    );
    const requests = run.wallet.requests;
    countdown.release();
    await pressed;
    await settle();
    expect(reread.used()).toBe(true);
    expect(pressingWhenAnswered).toBe(true);
    expect(run.views.some((view) => lineOf(view)?.phase === 'confirming')).toBe(true);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(lineOf(run.last())).toBeUndefined();
    expect(lineHolderOf(run)).toBeUndefined();
    expect(run.wallet.requests).toBe(requests);
  });
});

describe('D5c: a detached placement and a moved background inbox', () => {
  it('a press after a close while the detached press is still placing its order: never two open orders', async () => {
    const run = await setup();
    await run.session.start();
    const held = run.spy.hold('add');
    const first = run.session.pay('Fake');
    await held.reached;
    expect(run.session.resetOnClose()).toBe(true);
    // The buyer opens the modal again and presses Buy while the first order is being placed.
    const second = run.session.pay('Fake');
    await settle();
    held.release();
    await Promise.all([first, second]);
    await settle();
    const all = await records(run);
    const open = all.filter((record) => record.state === 'ordered' && record.marker === undefined);
    // Paid: one order. Open beside it and never ended: none.
    expect(all.filter((record) => record.marker !== undefined)).toHaveLength(1);
    expect(open).toEqual([]);
  });

  it('a close while a press waits on a detached placement leaves bookkeeping only; the next press pays that order', async () => {
    const run = await setup();
    await run.session.start();
    const held = run.spy.hold('add');
    const first = run.session.pay('Fake');
    await held.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const second = run.session.pay('Fake');
    await settle();
    // Closed again while the second press waits for the first one's placement.
    closes(run);
    held.release();
    await Promise.all([first, second]);
    await settle();
    const [placed] = await records(run);
    expect(await records(run)).toHaveLength(1);
    expect(placed).toMatchObject({ state: 'ordered' });
    expect(placed?.marker).toBeUndefined();
    expect(run.wallet.requests).toBe(0);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    // The next press adopts the stored order and pays it: still one order.
    await run.session.pay('Fake');
    await settle();
    const paid = await only(run);
    expect(paid.orderId).toBe(placed?.orderId);
    expect(paid.marker).toBeDefined();
  });

  it('a detached placement that never settles holds the next press only for PLACING_WAIT_MS', async () => {
    const run = await setup();
    await run.session.start();
    run.spy.hold('add');
    void run.session.pay('Fake');
    await settle();
    expect(run.session.resetOnClose()).toBe(true);
    let done = false;
    const second = run.session.pay('Fake').then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    expect(run.timers.count(PLACING_WAIT_MS)).toBe(1);
    await run.timers.tick(PLACING_WAIT_MS);
    await second;
    expect(run.timers.count(PLACING_WAIT_MS)).toBe(0);
    const paid = await only(run);
    expect(paid.marker).toBeDefined();
  });

  it("PLACING_WAIT_MS covers a placement's own relay deadlines: the inbox read, then the publish", () => {
    expect(PLACING_WAIT_MS).toBeGreaterThanOrEqual(
      RELAY_QUERY_DEADLINE_MS + RELAY_PUBLISH_DEADLINE_MS,
    );
  });

  it('a detached placement that fails frees the next press at once, without the timer', async () => {
    const run = await setup();
    await run.session.start();
    const held = run.spy.hold('add', () => true, true);
    const first = run.session.pay('Fake');
    await held.reached;
    expect(run.session.resetOnClose()).toBe(true);
    let done = false;
    const second = run.session.pay('Fake').then(() => {
      done = true;
    });
    await settle();
    held.release();
    await first.catch(() => undefined);
    await settle();
    await settle();
    // No PLACING_WAIT_MS tick: the failed placement alone ends the wait.
    expect(done).toBe(true);
    await second;
    const paid = await only(run);
    expect(paid.marker).toBeDefined();
  });

  it('a placement that outlived the wait never clears the placement that replaced it', async () => {
    const run = await setup();
    await run.session.start();
    const heldFirst = run.spy.hold('add');
    const first = run.session.pay('Fake');
    await heldFirst.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const heldSecond = run.spy.holdNth('add', 1);
    const second = run.session.pay('Fake');
    await settle();
    // The second press stops waiting and places its own order, which hangs.
    await run.timers.tick(PLACING_WAIT_MS);
    await heldSecond.reached;
    // The first placement ends late; the second one is still placing.
    heldFirst.release();
    await first;
    await settle();
    expect(run.session.resetOnClose()).toBe(true);
    const third = run.session.pay('Fake');
    await settle();
    heldSecond.release();
    await Promise.all([second, third]);
    await settle();
    const all = await records(run);
    expect(all.filter((record) => record.marker !== undefined)).toHaveLength(1);
    expect(
      all.filter((record) => record.state === 'ordered' && record.marker === undefined),
    ).toEqual([]);
  });

  it('a press closed while it waits leaves the placement for the next press to wait on', async () => {
    const run = await setup();
    await run.session.start();
    const held = run.spy.hold('add');
    const first = run.session.pay('Fake');
    await held.reached;
    expect(run.session.resetOnClose()).toBe(true);
    const second = run.session.pay('Fake');
    await settle();
    // Closed again while the second press waits; a third press must still wait for the first.
    expect(run.session.resetOnClose()).toBe(true);
    const third = run.session.pay('Fake');
    await settle();
    held.release();
    await Promise.all([first, second, third]);
    await settle();
    const all = await records(run);
    expect(all.filter((record) => record.marker !== undefined)).toHaveLength(1);
    expect(
      all.filter((record) => record.state === 'ordered' && record.marker === undefined),
    ).toEqual([]);
  });

  it('a background follower moves its listener on a second move to as many relays as before', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    const paid = await only(run);
    closes(run);
    await settle();
    // The store moves twice; the second move keeps the count of relays heard on.
    run.relays.publish(INBOX, inboxList(run.shop.store, ['wss://moved-1.example.com'], NOW + 5));
    await run.timers.tick(REPUBLISH_EVERY_MS);
    const second = ['wss://moved-2.example.com'];
    run.relays.publish(INBOX, inboxList(run.shop.store, second, NOW + 6));
    await run.timers.tick(REPUBLISH_EVERY_MS);
    const later = after(run);
    const status = {
      type: 'status',
      buyerPubkey: paid.buyerPubkey,
      orderId: paid.orderId,
      status: 'completed',
    } as OrderMessage;
    await run.relays.publish(
      second,
      wrapOrderMessage(
        buildOrderMessage(status, NOW + 100),
        run.shop.store.secretKey,
        paid.buyerPubkey,
      ).recipientWrap,
    );
    await settle();
    expect((await store.get(paid.orderId))?.state).toBe('completed');
    expect(later.views()).toEqual([]);
    expect(later.statuses()).toEqual([]);
  });
});
