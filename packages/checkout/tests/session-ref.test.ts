/**
 * Two accounts in one browser: a page with a customer reference sees, resumes
 * and reports only its own account's orders. Another account's orders are
 * still resolved in the background (store answers, chain verdicts), silently.
 */
import { type OrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import { type LoadedOffer, type OrderRecord, OrderStore, loadOffer } from '@elisym/commerce/buyer';
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
import { type LoadDeps, followOnlyOffer, openPage } from '../src/app/controller';
import { HELD_CLASS } from '../src/app/page';
import { REF_NEEDS_VERIFIED_STORE } from '../src/app/ref-scope';
import {
  type Banner,
  CheckoutSession,
  MAX_ENDED_LISTENERS,
  type SessionDeps,
  type View,
} from '../src/app/session';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import type { CheckoutParams, CheckoutState } from '../src/embed/protocol';
import { framePage } from './page-harness';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())));
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
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The fixture store is level C (no domain): a reference page needs level A on its domain. */
function levelA(offer: Ready): Ready {
  return { ...offer, offer: { ...offer.offer, level: 'A', domain: 'merchant.example' } };
}

/** One browser: one store of orders, one shop, one chain, one wallet, one clock. */
async function browser(shop: Shop = makeShop()) {
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
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
    return loaded;
  };
  const offer = levelA(await load(NOW));
  const wallet = await FakeWallet.create();
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.blockTime = NOW + 60;
  const timers = new Timers();
  let clock = NOW + 30;
  return {
    shop,
    relays,
    offer,
    wallet,
    chain,
    timers,
    load,
    now: () => clock,
    advance: (seconds: number) => {
      clock += seconds;
    },
  };
}

type Browser = Awaited<ReturnType<typeof browser>>;

/** A page of `world` for the account `customerRef` (none: a page without a reference). */
function page(
  world: Browser,
  customerRef: string | undefined,
  options: { offer?: Ready; reload?: (offer: Ready) => Ready } = {},
) {
  const views: View[] = [];
  const statuses: CheckoutState[] = [];
  const banners: Banner[] = [];
  const reload = options.reload ?? levelA;
  const deps: SessionDeps = {
    store,
    readClient: world.relays,
    clientFor: () => world.relays,
    rpcFor: () => world.chain.rpc,
    wallets: () => [{ name: 'Fake', connect: async () => world.wallet }],
    reloadOffer: async () => reload(await world.load(world.now())),
    now: world.now,
    chainTime: async () => world.now(),
    setInterval: world.timers.set,
    clearInterval: world.timers.clear,
    setTimeout: world.timers.set,
    clearTimeout: world.timers.clear,
    onView: (view) => views.push(view),
    onStatus: (state) => statuses.push(state),
    onBanner: (banner) => banners.push(banner),
    ...(customerRef === undefined ? {} : { customerRef }),
  };
  const session = new CheckoutSession(options.offer ?? world.offer, deps);
  return { session, views, statuses, banners, deps, last: () => views.at(-1) };
}

async function all(world: Browser): Promise<OrderRecord[]> {
  return store.forProduct(world.offer.productAddress);
}

async function only(world: Browser, customerRef: string | undefined): Promise<OrderRecord> {
  const found = (await all(world)).filter((record) => record.customerRef === customerRef);
  const [record] = found;
  if (found.length !== 1 || record === undefined) {
    throw new Error(`expected one order of ${customerRef ?? 'no account'}, found ${found.length}`);
  }
  return record;
}

/** The store's status for `record`, published where the widget listens. */
async function storeSays(world: Browser, record: OrderRecord, message: Partial<OrderMessage> = {}) {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course' },
    ...message,
  } as OrderMessage;
  await world.relays.publish(
    INBOX,
    wrapOrderMessage(
      buildOrderMessage(status, NOW + 100),
      world.shop.store.secretKey,
      record.buyerPubkey,
    ).recipientWrap,
  );
  await settle();
}

