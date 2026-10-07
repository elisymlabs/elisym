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
import { gate } from './reset-harness';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';

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
    onBanner: (banner) => {
      if (banner !== undefined) {
        banners.push(banner);
      }
    },
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
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.statuses).toEqual(['ready']);
    sawNothingOf(shown, theirs);
    await shown.session.pay('Fake');
    expect((await only(world, 'user_b')).orderId).not.toBe(theirs.orderId);
    // Their own page starts a new purchase; their delivery is in its Your purchases.
    const own = page(world, 'user_a');
    await own.session.start();
    expect(own.last()).toMatchObject({ kind: 'offer' });
    expect(own.statuses).toEqual(['ready']);
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
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    await shown.session.pay('Fake');
    expect((await only(world, 'user_b')).orderId).not.toBe(open.orderId);
    // The other account's open order is untouched, and still theirs to continue.
    expect((await only(world, 'user_a')).state).toBe('ordered');
    const again = page(world, 'user_a');
    await again.session.start();
    expect(again.last()).toMatchObject({ kind: 'offer' });
    expect(again.statuses).toEqual(['ready']);
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

  it('the note stays when this account’s own background order is answered (round 5 LOW-2)', async () => {
    const world = await browser();
    const theirs = await payingOrder(world, 'user_a');
    // This account's blocked payment, followed in the background for its refund.
    const blocked: OrderRecord = {
      ...theirs,
      orderId: 'b'.repeat(64),
      customerRef: 'user_b',
      state: 'blocked',
      createdAt: theirs.createdAt - 10,
      version: 1,
    };
    await backend.transactProduct(blocked.productAddress, () => ({
      write: [blocked],
      result: undefined,
    }));
    world.chain.dropSends = true;
    const shown = page(world, 'user_b');
    await shown.session.start();
    await settle();
    await shown.session.pay('Fake');
    expect(shown.last()).toMatchObject({ kind: 'offer', problem: { reason: 'other_purchase' } });
    const views = shown.views.length;
    await storeSays(world, blocked, {
      status: 'cancelled',
      delivery: undefined,
      refund: { tx: '6'.repeat(88), amount: '49000000' },
    } as Partial<OrderMessage>);
    expect((await store.get(blocked.orderId))?.status?.status).toBe('cancelled');
    // Their order still holds the product: the note names it, and stays.
    expect((await store.get(theirs.orderId))?.state).toBe('paying');
    expect(shown.views.slice(views)).toEqual([]);
    expect(shown.last()).toMatchObject({ kind: 'offer', problem: { reason: 'other_purchase' } });
    world.chain.dropSends = false;
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

  it('a late delivery of its own ended order is stored after a reload, never shown (D1c)', async () => {
    const world = await browser();
    const own = await endedOrder(world, 'user_b');
    const shown = page(world, 'user_b');
    await shown.session.start();
    await storeSays(world, own);
    expect((await only(world, 'user_b')).state).toBe('completed');
    expect(shown.last()).toMatchObject({ kind: 'offer' });
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
    // Heard (and stored), though only quietly after a load.
    expect((await all(world)).find((record) => record.orderId === own.orderId)?.state).toBe(
      'completed',
    );
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

describe('a sold-out product', () => {
  const soldOut: LoadDeps['loadOffer'] = async () => ({
    ok: false,
    refusal: 'product_not_on_sale',
    message: 'The listing is sold-out',
  });

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

  /** How many times the page read this browser's orders of a product. */
  function countReads(): { reads: () => number; restore: () => void } {
    const forProduct = store.forProduct.bind(store);
    let reads = 0;
    store.forProduct = async (address) => {
      reads += 1;
      return forProduct(address);
    };
    return { reads: () => reads, restore: () => (store.forProduct = forProduct) };
  }

  async function frame(world: Browser, loadOfferFor: LoadDeps['loadOffer'] = soldOut) {
    const run = await framePage({
      params: params(world),
      pageOrigin: PAGE,
      client: world.relays,
      store,
      loadOffer: loadOfferFor,
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
    await world.timers.tick();
    await world.timers.tick();
    await run.settle();
    return run;
  }

  it('without a reference or an order: sold out, never the store text; the page hears refused', async () => {
    const world = await browser();
    expect(
      await openPage(params(world), PAGE, { client: world.relays, store, loadOffer: soldOut }),
    ).toEqual({
      kind: 'refused',
      screen: { kind: 'refused', reason: 'sold_out' },
    });
    const run = await frame(world);
    expect(run.shown().screen).toEqual({ kind: 'refused', reason: 'sold_out' });
    expect(run.heard).toEqual(['resize:60', 'status:refused', 'resize:180']);
    run.dispose();
  });

  it('without a reference and with a paid order: followed, and the page hears exactly a refusal', async () => {
    // The baseline is the same sold-out refusal with no order: the claim stands on its own.
    const plainWorld = await browser();
    const refusal = await frame(plainWorld);
    const expected = refusal.heard;
    refusal.dispose();
    const world = await browser();
    const record = await paidOrder(world, undefined);
    expect(
      await openPage(params(world), PAGE, { client: world.relays, store, loadOffer: soldOut }),
    ).toMatchObject({
      kind: 'offer',
      followOnly: {
        reason: 'sold_out',
        message: 'Sold out. This product is not available right now.',
        orderId: record.orderId,
      },
      refusal: { kind: 'refused', reason: 'sold_out' },
    });
    const run = await frame(world);
    expect(run.shown().view?.kind).toBe('waiting_store');
    expect(run.heard).toEqual(expected);
    expect(run.heardAtRun).toEqual(run.heard);
    run.dispose();
  });

  it('a reference page of a level A store whose product stopped: sold out, final, no order read', async () => {
    const world = await browser();
    await paidOrder(world, 'user_b');
    const counted = countReads();
    try {
      expect(
        await openPage(params(world, 'user_b'), PAGE, {
          client: world.relays,
          store,
          loadOffer: soldOut,
        }),
      ).toEqual({ kind: 'refused', screen: { kind: 'refused', reason: 'sold_out' } });
      expect(counted.reads()).toBe(0);
    } finally {
      counted.restore();
    }
  });

  it('a reference page off the store domain: still refused as such on sale, sold out once stopped', async () => {
    const world = await browser();
    await paidOrder(world, 'user_b');
    const counted = countReads();
    try {
      const offDomain: LoadDeps['loadOffer'] = async () => ({
        ok: false,
        refusal: 'origin_mismatch',
        message: 'not this domain',
      });
      expect(
        await openPage(params(world, 'user_b'), PAGE, {
          client: world.relays,
          store,
          loadOffer: offDomain,
        }),
      ).toEqual({
        kind: 'refused',
        screen: { kind: 'refused', reason: 'ref_needs_verified_store' },
      });
      expect(
        await openPage(params(world, 'user_b'), PAGE, {
          client: world.relays,
          store,
          loadOffer: soldOut,
        }),
      ).toEqual({ kind: 'refused', screen: { kind: 'refused', reason: 'sold_out' } });
      expect(counted.reads()).toBe(0);
    } finally {
      counted.restore();
    }
  });
});

describe('another account’s note (round 8)', () => {
  /** A copy of `record` as another account's tab would have left it: it holds the product. */
  async function heldBy(
    record: OrderRecord,
    customerRef: string,
    letter: string,
    changes: Partial<OrderRecord> = {},
  ): Promise<OrderRecord> {
    const seeded: OrderRecord = {
      ...record,
      orderId: letter.repeat(64),
      customerRef,
      version: 1,
      ...changes,
    };
    await backend.transactProduct(seeded.productAddress, () => ({
      write: [seeded],
      result: undefined,
    }));
    return seeded;
  }

  function noteOf(view: View | undefined): boolean {
    return view?.kind === 'offer' && view.problem?.reason === 'other_purchase';
  }

  /**
   * A press that meets `holder`'s note, and whose follower finds it answered while
   * that press still runs: a product freed during the press, its note cleared at the end.
   */
  async function freedDuringPress(
    world: Browser,
    shown: ReturnType<typeof page>,
    holder: OrderRecord,
  ) {
    const onView = shown.deps.onView;
    shown.deps.onView = (view) => {
      onView(view);
      if (noteOf(view)) {
        shown.deps.onView = onView;
        for (const handler of [...world.timers.running.values()]) {
          handler();
        }
      }
    };
    const get = store.get.bind(store);
    let looks = 0;
    store.get = (orderId: string) => {
      if (orderId === holder.orderId) {
        looks += 1;
        if (looks >= 2) {
          return Promise.resolve({ ...holder, state: 'completed' as const });
        }
      }
      return get(orderId);
    };
    return { restore: () => (store.get = get) };
  }

  it('freed while the retry that met it is still running: the offer shows after the retry (B14)', async () => {
    const world = await browser();
    const shown = page(world, 'user_b');
    await shown.session.start();
    // This account's attempt goes out, never lands, and provably ends: a retry is offered.
    world.chain.dropSends = true;
    await shown.session.pay('Fake');
    world.chain.expire();
    world.chain.nextBlockhash();
    await world.timers.tick();
    world.chain.dropSends = false;
    expect(shown.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    // Another account's attempt now holds the product: the retry's marker is refused.
    const theirs = await heldBy(await only(world, 'user_b'), 'user_a', 'a');
    const requests = world.wallet.requests;
    world.chain.dropSends = true;
    const freed = await freedDuringPress(world, shown, theirs);
    try {
      await shown.session.retry('Fake');
      await settle();
    } finally {
      freed.restore();
    }
    world.chain.dropSends = false;
    expect(world.wallet.requests).toBe(requests);
    expect(shown.views.filter((view) => noteOf(view))).toHaveLength(1);
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.last()).not.toHaveProperty('problem');
  });

  it('a holder that appears after the load is followed from the press: its note clears by itself (P10)', async () => {
    const world = await browser();
    const shown = page(world, 'user_b');
    await shown.session.start();
    // Another account pays after this page loaded: nothing here follows it yet.
    const theirs = await paidOrder(world, 'user_a');
    await shown.session.pay('Fake');
    expect(noteOf(shown.last())).toBe(true);
    await storeSays(world, theirs);
    await world.timers.tick();
    expect((await only(world, 'user_a')).state).toBe('completed');
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.last()).not.toHaveProperty('problem');
  });

  it('a holder freed during a press with no note up never clears the note that press then shows (N9)', async () => {
    const world = await browser();
    const theirs = await payingOrder(world, 'user_a');
    // A second account's paid order, followed from the load, holds the product too.
    const paid = await heldBy(theirs, 'user_c', 'c', { state: 'paid', paidTx: '5'.repeat(88) });
    world.chain.dropSends = true;
    const shown = page(world, 'user_b');
    await shown.session.start();
    await settle();
    // The press is held at its first read of the store, the working view on screen.
    const read = gate();
    const reached = gate();
    const forProduct = store.forProduct.bind(store);
    store.forProduct = async (productAddress: string) => {
      store.forProduct = forProduct;
      reached.open();
      await read.promise;
      return forProduct(productAddress);
    };
    const pressed = shown.session.pay('Fake');
    await reached.promise;
    expect(shown.last()).toMatchObject({ kind: 'working', step: 'checking' });
    // The second account's order is answered meanwhile: its follower sees it free.
    const answered = await store.update(paid.orderId, paid.version, { state: 'completed' });
    expect(answered.ok).toBe(true);
    await world.timers.tick();
    read.open();
    await pressed;
    await settle();
    // The first account's order still holds: its note stays.
    expect((await store.get(theirs.orderId))?.state).toBe('paying');
    expect(noteOf(shown.last())).toBe(true);
    world.chain.dropSends = false;
  });

  it('a product freed during one press never clears the note of a later press (N10)', async () => {
    const world = await browser();
    const theirs = await payingOrder(world, 'user_a');
    world.chain.dropSends = true;
    const shown = page(world, 'user_b');
    await shown.session.start();
    const freed = await freedDuringPress(world, shown, theirs);
    try {
      await shown.session.pay('Fake');
      await settle();
    } finally {
      freed.restore();
    }
    expect(shown.views.filter((view) => noteOf(view))).toHaveLength(1);
    expect(shown.last()).not.toHaveProperty('problem');
    // Their order is answered for real; a third account's attempt now holds the product.
    const stored = await store.get(theirs.orderId);
    if (stored === undefined) {
      throw new Error('no record');
    }
    expect((await store.update(stored.orderId, stored.version, { state: 'completed' })).ok).toBe(
      true,
    );
    const holder = await heldBy(theirs, 'user_d', 'd');
    await shown.session.pay('Fake');
    await settle();
    expect((await store.get(holder.orderId))?.state).toBe('paying');
    expect(noteOf(shown.last())).toBe(true);
    world.chain.dropSends = false;
  });

  it('a product freed by a press cut short by a close never clears the note of the next press (N16)', async () => {
    const world = await browser();
    const theirs = await payingOrder(world, 'user_a');
    world.chain.dropSends = true;
    const shown = page(world, 'user_b');
    await shown.session.start();
    const freed = await freedDuringPress(world, shown, theirs);
    // The modal closes right after the follower saw the product freed, before the press ends.
    const clear = shown.deps.clearInterval;
    let closed = false;
    shown.deps.clearInterval = (id) => {
      clear(id);
      if (!closed && shown.views.some((view) => noteOf(view))) {
        closed = true;
        queueMicrotask(() => {
          expect(shown.session.resetOnClose()).toBe(true);
        });
      }
    };
    try {
      await shown.session.pay('Fake');
      await settle();
    } finally {
      freed.restore();
      shown.deps.clearInterval = clear;
    }
    expect(closed).toBe(true);
    expect(shown.last()).toMatchObject({ kind: 'offer' });
    expect(shown.last()).not.toHaveProperty('problem');
    const stored = await store.get(theirs.orderId);
    if (stored === undefined) {
      throw new Error('no record');
    }
    expect((await store.update(stored.orderId, stored.version, { state: 'completed' })).ok).toBe(
      true,
    );
    const holder = await heldBy(theirs, 'user_d', 'd');
    await shown.session.pay('Fake');
    await settle();
    expect((await store.get(holder.orderId))?.state).toBe('paying');
    expect(noteOf(shown.last())).toBe(true);
    world.chain.dropSends = false;
  });
});