/** Nothing of another account's order on this page: no view of it, no status, no banner. */
function sawNothingOf(shown: ReturnType<typeof page>, record: OrderRecord): void {
  expect(shown.banners).toEqual([]);
  expect(shown.statuses.every((state) => state === 'ready' || state === 'ordered')).toBe(true);
  for (const view of shown.views) {
    expect(view.kind === 'offer' || view.kind === 'working').toBe(true);
    if (view.kind === 'working') {
      expect(view.paying?.amount).not.toBe(undefined);
    }
  }
  const shownText = JSON.stringify(shown.views, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  expect(shownText).not.toContain(record.orderId);
}

/** An order of `customerRef`, paid on chain and waiting for the store. */
async function paidOrder(world: Browser, customerRef: string | undefined): Promise<OrderRecord> {
  const shown = page(world, customerRef);
  await shown.session.start();
  await shown.session.pay('Fake');
  await world.timers.tick();
  shown.session.dispose();
  const record = await only(world, customerRef);
  expect(record.state).toBe('paid');
  return record;
}

/** An order of `customerRef` whose attempt is out but not landed (the chain drops it). */
async function payingOrder(world: Browser, customerRef: string | undefined): Promise<OrderRecord> {
  world.chain.dropSends = true;
  const shown = page(world, customerRef);
  await shown.session.start();
  await shown.session.pay('Fake');
  shown.session.dispose();
  world.chain.dropSends = false;
  const record = await only(world, customerRef);
  expect(record.state).toBe('paying');
  return record;
}

describe('a page with a customer reference', () => {
  it('places its order with the reference', async () => {
    const world = await browser();
    const shown = page(world, 'user_b');
    await shown.session.start();
    await shown.session.pay('Fake');
    expect((await only(world, 'user_b')).customerRef).toBe('user_b');
  });

  it('never places an order on an offer that is not level A', async () => {
    const world = await browser();
    const levelC: Ready = { ...world.offer, offer: { ...world.offer.offer, level: 'C' } };
    const shown = page(world, 'user_b', { offer: levelC, reload: (offer) => offer });
    await shown.session.start();
    await shown.session.pay('Fake');
    expect(shown.last()).toMatchObject({ kind: 'refused', message: REF_NEEDS_VERIFIED_STORE });
    expect(shown.statuses.at(-1)).toBe('refused');
    expect(await all(world)).toEqual([]);
    expect(world.wallet.requests).toBe(0);
  });

  it('refuses when the offer verified again before paying is no longer level A', async () => {
    const world = await browser();
    const shown = page(world, 'user_b', { reload: (offer) => offer });
    await shown.session.start();
    // Older than two minutes: verified again before anything is paid.
    world.advance(200);
    await shown.session.pay('Fake');
    expect(shown.last()).toMatchObject({ kind: 'refused', message: REF_NEEDS_VERIFIED_STORE });
    expect(await all(world)).toEqual([]);
    expect(world.wallet.requests).toBe(0);
  });

  it('never continues its open order on an offer verified again below level A', async () => {
    const world = await browser();
    let level: 'A' | 'C' = 'A';
    const shown = page(world, 'user_b', {
      reload: (offer) => (level === 'A' ? levelA(offer) : offer),
    });
    await shown.session.start();
    world.wallet.behaviour = 'reject';
    await shown.session.pay('Fake');
    world.wallet.behaviour = 'sign';
    expect((await only(world, 'user_b')).state).toBe('ordered');
    level = 'C';
    world.advance(200);
    await shown.session.pay('Fake');
    expect(shown.last()).toMatchObject({ kind: 'refused', message: REF_NEEDS_VERIFIED_STORE });
    expect(world.wallet.requests).toBe(1);
    expect((await only(world, 'user_b')).state).toBe('ordered');
  });

  it('never shows another account’s delivered order, and buys anew for its own', async () => {
    const world = await browser();
    const theirs = await paidOrder(world, 'user_a');
    await storeSays(world, theirs);
    const shown = page(world, 'user_b');
    await shown.session.start();
    await world.timers.tick();
    // Their delivery is heard here (in the background) and stored, never shown.
    expect((await only(world, 'user_a')).state).toBe('completed');
    expect(shown.last()).toMatchObject({ kind: 'offer', continuing: false });
    expect(shown.statuses).toEqual(['ready']);
    sawNothingOf(shown, theirs);
    await shown.session.pay('Fake');
    expect((await only(world, 'user_b')).orderId).not.toBe(theirs.orderId);
    // Their own page still shows their delivery.
    const own = page(world, 'user_a');
    await own.session.start();
    expect(own.last()).toMatchObject({ kind: 'delivered' });
  });

  it('never continues another account’s open order: a press places its own', async () => {
    const world = await browser();
    world.wallet.behaviour = 'reject';
    const theirs = page(world, 'user_a');
    await theirs.session.start();
    await theirs.session.pay('Fake');
    theirs.session.dispose();
    world.wallet.behaviour = 'sign';
    const open = await only(world, 'user_a');
    expect(open.state).toBe('ordered');
    const shown = page(world, 'user_b');
    await shown.session.start();
    expect(shown.last()).toMatchObject({ kind: 'offer', continuing: false });
    await shown.session.pay('Fake');
    expect((await only(world, 'user_b')).orderId).not.toBe(open.orderId);
    // The other account's open order is untouched, and still theirs to continue.
    expect((await only(world, 'user_a')).state).toBe('ordered');
    const again = page(world, 'user_a');
    await again.session.start();
    expect(again.last()).toMatchObject({ kind: 'offer', continuing: 'ordered' });
  });

  it('a page without a reference sees no order that carries one (and the reverse)', async () => {
    const world = await browser();
    const theirs = await paidOrder(world, 'user_a');
    const plain = page(world, undefined);
    await plain.session.start();
    expect(plain.last()).toMatchObject({ kind: 'offer' });
    sawNothingOf(plain, theirs);
  });

  it('resolves another account’s paying order silently: its answer never reaches the page', async () => {
    const world = await browser();
    const theirs = await paidOrder(world, 'user_a');
    const shown = page(world, 'user_b');
    await shown.session.start();
    await world.timers.tick();
    await storeSays(world, theirs);
    await world.timers.tick();
    // Stored by this page's background follower, shown nowhere.
    expect((await only(world, 'user_a')).state).toBe('completed');
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    sawNothingOf(shown, theirs);
  });
});

describe('another account holding the product in this browser', () => {
  it('a neutral note, then the offer once their attempt is proven over and ended', async () => {
    const world = await browser();
    const theirs = await payingOrder(world, 'user_a');
    // Their transaction never lands, even rebroadcast by this page's follower.
    world.chain.dropSends = true;
    const shown = page(world, 'user_b');
    await shown.session.start();
    await shown.session.pay('Fake');
    expect(shown.last()).toMatchObject({ kind: 'offer', problem: { reason: 'other_purchase' } });
    expect(world.wallet.requests).toBe(1);
    sawNothingOf(shown, theirs);
    // Their attempt expires with nothing landed: the follower ends it.
    world.chain.expire();
    world.chain.nextBlockhash();
    await world.timers.tick();
    await world.timers.tick();
    world.chain.dropSends = false;
    expect((await only(world, 'user_a')).state).toBe('ended-unpaid');
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.last()).not.toHaveProperty('problem');
    await shown.session.pay('Fake');
    await world.timers.tick();
    expect(world.wallet.requests).toBe(2);
    expect((await only(world, 'user_b')).state).toBe('paid');
    sawNothingOf({ ...shown, statuses: [], views: [] }, theirs);
  });

  it('their order paid and answered by the store: then this account can buy', async () => {
    const world = await browser();
    const theirs = await paidOrder(world, 'user_a');
    const shown = page(world, 'user_b');
    await shown.session.start();
    await shown.session.pay('Fake');
    expect(shown.last()).toMatchObject({ kind: 'offer', problem: { reason: 'other_purchase' } });
    // No press running: a later follower tick that still finds it held keeps the note.
    await world.timers.tick();
    expect(shown.last()).toMatchObject({ kind: 'offer', problem: { reason: 'other_purchase' } });
    await storeSays(world, theirs);
    await world.timers.tick();
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.last()).not.toHaveProperty('problem');
    await shown.session.pay('Fake');
    await world.timers.tick();
    expect((await only(world, 'user_b')).state).toBe('paid');
    sawNothingOf({ ...shown, statuses: [], views: [] }, theirs);
    expect(shown.banners).toEqual([]);
  });

  it('an order from before references, still paying, is resolved silently on a reference page', async () => {
    const world = await browser();
    const old = await payingOrder(world, undefined);
    world.chain.dropSends = true;
    const shown = page(world, 'user_b');
    await shown.session.start();
    world.chain.expire();
    world.chain.nextBlockhash();
    await world.timers.tick();
    await world.timers.tick();
    world.chain.dropSends = false;
    expect((await only(world, undefined)).state).toBe('ended-unpaid');
    await shown.session.pay('Fake');
    await world.timers.tick();
    expect((await only(world, 'user_b')).state).toBe('paid');
    sawNothingOf({ ...shown, statuses: [], views: [] }, old);
  });

  it('freed while the press that met it is still running: the offer shows after the press', async () => {
    const world = await browser();
    await payingOrder(world, 'user_a');
    const theirs = await only(world, 'user_a');
    const shown = page(world, 'user_b');
    await shown.session.start();
    // The press reads their order once (the exclusion's holder); the follower's
    // next look comes as the note is drawn, inside that same press, and finds
    // it answered: free.
    const onView = shown.deps.onView;
    shown.deps.onView = (view) => {
      onView(view);
      if (view.kind === 'offer' && view.problem?.reason === 'other_purchase') {
        for (const handler of [...world.timers.running.values()]) {
          handler();
        }
      }
    };
    const get = store.get.bind(store);
    let looks = 0;
    store.get = (orderId: string) => {
      if (orderId === theirs.orderId) {
        looks += 1;
        if (looks >= 2) {
          return Promise.resolve({ ...theirs, state: 'completed' as const });
        }
      }
      return get(orderId);
    };
    try {
      await shown.session.pay('Fake');
      await settle();
    } finally {
      store.get = get;
    }
    const notes = shown.views.filter(
      (view) => view.kind === 'offer' && view.problem?.reason === 'other_purchase',
    );
    expect(notes).toHaveLength(1);
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.last()).not.toHaveProperty('problem');
  });

  it('stops following when the page is disposed', async () => {
    const world = await browser();
    await payingOrder(world, 'user_a');
    const shown = page(world, 'user_b');
    await shown.session.start();
    expect(world.timers.running.size).toBeGreaterThan(0);
    shown.session.dispose();
    expect(world.timers.running.size).toBe(0);
  });
});

describe('ended orders of another account', () => {
  /** An order of `customerRef` placed and left (declined, then started over): ended unpaid. */
  async function endedOrder(world: Browser, customerRef: string | undefined): Promise<OrderRecord> {
    world.wallet.behaviour = 'reject';
    const shown = page(world, customerRef);
    await shown.session.start();
    await shown.session.pay('Fake');
    await shown.session.startOver();
    shown.session.dispose();
    world.wallet.behaviour = 'sign';
    const ended = (await all(world)).filter(
      (record) => record.customerRef === customerRef && record.state === 'ended-unpaid',
    );
    const record = ended.at(-1);
    if (record === undefined) {
      throw new Error('no ended order');
    }
    return record;
  }

  it('a late delivery of another account’s ended order is stored, never shown', async () => {
    const world = await browser();
    const theirs = await endedOrder(world, 'user_a');
    const shown = page(world, 'user_b');
    await shown.session.start();
    await storeSays(world, theirs);
    expect((await only(world, 'user_a')).state).toBe('completed');
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    sawNothingOf(shown, theirs);
  });

  it('a late delivery of its own ended order still shows', async () => {
    const world = await browser();
    const own = await endedOrder(world, 'user_b');
    const shown = page(world, 'user_b');
    await shown.session.start();
    await storeSays(world, own);
    expect(shown.last()).toMatchObject({ kind: 'delivered' });
  });

  it('its own ended orders are heard first when the listeners are full', async () => {
    const world = await browser();
    const own = await endedOrder(world, 'user_b');
    for (let index = 0; index < MAX_ENDED_LISTENERS; index += 1) {
      world.advance(10);
      await endedOrder(world, `user_${index}`);
    }
    const shown = page(world, 'user_b');
    await shown.session.start();
    await storeSays(world, own);
    expect(shown.last()).toMatchObject({ kind: 'delivered' });
  });
});

describe('a refused page and the orders this browser has', () => {
  function params(world: Browser, customerRef?: string): CheckoutParams {
    return {
      naddr: world.shop.naddr,
      network: 'devnet',
      strictOrigin: false,
      theme: 'auto',
      collectEmail: false,
      display: 'modal',
      ...(customerRef === undefined ? {} : { customerRef }),
    };
  }

  function refusing(world: Browser): LoadDeps {
    return {
      client: world.relays,
      store,
      loadOffer: async () => ({ ok: false, refusal: 'no_payable_payout', message: 'none' }),
    };
  }

  it('without a reference, a refusal still follows an order of the product', async () => {
    const world = await browser();
    const plain = await paidOrder(world, undefined);
    expect(await openPage(params(world), PAGE, refusing(world))).toMatchObject({
      kind: 'offer',
      followOnly: { orderId: plain.orderId },
    });
  });

  it('with a reference, a refusal is all it shows: no order of any account', async () => {
    const world = await browser();
    // An order from before references (delivered), and one of this very account.
    await storeSays(world, await paidOrder(world, undefined));
    const plain = page(world, undefined);
    await plain.session.start();
    await world.timers.tick();
    plain.session.dispose();
    expect((await only(world, undefined)).state).toBe('completed');
    await paidOrder(world, 'user_b');
    expect(await openPage(params(world, 'user_b'), PAGE, refusing(world))).toEqual({
      kind: 'refused',
      screen: { kind: 'refused', reason: 'offer_refused', message: 'none' },
    });
  });

  it('a page without a reference never follows an order that carries one', async () => {
    const world = await browser();
    const theirs = await paidOrder(world, 'user_a');
    expect(await followOnlyOffer(world.shop.naddr, store, undefined)).toBeUndefined();
    expect(await followOnlyOffer(world.shop.naddr, store, 'user_a')).toMatchObject({
      orderId: theirs.orderId,
    });
  });
});

describe('what a page hears of a refusal, with or without an earlier order', () => {
  const refusingLoad: LoadDeps['loadOffer'] = async () => ({
    ok: false,
    refusal: 'no_payable_payout',
    message: 'none',
  });

  function params(world: Browser): CheckoutParams {
    return {
      naddr: world.shop.naddr,
      network: 'devnet',
      strictOrigin: false,
      theme: 'auto',
      collectEmail: false,
      display: 'modal',
    };
  }

  async function frame(world: Browser) {
    const run = await framePage({
      params: params(world),
      pageOrigin: PAGE,
      client: world.relays,
      store,
      loadOffer: refusingLoad,
      session: {
        readClient: world.relays,
        clientFor: () => world.relays,
        rpcFor: () => world.chain.rpc,
        wallets: () => [{ name: 'Fake', connect: async () => world.wallet }],
        reloadOffer: async () => world.load(world.now()),
        now: world.now,
        chainTime: async () => world.now(),
        setInterval: world.timers.set,
        clearInterval: world.timers.clear,
        setTimeout: world.timers.set,
        clearTimeout: world.timers.clear,
      },
    });
    // Time passes and the order moves on: the page still hears nothing new.
    await world.timers.tick();
    await world.timers.tick();
    await run.settle();
    return run;
  }

  async function noOrder(): Promise<string[]> {
    const world = await browser();
    const run = await frame(world);
    run.dispose();
    expect([...run.rootClasses]).toEqual([HELD_CLASS]);
    return run.heard;
  }

  it('a refusal with no order: one refused, then the refusal’s height', async () => {
    expect(await noOrder()).toEqual(['resize:60', 'status:refused', 'resize:180']);
  });

  const cases: [string, (world: Browser) => Promise<string>][] = [
    [
      'delivered',
      async (world) => {
        const record = await paidOrder(world, undefined);
        await storeSays(world, record);
        return 'delivered';
      },
    ],
    [
      'refunded',
      async (world) => {
        const record = await paidOrder(world, undefined);
        await storeSays(world, record, {
          status: 'cancelled',
          delivery: undefined,
          refund: { tx: 'refundTx', amount: record.amount },
        });
        return 'refunded';
      },
    ],
    [
      'paid',
      async (world) => {
        await paidOrder(world, undefined);
        return 'waiting_store';
      },
    ],
    [
      'paying',
      async (world) => {
        await payingOrder(world, undefined);
        world.chain.dropSends = true;
        return 'waiting_payment';
      },
    ],
  ];

  for (const [name, seed] of cases) {
    it(`an earlier ${name} order: the buyer sees it, the page hears exactly the no-order sequence`, async () => {
      const expected = await noOrder();
      const world = await browser();
      const viewKind = await seed(world);
      // A plain page, so the order's own answers are heard while it is followed.
      const plain = page(world, undefined);
      await plain.session.start();
      await world.timers.tick();
      plain.session.dispose();
      const run = await frame(world);
      expect(run.shown().view?.kind).toBe(viewKind);
      expect(run.heard).toEqual(expected);
      // Nothing at all after the session began: no animation frame kept posting.
      expect(run.heardAtRun).toEqual(run.heard);
      // Held the same way: its scrolling never chains to the page.
      expect([...run.rootClasses]).toEqual([HELD_CLASS]);
      run.dispose();
    });
  }

  it('an earlier order that cannot be read: the same refusal as none, never a failure', async () => {
    const expected = await noOrder();
    const world = await browser();
    await paidOrder(world, undefined);
    const forProduct = store.forProduct.bind(store);
    // A stored record the snapshot cannot be built from (a bad amount, say).
    store.forProduct = async () => {
      throw new SyntaxError('Cannot convert x to a BigInt');
    };
    try {
      const run = await frame(world);
      expect(run.shown().screen).toEqual({
        kind: 'refused',
        reason: 'offer_refused',
        message: 'none',
      });
      expect(run.heard).toEqual(expected);
    } finally {
      store.forProduct = forProduct;
    }
  });

  it('a start that fails after the refusal was told: still one refused', async () => {
    const world = await browser();
    await paidOrder(world, undefined);
    const run = await framePage({
      params: params(world),
      pageOrigin: PAGE,
      client: world.relays,
      store,
      loadOffer: refusingLoad,
      session: {} as never,
      run: async (_offer, _store, followOnly, onStatus) => {
        expect(followOnly).toBeDefined();
        onStatus('paid');
        throw new Error('storage failed');
      },
    });
    expect(run.heard).toEqual(['resize:60', 'status:refused', 'resize:180']);
    expect(run.shown().screen).toEqual({ kind: 'refused', reason: 'failed' });
  });

  it('refused is told before the follow-only session even starts', async () => {
    const world = await browser();
    await paidOrder(world, undefined);
    const heard: string[] = [];
    let heardAtRun: string[] = [];
    await framePage({
      params: params(world),
      pageOrigin: PAGE,
      client: world.relays,
      store,
      loadOffer: refusingLoad,
      session: {} as never,
      heard,
      run: async () => {
        heardAtRun = [...heard];
      },
    });
    expect(heardAtRun).toEqual(['resize:60', 'status:refused', 'resize:180']);
  });
});
