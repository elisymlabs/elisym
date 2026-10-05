import { type OrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import { type LoadedOffer, loadOffer } from '@elisym/commerce/buyer';
import type { OrderRecord } from '@elisym/commerce/buyer';
import { OrderStore, endOrder } from '@elisym/commerce/buyer';
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
import {
  CHAIN_TIME_TIMEOUT_MS,
  RETRY_SETTLE_BLOCKS,
  SLOT_SECS_ESTIMATE,
  type SessionDeps,
  CheckoutSession,
  explorerLink,
  type View,
} from '../src/app/session';
import { receiptText } from '../src/app/ui/text';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import type { CheckoutState } from '../src/embed/protocol';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';

type Ready = Extract<LoadedOffer, { ok: true }>;

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())));
});

/** Intervals the test runs by hand. */
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

async function setup(
  options: { shop?: Shop; wallet?: FakeWallet; transform?: (offer: Ready) => Ready } = {},
) {
  const shop = options.shop ?? makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const transform = options.transform ?? ((offer: Ready) => offer);
  const offer = transform(await loaded(shop, relays));
  const wallet = options.wallet ?? (await FakeWallet.create());
  const chain = new FakeSolana(wallet.address, shop.payout);
  chain.blockTime = NOW + 60;
  const timers = new Timers();
  const views: View[] = [];
  const statuses: CheckoutState[] = [];
  let clock = NOW + 30;
  const deps: SessionDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => chain.rpc,
    wallets: () => [{ name: 'Fake', connect: async () => wallet }],
    reloadOffer: async () => transform(await loaded(shop, relays, clock)),
    now: () => clock,
    chainTime: async () => clock,
    setInterval: timers.set,
    clearInterval: timers.clear,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    onView: (view) => views.push(view),
    onStatus: (state) => statuses.push(state),
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
    deps,
    session,
    advance: (seconds: number) => {
      clock += seconds;
    },
    last: () => views.at(-1),
  };
}

/** The store's status for `record`, published to the relays the widget listens on. */
async function storeSays(
  shop: Shop,
  relays: MemoryRelays,
  record: OrderRecord,
  message: Partial<OrderMessage> = {},
) {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course' },
    ...message,
  } as OrderMessage;
  await relays.publish(
    INBOX,
    wrapOrderMessage(buildOrderMessage(status, NOW + 100), shop.store.secretKey, record.buyerPubkey)
      .recipientWrap,
  );
  await settle();
}

/** The same offer, verified again at `now`, one subunit dearer. */
function raised(offer: Ready, now: number): Ready {
  return {
    ...offer,
    snapshotAt: now,
    payouts: offer.payouts.map((payout) => ({ ...payout, amount: payout.amount + 1n })),
  };
}

const MAINNET_REFERENCE = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** The same offer with a mainnet copy of its payout listed first. */
function withMainnetFirst(offer: Ready): Ready {
  const [devnetPayout] = offer.payouts;
  if (devnetPayout === undefined) {
    throw new Error('no payout');
  }
  const { caip19 } = devnetPayout.target;
  return {
    ...offer,
    payouts: [
      {
        ...devnetPayout,
        target: {
          ...devnetPayout.target,
          caip19: {
            ...caip19,
            id: caip19.id.replace(/^solana:[^/]+/, `solana:${MAINNET_REFERENCE}`),
            chain: { ...caip19.chain, network: 'mainnet' },
          },
        },
      },
      ...offer.payouts,
    ],
  };
}

/** The one order placed so far, acknowledged and composed, with no attempt yet. */
async function placedFor(run: Awaited<ReturnType<typeof setup>>): Promise<OrderRecord> {
  const all = await store.forProduct(run.offer.productAddress);
  const record = all[0];
  if (all.length !== 1 || record === undefined) {
    throw new Error(`expected one order, found ${all.length}`);
  }
  return record;
}

async function recordOf(offer: Ready): Promise<OrderRecord> {
  const record = (await store.forProduct(offer.productAddress))[0];
  if (record === undefined) {
    throw new Error('no record');
  }
  return record;
}

describe('a purchase', () => {
  it('goes from the offer to the delivery, telling the page only state names', async () => {
    const run = await setup();
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'offer', continuing: false });
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store', cancelled: false });
    const record = await recordOf(run.offer);
    expect(record.state).toBe('paid');
    await storeSays(run.shop, run.relays, record);
    const { profile, level, domain } = run.offer.offer;
    const paid = await recordOf(run.offer);
    const paidTx = paid.paidTx;
    if (paidTx === undefined || paid.paidAt === undefined) {
      throw new Error('a paid record names its transaction and when it was found');
    }
    expect(run.last()).toEqual({
      kind: 'delivered',
      text: 'https://shop.example/course',
      link: 'https://shop.example/course',
      // The header keeps naming the store, with the level the offer has now.
      store: { name: profile.name, level, ...(domain === undefined ? {} : { domain }) },
      // The header names the product the order is for.
      product: {
        title: run.offer.offer.product.title,
        ...(run.offer.offer.product.summary === undefined
          ? {}
          : { summary: run.offer.offer.product.summary }),
        price: run.offer.offer.product.price,
      },
      // The receipt is the order's own: the payment rows because this checkout saw it.
      receipt: {
        store: profile.name,
        product: run.offer.offer.product.title,
        paying: {
          amount: paid.amount,
          asset: run.offer.payouts[0]?.target.caip19.asset,
          network: 'devnet',
          chain: 'solana',
        },
        orderId: paid.orderId,
        paid: {
          tx: paidTx,
          at: paid.paidAt,
          explorer: `https://explorer.solana.com/tx/${paidTx}?cluster=devnet`,
        },
        answeredAt: paid.status?.at,
      },
    });
    expect(run.statuses).toEqual(['ready', 'ordered', 'paying', 'paid', 'completed']);
    // Delivered: nothing keeps running.
    expect(run.timers.running.size).toBe(0);
  });

  it('pays with a confirm-class warning on the offer, and never asks for a tick', async () => {
    const shop = makeShop({ paytoCreatedAt: NOW - 60 });
    const run = await setup({ shop });
    expect(run.offer.confirm).toEqual(['payout_recently_changed']);
    await run.session.start();
    const offer = run.last();
    expect(offer).toMatchObject({ kind: 'offer' });
    expect(offer).not.toHaveProperty('confirm');
    expect(offer).not.toHaveProperty('confirmed');
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
  });

  it('says what is short, and opens no wallet', async () => {
    const run = await setup();
    run.chain.tokens = 1n;
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'insufficient_token', available: 1n },
    });
    expect(run.wallet.requests).toBe(0);
  });

  it('waits out a failed wallet, then offers a retry that pays the same order', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      canRetry: false,
      problem: { reason: 'wallet_failed' },
    });
    const first = await recordOf(run.offer);
    // The attempt expires; the next watch proves nothing landed.
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'sign';
    await run.session.retry('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    const after = await recordOf(run.offer);
    expect(after.orderId).toBe(first.orderId);
    expect(after.reference).toBe(first.reference);
  });

  it('resumes an open payment after a reload', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    // A new page load: the same store, a new session.
    run.chain.dropSends = false;
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect(run.wallet.requests).toBe(1);
  });

  it('follows an open payment on its own network when the store lists another first', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    run.chain.dropSends = false;
    // A new page load: the store now lists a mainnet payout first.
    const mainnetFirst = withMainnetFirst(run.offer);
    // The other network has never seen the payment, and its blockhash is long gone there.
    const otherChain = new FakeSolana(run.wallet.address, run.shop.payout);
    otherChain.expire();
    const asked: string[] = [];
    run.deps.rpcFor = (network) => {
      asked.push(network);
      return network === 'devnet' ? run.chain.rpc : otherChain.rpc;
    };
    const again = new CheckoutSession(mainnetFirst, run.deps);
    await again.start();
    await run.timers.tick();
    await again.startOver();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect((await recordOf(run.offer)).state).toBe('paid');
    expect(otherChain.calls).toEqual([]);
  });

  it('still follows an order on another network when the offer network is not served', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    run.chain.dropSends = false;
    const resumed = new CheckoutSession(withMainnetFirst(run.offer), {
      ...run.deps,
      rpcFor: (network) => (network === 'devnet' ? run.chain.rpc : undefined),
    });
    await resumed.start();
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    await resumed.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    // Following only: no offer (and no Pay button) is drawn over the paid order.
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('follows a paying order on a served network over a newer order that holds nothing', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    run.chain.dropSends = false;
    const paying = await recordOf(run.offer);
    // Another tab started an order it never got to pay: newer, and ranked with the paying one.
    const { marker: _marker, paymentRequest: _request, ...rest } = paying;
    await store.add({
      ...rest,
      orderId: 'f'.repeat(64),
      createdAt: paying.createdAt + 10,
      version: 1,
      state: 'created',
    });
    const resumed = new CheckoutSession(withMainnetFirst(run.offer), {
      ...run.deps,
      rpcFor: (network) => (network === 'devnet' ? run.chain.rpc : undefined),
    });
    await resumed.start();
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('shows a delivered order when no network is served', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    await storeSays(run.shop, run.relays, await recordOf(run.offer));
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    run.session.dispose();
    const again = new CheckoutSession(run.offer, { ...run.deps, rpcFor: () => undefined });
    await again.start();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('still hears an order that ended unpaid when no network is served', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.session.startOver();
    run.session.dispose();
    const ended = await recordOf(run.offer);
    expect(ended.state).toBe('ended-unpaid');
    const again = new CheckoutSession(run.offer, { ...run.deps, rpcFor: () => undefined });
    await again.start();
    expect(run.last()).toMatchObject({ kind: 'refused' });
    await storeSays(run.shop, run.relays, ended);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    // "Buy again" leaves the delivery for the refusal: no offer, nothing to pay.
    await again.startOver();
    expect(run.last()).toMatchObject({ kind: 'refused' });
  });

  it('refuses when neither the offer network nor the open order network is served', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    const resumed = new CheckoutSession(run.offer, { ...run.deps, rpcFor: () => undefined });
    await resumed.start();
    expect(run.last()).toMatchObject({ kind: 'refused' });
  });

  it('refuses when the offer network is not served and no order is open', async () => {
    const run = await setup();
    const session = new CheckoutSession(withMainnetFirst(run.offer), {
      ...run.deps,
      rpcFor: (network) => (network === 'devnet' ? run.chain.rpc : undefined),
    });
    await session.start();
    expect(run.last()).toMatchObject({ kind: 'refused' });
    await session.pay('Fake');
    expect(run.wallet.requests).toBe(0);
  });

  it('ends an acknowledged order on an unserved network before a new one elsewhere', async () => {
    const run = await setup();
    run.chain.tokens = 1n;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    const stuck = await recordOf(run.offer);
    expect(stuck.state).toBe('ordered');
    run.chain.tokens = 1_000_000_000n;
    const moved = new CheckoutSession(withMainnetFirst(run.offer), {
      ...run.deps,
      rpcFor: (network) => (network === 'mainnet' ? run.chain.rpc : undefined),
    });
    await moved.start();
    await moved.pay('Fake');
    expect((await store.get(stuck.orderId))?.state).toBe('ended-unpaid');
  });

  it('never frees a paying order on a network it cannot read', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    const paying = await recordOf(run.offer);
    expect(paying.state).toBe('paying');
    const moved = new CheckoutSession(withMainnetFirst(run.offer), {
      ...run.deps,
      rpcFor: (network) => (network === 'mainnet' ? run.chain.rpc : undefined),
    });
    await moved.start();
    await moved.startOver();
    await moved.pay('Fake');
    expect((await store.get(paying.orderId))?.state).toBe('paying');
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(1);
    expect(run.wallet.requests).toBe(1);
  });

  it('retries an order with the wallets of its own network', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    run.chain.expire();
    run.chain.nextBlockhash();
    run.wallet.behaviour = 'sign';
    const mainnetFirst = withMainnetFirst(run.offer);
    const otherChain = new FakeSolana(run.wallet.address, run.shop.payout);
    const resumed = new CheckoutSession(mainnetFirst, {
      ...run.deps,
      // The offer's network is served too: only the order's network may do its work.
      rpcFor: (network) => (network === 'devnet' ? run.chain.rpc : otherChain.rpc),
      wallets: (network) =>
        network === 'devnet' ? [{ name: 'Fake', connect: async () => run.wallet }] : [],
    });
    await resumed.start();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    expect(run.last()).toHaveProperty('wallets', [expect.objectContaining({ name: 'Fake' })]);
    await resumed.retry('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('keeps a retry on the waiting screen when the offer changed meanwhile', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.advance(600);
    run.deps.reloadOffer = async () => raised(run.offer, NOW + 630);
    const statusesBefore = run.statuses.length;
    await run.session.retry('Fake');
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      canRetry: true,
      problem: { reason: 'offer_changed' },
    });
    expect(run.statuses.slice(statusesBefore)).not.toContain('ordered');
    expect(run.wallet.requests).toBe(1);
  });

  it('goes back to the offer when the store changed its price, and asks again', async () => {
    const run = await setup();
    await run.session.start();
    // The snapshot is old; the same store now asks one subunit more.
    run.advance(600);
    run.deps.reloadOffer = async () => raised(run.offer, NOW + 630);
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'offer_changed' },
      payout: { amount: (run.offer.payouts[0]?.amount ?? 0n) + 1n },
    });
    expect(run.wallet.requests).toBe(0);
  });

  it('a warning that appears only on the re-verification changes nothing: the payment goes on', async () => {
    const run = await setup();
    await run.session.start();
    // Later: same price and payout, but a warning the first load did not have.
    run.advance(600);
    run.deps.reloadOffer = async () => ({
      ...run.offer,
      snapshotAt: NOW + 630,
      confirm: ['payout_changed'],
    });
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    expect(run.views.some((view) => view.kind === 'offer' && view.problem !== undefined)).toBe(
      false,
    );
  });

  it('hears the new order, not the one it abandoned for new terms', async () => {
    const run = await setup();
    await run.session.start();
    // Order 1 is acknowledged; the funds check stops it before any attempt.
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    // A buyer who came back later: the price changed, order 1 has to end.
    const first = await placedFor(run);
    run.advance(600);
    const fresh = raised(run.offer, NOW + 630);
    run.deps.reloadOffer = async () => fresh;
    await run.session.pay('Fake');
    // Back on the offer with the new price; paying again places order 2.
    await run.session.pay('Fake');
    await run.timers.tick();
    const all = await store.forProduct(run.offer.productAddress);
    const second = all.find((record) => record.orderId !== first.orderId);
    if (second === undefined) {
      throw new Error('no second order');
    }
    expect(all.find((record) => record.orderId === first.orderId)?.state).toBe('ended-unpaid');
    // The store answers order 2: the buyer sees it. Its answer to order 1 changes nothing.
    await storeSays(run.shop, run.relays, second);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    await storeSays(run.shop, run.relays, first, { status: 'cancelled', delivery: undefined });
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('follows the order that holds a live attempt when another tab tries to pay', async () => {
    const tabA = await setup();
    tabA.chain.dropSends = true;
    const tabB = new CheckoutSession(tabA.offer, {
      ...tabA.deps,
      onView: (view) => tabA.views.push(view),
    });
    await tabB.start();
    await tabA.session.start();
    await tabA.session.pay('Fake');
    await tabB.pay('Fake');
    // Tab B's own order never reached a wallet: it now watches tab A's attempt.
    expect(tabA.wallet.requests).toBe(1);
    expect(tabA.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false });
  });

  it('never runs two watch passes at once', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    let release: () => void = () => undefined;
    let listings = 0;
    run.chain.onList = () => {
      listings += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    void run.timers.tick();
    void run.timers.tick();
    await settle();
    expect(listings).toBe(1);
    release();
    await settle();
  });

  it('lets the buyer start a new order once the store cancelled an unpaid one', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const first = await placedFor(run);
    await storeSays(run.shop, run.relays, first, { status: 'cancelled', delivery: undefined });
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    await run.session.pay('Fake');
    const all = await store.forProduct(run.offer.productAddress);
    expect(all).toHaveLength(2);
    expect(run.wallet.requests).toBe(1);
  });

  it('never places a second order beside an attempt that can still land', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    // The store raised its price while the attempt is live.
    run.advance(600);
    run.deps.reloadOffer = async () => raised(run.offer, NOW + 630);
    await run.session.pay('Fake');
    await run.session.pay('Fake');
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(1);
    expect(run.wallet.requests).toBe(1);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
  });

  it('ends an order the store cancelled before paying for a new one', async () => {
    const run = await setup();
    await run.session.start();
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const first = await placedFor(run);
    await storeSays(run.shop, run.relays, first, { status: 'cancelled', delivery: undefined });
    // Paying again (without "start over") never reuses the cancelled order.
    await run.session.pay('Fake');
    const all = await store.forProduct(run.offer.productAddress);
    expect(all).toHaveLength(2);
    expect(all.find((record) => record.orderId === first.orderId)?.state).toBe('ended-unpaid');
    expect(run.wallet.requests).toBe(1);
  });

  it('drops a watch pass that outlived the order it started for', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    // The next watch pass hangs on the chain; meanwhile the buyer starts over.
    let release: () => void = () => undefined;
    let first = true;
    run.chain.onList = () => {
      if (!first) {
        return Promise.resolve();
      }
      first = false;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    void run.timers.tick();
    await settle();
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    release();
    await settle();
    // The late pass does not bring the ended order back on screen.
    expect(run.last()).toMatchObject({ kind: 'offer' });
  });

  it('keeps the retry open when a retry is refused before the wallet opens', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'sign';
    run.chain.tokens = 1n;
    await run.session.retry('Fake');
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      canRetry: true,
      problem: { reason: 'insufficient_token' },
    });
    run.chain.tokens = 1_000_000_000n;
    await run.session.retry('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('never lets a late watch pass cover a delivery that came first', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    let release: () => void = () => undefined;
    run.chain.onList = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    void run.timers.tick();
    await settle();
    // The store saw the payment first and delivers while the pass hangs.
    await storeSays(run.shop, run.relays, await recordOf(run.offer));
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    release();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(run.statuses.at(-1)).toBe('completed');
  });

  it('frees the product when another tab ended the order', async () => {
    const tabA = await setup();
    tabA.wallet.behaviour = 'throw';
    await tabA.session.start();
    await tabA.session.pay('Fake');
    const viewsB: View[] = [];
    const tabB = new CheckoutSession(tabA.offer, {
      ...tabA.deps,
      onView: (view) => viewsB.push(view),
    });
    await tabB.start();
    tabA.chain.expire();
    await tabA.session.startOver();
    // Tab B's next pass reads the ended order: back to the offer, not a retry loop.
    await tabA.timers.tick();
    // Tab B saw its attempt over before tab A ended the order; its retry finds the order
    // ended and goes back to the offer, opening no wallet.
    const requests = tabA.wallet.requests;
    await tabB.retry('Fake');
    expect(viewsB.at(-1)).toMatchObject({ kind: 'offer' });
    expect(tabA.wallet.requests).toBe(requests);
  });

  it('starts over from a cancelled order the store never acknowledged', async () => {
    const run = await setup();
    run.relays.refuse = INBOX;
    await run.session.start();
    await run.session.pay('Fake');
    run.relays.refuse = [];
    const first = await placedFor(run);
    expect(first.state).toBe('created');
    await storeSays(run.shop, run.relays, first, { status: 'cancelled', delivery: undefined });
    // Still unacknowledged on the next load; the stored cancellation is heard there.
    run.relays.refuse = INBOX;
    await run.session.start();
    await settle();
    expect((await recordOf(run.offer)).state).toBe('created');
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'offer' });
  });

  it('offers only a new order when the store cancelled during an attempt that ended', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const record = await recordOf(run.offer);
    await storeSays(run.shop, run.relays, record, { status: 'cancelled', delivery: undefined });
    run.chain.expire();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
  });

  it('keeps a refusal on screen when a wallet registers late', async () => {
    const run = await setup();
    run.deps.rpcFor = () => undefined;
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'refused' });
    run.session.refresh();
    expect(run.last()).toMatchObject({ kind: 'refused' });
    expect(run.statuses).toEqual(['refused']);
  });

  it('shows a delivery that arrives for an order that ended unpaid', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    expect(ended.state).toBe('ended-unpaid');
    // The store delivers it after all (a payment it found): the buyer sees it.
    await storeSays(run.shop, run.relays, ended);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('hears an order that ended unpaid again after a reload', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.session.startOver();
    run.session.dispose();
    const ended = await recordOf(run.offer);
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    await storeSays(run.shop, run.relays, ended);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('keeps a problem on the offer when a wallet registers late', async () => {
    const run = await setup();
    run.chain.tokens = 1n;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.refresh();
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'insufficient_token' },
    });
  });

  it('shows the live attempt, not "nothing was paid", once another tab made a new one', async () => {
    const tabA = await setup();
    tabA.wallet.behaviour = 'throw';
    await tabA.session.start();
    await tabA.session.pay('Fake');
    tabA.chain.expire();
    tabA.chain.nextBlockhash();
    await tabA.timers.tick();
    expect(tabA.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    // Tab B retries the same order; its attempt is live.
    const viewsB: View[] = [];
    const tabB = new CheckoutSession(tabA.offer, {
      ...tabA.deps,
      onView: (view) => viewsB.push(view),
    });
    await tabB.start();
    tabA.chain.dropSends = true;
    tabA.wallet.behaviour = 'sign';
    await tabB.retry('Fake');
    // Tab A retries too: the core refuses, and the screen no longer says nothing was paid.
    await tabA.session.retry('Fake');
    expect(tabA.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false });
    expect(tabA.wallet.requests).toBe(2);
  });

  it('shows a cancellation heard during a watch pass, and never retries it', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    let release: () => void = () => undefined;
    run.chain.onList = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    void run.timers.tick();
    await settle();
    // The store cancels while the pass waits on the chain.
    await storeSays(run.shop, run.relays, await recordOf(run.offer), {
      status: 'cancelled',
      delivery: undefined,
    });
    run.chain.onList = undefined;
    release();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
    run.wallet.behaviour = 'sign';
    await run.session.retry('Fake');
    expect(run.wallet.requests).toBe(1);
  });

  it('never shows an old offer problem on the waiting screen', async () => {
    const run = await setup();
    run.chain.tokens = 1n;
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    run.wallet.behaviour = 'throw';
    await run.session.pay('Fake');
    run.session.refresh();
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      problem: { reason: 'wallet_failed' },
    });
  });

  it('shows a late delivery for an ended order once the action in progress ends', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    // The next pay stops at the funds check; the store delivers the old order meanwhile.
    run.chain.tokens = 1n;
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: async () => {
          await storeSays(run.shop, run.relays, ended);
          return run.wallet;
        },
      },
    ];
    await run.session.pay('Fake');
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('never lets a late delivery of an ended order cover a live payment', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    // A new order's attempt is live when the store delivers the old one.
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    await storeSays(run.shop, run.relays, ended);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
  });

  it('keeps watching when another tab replaced the attempt during a pass', async () => {
    const tabA = await setup();
    tabA.wallet.behaviour = 'throw';
    await tabA.session.start();
    await tabA.session.pay('Fake');
    tabA.chain.expire();
    tabA.chain.nextBlockhash();
    // Tab A's pass waits on the chain while tab B retries the same order.
    let release: () => void = () => undefined;
    let held = true;
    tabA.chain.onList = () =>
      held
        ? new Promise<void>((resolve) => {
            held = false;
            release = resolve;
          })
        : Promise.resolve();
    void tabA.timers.tick();
    await settle();
    const tabB = new CheckoutSession(tabA.offer, { ...tabA.deps, onView: () => undefined });
    await tabB.start();
    await settle();
    tabA.wallet.behaviour = 'sign';
    tabA.chain.dropSends = true;
    await tabB.retry('Fake');
    release();
    await settle();
    expect(tabA.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false });
  });

  it('shows a delivery heard during a live payment once that payment ended elsewhere', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    // A new order's attempt is live (the wallet failed: it waits out its blockhash).
    await run.session.pay('Fake');
    await storeSays(run.shop, run.relays, ended);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    // Another tab ends the live order; this tab's next pass finds it gone.
    run.chain.expire();
    const other = new CheckoutSession(run.offer, { ...run.deps, onView: () => undefined });
    await other.start();
    await other.startOver();
    await run.timers.tick();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('keeps hearing the order it just ended when many older ones already listen', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    for (let index = 0; index < 6; index += 1) {
      await run.session.pay('Fake');
      run.chain.expire();
      run.chain.nextBlockhash();
      await run.session.startOver();
      run.advance(1);
    }
    const all = await store.forProduct(run.offer.productAddress);
    const newest = all.reduce((left, right) => (right.createdAt >= left.createdAt ? right : left));
    await storeSays(run.shop, run.relays, newest);
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('opens one wallet prompt for a double click, even with a delivery held back', async () => {
    const run = await setup();
    // An ended order E.
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    // Order R is acknowledged here (the funds check stops it), then paid in another tab.
    run.wallet.behaviour = 'sign';
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    run.chain.dropSends = true;
    const other = new CheckoutSession(run.offer, { ...run.deps, onView: () => undefined });
    await other.start();
    await other.pay('Fake');
    // E's delivery is held back: R is paying.
    await storeSays(run.shop, run.relays, ended);
    let connects = 0;
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: async () => {
          connects += 1;
          return run.wallet;
        },
      },
    ];
    await Promise.all([run.session.pay('Fake'), run.session.pay('Fake')]);
    expect(connects).toBe(1);
  });

  it('shows a delivery already heard instead of retrying the product', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    // Order R's attempt fails too; E's delivery comes while R is live.
    await run.session.pay('Fake');
    await storeSays(run.shop, run.relays, ended);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
    // R's attempt ends: the delivery shows, and no retry pays the product again.
    run.chain.expire();
    await run.timers.tick();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    const requests = run.wallet.requests;
    run.wallet.behaviour = 'sign';
    await run.session.retry('Fake');
    expect(run.wallet.requests).toBe(requests);
    // R was ended, not left holding the product: buying again works.
    const all = await store.forProduct(run.offer.productAddress);
    expect(all.filter((record) => record.state === 'paying')).toHaveLength(0);
    run.chain.dropSends = false;
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(requests + 1);
  });

  it('starts a new order from a refund', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    await storeSays(run.shop, run.relays, await recordOf(run.offer), {
      status: 'cancelled',
      delivery: undefined,
      refund: { tx: '6'.repeat(88), amount: '49000000' },
    } as Partial<OrderMessage>);
    expect(run.last()).toMatchObject({ kind: 'refunded' });
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'offer' });
  });

  it('ends the acknowledged order on screen when a delivery for an ended one shows', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    // Order R is acknowledged; the funds check stops it before any attempt.
    run.wallet.behaviour = 'sign';
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    const acknowledged = (await store.forProduct(run.offer.productAddress)).find(
      (record) => record.orderId !== ended.orderId,
    );
    expect(acknowledged?.state).toBe('ordered');
    await storeSays(run.shop, run.relays, ended);
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect((await store.get(acknowledged?.orderId ?? ''))?.state).toBe('ended-unpaid');
    await run.session.startOver();
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(2);
  });

  it('never ends an acknowledged order for a late refund of an ended one', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    run.wallet.behaviour = 'sign';
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = 1_000_000_000n;
    await storeSays(run.shop, run.relays, ended, {
      status: 'cancelled',
      delivery: undefined,
      refund: { tx: '6'.repeat(88), amount: '49000000' },
    } as Partial<OrderMessage>);
    await settle();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    const open = (await store.forProduct(run.offer.productAddress)).find(
      (record) => record.orderId !== ended.orderId,
    );
    expect(open?.state).toBe('ordered');
  });

  it('keeps following a paid order after the offer is refused, and never pays again', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    // Later the store withdraws the product: the offer is refused on load.
    const { followOnlyOffer } = await import('../src/app/controller');
    const snapshot = await followOnlyOffer(run.shop.naddr, store, undefined);
    if (snapshot === undefined) {
      throw new Error('nothing to follow');
    }
    run.chain.dropSends = false;
    const follow = new CheckoutSession(snapshot.offer, {
      ...run.deps,
      followOnly: { message: 'This product cannot be bought here.', orderId: snapshot.orderId },
    });
    await follow.start();
    await run.timers.tick();
    await run.timers.tick();
    // The offer is the order's old snapshot: the store is named, its trust level never claimed.
    const name = run.offer.offer.profile.name;
    expect(run.last()).toMatchObject({ kind: 'waiting_store', about: { store: { name } } });
    expect(run.last()).not.toHaveProperty('about.store.level');
    await storeSays(run.shop, run.relays, await recordOf(run.offer));
    expect(run.last()).toMatchObject({ kind: 'delivered', store: { name } });
    expect(run.last()).not.toHaveProperty('store.level');
    await follow.pay('Fake');
    await follow.retry('Fake');
    expect(run.wallet.requests).toBe(1);
  });

  it('never pays in follow-only mode, even when the followed order ended', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    await run.session.startOver();
    run.session.dispose();
    const { followOnlyOffer } = await import('../src/app/controller');
    const snapshot = await followOnlyOffer(run.shop.naddr, store, undefined);
    if (snapshot === undefined) {
      throw new Error('nothing to follow');
    }
    const follow = new CheckoutSession(snapshot.offer, {
      ...run.deps,
      // Its network is not served either: the store's refusal is still what shows.
      rpcFor: () => undefined,
      followOnly: { message: 'This product cannot be bought here.', orderId: snapshot.orderId },
    });
    await follow.start();
    expect(run.last()).toEqual({
      kind: 'refused',
      message: 'This product cannot be bought here.',
      // An order's old snapshot: its name only, never a trust level it may no longer have.
      store: { name: run.offer.offer.profile.name },
      product: expect.objectContaining({ title: run.offer.offer.product.title }),
    });
    run.wallet.behaviour = 'sign';
    await follow.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(1);
  });

  it('shows a delivery for the current order that arrived during an action', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    const record = await recordOf(run.offer);
    // The next action ends on the offer (the price changed); the store delivers meanwhile.
    run.advance(600);
    run.deps.reloadOffer = async () => {
      await storeSays(run.shop, run.relays, record);
      return raised(run.offer, NOW + 630);
    };
    run.wallet.behaviour = 'sign';
    // (A retry is refused at once while the attempt may land: a pay press is the action.)
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'delivered' });
  });

  it('holds a late refund of an ended order over an attempt that just ended', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.session.startOver();
    const ended = await recordOf(run.offer);
    await run.session.pay('Fake');
    run.chain.expire();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    await storeSays(run.shop, run.relays, ended, {
      status: 'cancelled',
      delivery: undefined,
      refund: { tx: '6'.repeat(88), amount: '49000000' },
    } as Partial<OrderMessage>);
    await settle();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
  });

  it('follows, in follow-only mode, the paying order and not a newer acknowledged one', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    const paying = await recordOf(run.offer);
    run.session.dispose();
    // Another tab has a newer acknowledged order of the product (stopped by its funds check).
    run.advance(5);
    const { placeOrder } = await import('@elisym/commerce/buyer');
    const payout = run.offer.payouts[0];
    if (payout === undefined) {
      throw new Error('no payout');
    }
    const newer = await placeOrder(
      { offer: run.offer, payout, chainTime: NOW + 35, deviceTime: NOW + 35 },
      run.deps,
    );
    expect(newer).toMatchObject({ ok: true, record: { state: 'ordered' } });
    const { followOnlyOffer } = await import('../src/app/controller');
    const snapshot = await followOnlyOffer(run.shop.naddr, store, undefined);
    expect(snapshot?.orderId).toBe(paying.orderId);
    run.chain.dropSends = false;
    const follow = new CheckoutSession(snapshot?.offer as Ready, {
      ...run.deps,
      followOnly: { message: 'Withdrawn.', orderId: paying.orderId },
    });
    await follow.start();
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    expect((await store.get(paying.orderId))?.state).toBe('paid');
  });

  it('keeps following a live attempt when a retry finds the offer refused', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    run.advance(600);
    run.deps.reloadOffer = async () => ({
      ok: false,
      refusal: 'no_payable_payout',
      message: 'gone',
    });
    run.wallet.behaviour = 'sign';
    await run.session.retry('Fake');
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      problem: { reason: 'offer_refused' },
    });
    expect(run.wallet.requests).toBe(1);
    expect((await recordOf(run.offer)).state).toBe('paying');
    // The store no longer accepts this page: no trust level is shown for it.
    const view = run.last();
    const store = view?.kind === 'waiting_payment' ? view.about.store : undefined;
    expect(store?.name).toBeDefined();
    expect(store).not.toHaveProperty('level');
    // A redraw (a wallet registering late) keeps the reason.
    run.session.refresh();
    expect(run.last()).toMatchObject({ problem: { reason: 'offer_refused' } });
    // Once that order ends, the refusal shows: never a new purchase with the old trust level.
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'refused', message: 'gone' });
  });

  it('shows the trust level again once a later reload accepts the page', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    run.advance(600);
    const accepted = run.deps.reloadOffer;
    run.deps.reloadOffer = async () => ({
      ok: false,
      refusal: 'no_payable_payout',
      message: 'gone',
    });
    await run.session.retry('Fake');
    const refusedView = run.last();
    const refusedStore =
      refusedView !== undefined && 'about' in refusedView
        ? (refusedView.about as { store: object }).store
        : undefined;
    expect(refusedStore).not.toHaveProperty('level');
    run.deps.reloadOffer = accepted;
    run.wallet.behaviour = 'sign';
    await run.session.retry('Fake');
    const view = run.last();
    const store =
      view !== undefined && 'about' in view ? (view.about as { store: object }).store : undefined;
    expect(store).toHaveProperty('level');
    expect(view).not.toMatchObject({ problem: { reason: 'offer_refused' } });
  });

  it('publishes the open order again on load', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    const before = run.relays.published.length;
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    expect(run.relays.published.length).toBeGreaterThan(before);
  });

  it('a retry after a reload needs no confirmation', async () => {
    const shop = makeShop({ paytoCreatedAt: NOW - 60 });
    const run = await setup({ shop });
    await run.session.start();
    run.wallet.behaviour = 'throw';
    await run.session.pay('Fake');
    run.session.dispose();
    run.chain.expire();
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'sign';
    await again.retry('Fake');
    expect(run.wallet.requests).toBe(2);
  });

  it('opens only the wallet the buyer chose, and nothing for an unknown one', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Nope');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'no_wallet' } });
    expect(run.wallet.requests).toBe(0);
  });

  it('keeps an order no inbox took, and sends that same order again', async () => {
    const run = await setup();
    run.relays.refuse = INBOX;
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'offer',
      problem: { reason: 'order_not_acknowledged' },
    });
    const first = await recordOf(run.offer);
    run.relays.refuse = [];
    await run.session.pay('Fake');
    const all = await store.forProduct(run.offer.productAddress);
    expect(all).toHaveLength(1);
    expect(all[0]?.orderId).toBe(first.orderId);
    expect(run.wallet.requests).toBe(1);
  });

  it('shows a refund, and a cancellation while paid as "contact the store"', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    const record = await recordOf(run.offer);
    await storeSays(run.shop, run.relays, record, { status: 'cancelled', delivery: undefined });
    expect(run.last()).toMatchObject({ kind: 'waiting_store', cancelled: true });
    await storeSays(run.shop, run.relays, record, {
      status: 'cancelled',
      delivery: undefined,
      refund: { tx: '6'.repeat(88), amount: '49000000' },
    } as Partial<OrderMessage>);
    expect(run.last()).toMatchObject({ kind: 'refunded' });
    expect(run.statuses.at(-1)).toBe('refunded');
  });

  it('lets the buyer start over only once the attempt provably ended', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    await run.session.startOver();
    expect((await recordOf(run.offer)).state).toBe('paying');
    run.chain.expire();
    await run.session.startOver();
    expect((await recordOf(run.offer)).state).toBe('ended-unpaid');
    expect(run.last()).toMatchObject({ kind: 'offer', continuing: false });
    expect(run.statuses).toContain('ended');
  });

  it('sends the buyer email with a new order only when the merchant asks and it is one', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'offer', askEmail: true, email: '' });
    run.session.setEmail('  buyer@example.com ');
    await run.session.pay('Fake');
    const opened = (await recordOf(run.offer)).orderWrap;
    expect(opened).toBeDefined();
    const { unwrapOrderMessage } = await import('@elisym/commerce');
    const message = unwrapOrderMessage(opened as never, run.shop.store.secretKey)?.message;
    expect(message).toMatchObject({ type: 'order', email: 'buyer@example.com' });
  });

  it('sends no email the buyer mistyped, and none unless the merchant asks', async () => {
    const { usableEmail } = await import('../src/app/session');
    expect(usableEmail('not an email')).toBeUndefined();
    expect(usableEmail(`${'a'.repeat(250)}@b.co`)).toBeUndefined();
    expect(usableEmail(`${'a'.repeat(65)}@b.co`)).toBeUndefined();
    expect(usableEmail(`${'a'.repeat(64)}@b.co`)).toBe(`${'a'.repeat(64)}@b.co`);
    const run = await setup();
    await run.session.start();
    run.session.setEmail('buyer@example.com');
    await run.session.pay('Fake');
    const { unwrapOrderMessage } = await import('@elisym/commerce');
    const message = unwrapOrderMessage(
      (await recordOf(run.offer)).orderWrap as never,
      run.shop.store.secretKey,
    )?.message;
    expect(message).not.toHaveProperty('email');
  });
});

/** The offer with a second payout on the same network: another address, `extra` subunits dearer. */
function withSecondPayout(offer: Ready, address: string, extra = 5n): Ready {
  const [first] = offer.payouts;
  if (first === undefined) {
    throw new Error('no payout');
  }
  const target = { ...first.target, address };
  return {
    ...offer,
    offer: { ...offer.offer, payouts: [...offer.offer.payouts, target] },
    payouts: [...offer.payouts, { target, amount: first.amount + extra }],
  };
}

/** The same offer listed on mainnet only (the store dropped its devnet payout). */
function mainnetOnly(offer: Ready): Ready {
  const listed = withMainnetFirst(offer);
  return { ...listed, payouts: listed.payouts.slice(0, 1) };
}

/** The offer as it would be reloaded without its first payout. */
function withoutFirst(offer: Ready): Ready {
  return { ...offer, payouts: offer.payouts.slice(1) };
}

function lastOffer(run: Awaited<ReturnType<typeof setup>>): Extract<View, { kind: 'offer' }> {
  const view = run.last();
  if (view?.kind !== 'offer') {
    throw new Error(`expected the offer, got ${view?.kind}`);
  }
  return view;
}

/** Every offer shown selects its own payout, found by value. */
function selectsByValue(views: readonly View[]): boolean {
  return views.every((view) => {
    if (view.kind !== 'offer') {
      return true;
    }
    const chosen = view.payouts[view.payoutIndex];
    return (
      chosen !== undefined &&
      chosen.target.caip19.id === view.payout.target.caip19.id &&
      chosen.target.address === view.payout.target.address
    );
  });
}

describe('the payout chosen, across reloads', () => {
  it('keeps the chosen payout selected by value after a stale reload that changed nothing', async () => {
    const second = solanaAddress();
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    await run.session.start();
    run.session.choosePayout(1);
    run.advance(600);
    run.deps.chainTime = async () => {
      throw new Error('down');
    };
    await run.session.pay('Fake');
    const view = lastOffer(run);
    expect(view.problem).toEqual({ reason: 'rpc_error' });
    expect(view.payoutIndex).toBe(1);
    expect(view.payout.target.address).toBe(second);
    expect(selectsByValue(run.views)).toBe(true);
  });

  it('refuses rather than switching networks when the chosen payout is gone', async () => {
    const run = await setup();
    await run.session.start();
    run.advance(600);
    run.deps.reloadOffer = async () => mainnetOnly(raised(run.offer, NOW + 630));
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'refused',
      message: 'This product cannot be paid here',
    });
    expect(run.statuses).toContain('refused');
    expect(run.wallet.requests).toBe(0);
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(0);
  });

  it('replaces a gone payout only with another one on the same network, for review', async () => {
    const second = solanaAddress();
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    await run.session.start();
    run.advance(600);
    const reloaded = withMainnetFirst(withoutFirst(withSecondPayout(run.offer, second)));
    // Reloaded: mainnet listed first, then the second devnet payout; the first is gone.
    run.deps.reloadOffer = async () => ({ ...reloaded, snapshotAt: NOW + 630 });
    await run.session.pay('Fake');
    const view = lastOffer(run);
    expect(view.problem).toEqual({ reason: 'offer_changed' });
    expect(view.payout.target.address).toBe(second);
    expect(view.payout.target.caip19.chain.network).toBe('devnet');
    expect(view.payouts.every((payout) => payout.target.caip19.chain.network === 'devnet')).toBe(
      true,
    );
    expect(run.wallet.requests).toBe(0);
    expect(selectsByValue(run.views)).toBe(true);
    // A wallet registering redraws the same problem object: the step never moves for it.
    const problem = view.problem;
    run.session.refresh();
    expect(lastOffer(run).problem).toBe(problem);
  });

  it('keeps following a live attempt when its payout is gone on a retry, every time', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const requests = run.wallet.requests;
    run.wallet.behaviour = 'sign';
    run.advance(600);
    run.deps.reloadOffer = async () => mainnetOnly(raised(run.offer, NOW + 630));
    for (const press of [1, 2]) {
      await run.session.retry('Fake');
      expect(run.last(), `press ${press}`).toMatchObject({
        kind: 'waiting_payment',
        problem: { reason: 'offer_refused' },
      });
      expect(run.wallet.requests).toBe(requests);
      expect((await recordOf(run.offer)).state).toBe('paying');
      run.advance(30);
    }
    expect(run.views.some((view) => view.kind === 'refused')).toBe(false);
    expect(run.statuses).not.toContain('refused');
  });
});

describe('the email, checked against the order actually sent', () => {
  /** An acknowledged order on the default payout, not paid (the wallet held too little). */
  async function openOrder(run: Awaited<ReturnType<typeof setup>>): Promise<OrderRecord> {
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    const record = await recordOf(run.offer);
    expect(record.state).toBe('ordered');
    return record;
  }

  it('never blocks continuing an open order with a typo held for another one', async () => {
    const second = solanaAddress();
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    run.deps.collectEmail = true;
    await run.session.start();
    const first = await openOrder(run);
    expect(lastOffer(run).continuing).toBe('ordered');
    run.session.choosePayout(1);
    expect(lastOffer(run).continuing).toBe(false);
    run.session.setEmail('not an email');
    run.session.choosePayout(0);
    expect(lastOffer(run).continuing).toBe('ordered');
    await run.session.pay('Fake');
    expect(
      run.views.some((view) => view.kind === 'offer' && view.problem?.reason === 'bad_email'),
    ).toBe(false);
    expect(run.wallet.requests).toBe(1);
    const all = await store.forProduct(run.offer.productAddress);
    expect(all.map((record) => record.orderId)).toEqual([first.orderId]);
  });

  it('checks the email again when the open order turned out ended before the press', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    await run.session.start();
    const first = await openOrder(run);
    run.session.setEmail('not an email');
    // Another tab ended it meanwhile.
    const ended = await endOrder(first, {
      store,
      readClient: run.relays,
      clientFor: () => run.relays,
      now: run.deps.now,
      rpc: run.chain.rpc,
    });
    expect(ended.ended).toBe(true);
    await run.session.pay('Fake');
    const view = lastOffer(run);
    expect(view.problem).toEqual({ reason: 'bad_email' });
    expect(view.continuing).toBe(false);
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(1);
    expect(run.wallet.requests).toBe(0);
  });

  it('asks for a fixed email before any wallet opens when a new order is certain', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    let connects = 0;
    const wallets = run.deps.wallets;
    run.deps.wallets = (network) =>
      wallets(network).map((option) => ({
        ...option,
        connect: () => {
          connects += 1;
          return option.connect();
        },
      }));
    await run.session.start();
    run.session.setEmail('not an email');
    await run.session.pay('Fake');
    expect(lastOffer(run).problem).toEqual({ reason: 'bad_email' });
    expect(connects).toBe(0);
  });

  it('asks for a fixed email before ending the open order for another payout', async () => {
    const second = solanaAddress();
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    run.deps.collectEmail = true;
    await run.session.start();
    const first = await openOrder(run);
    run.session.choosePayout(1);
    run.session.setEmail('not an email');
    await run.session.pay('Fake');
    expect(lastOffer(run).problem).toEqual({ reason: 'bad_email' });
    expect((await store.get(first.orderId))?.state).toBe('ordered');
  });

  it('places an order with no email when the field is left blank', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    await run.session.start();
    run.session.setEmail('   ');
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    const { unwrapOrderMessage } = await import('@elisym/commerce');
    const message = unwrapOrderMessage(
      (await recordOf(run.offer)).orderWrap as never,
      run.shop.store.secretKey,
    )?.message;
    expect(message).not.toHaveProperty('email');
  });

  it('never blocks on a typed value when the merchant asks for no email', async () => {
    const run = await setup();
    await run.session.start();
    run.session.setEmail('not an email');
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    expect(run.views.some((view) => view.kind === 'offer' && view.problem !== undefined)).toBe(
      false,
    );
  });
});

describe('the open order the offer continues', () => {
  it('is an order the store has not acknowledged yet', async () => {
    const run = await setup();
    run.relays.refuse = INBOX;
    await run.session.start();
    await run.session.pay('Fake');
    expect(lastOffer(run)).toMatchObject({
      continuing: 'created',
      problem: { reason: 'order_not_acknowledged' },
    });
  });

  it('stays across a reload that changed nothing, and ends with a new price', async () => {
    const run = await setup();
    await run.session.start();
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    expect(lastOffer(run).continuing).toBe('ordered');
    run.advance(600);
    await run.session.pay('Fake');
    expect(lastOffer(run).continuing).toBe('ordered');
    run.chain.tokens = tokens;
    run.advance(600);
    run.deps.reloadOffer = async () => raised(run.offer, NOW + 1230);
    await run.session.pay('Fake');
    expect(lastOffer(run)).toMatchObject({
      continuing: false,
      problem: { reason: 'offer_changed' },
    });
  });
});

describe('the payment a progress screen names', () => {
  it('is the payout chosen for a new order, never the open order on other terms', async () => {
    const second = solanaAddress();
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    await run.session.start();
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    const first = run.offer.payouts[0];
    const chosen = run.offer.payouts[1];
    if (first === undefined || chosen === undefined) {
      throw new Error('two payouts');
    }
    run.session.choosePayout(1);
    const from = run.views.length;
    run.wallet.behaviour = 'throw';
    await run.session.pay('Fake');
    const working = run.views
      .slice(from)
      .filter((view) => view.kind === 'working')
      .map((view) => [view.step, view.paying?.amount]);
    // Checking twice: while the wallet connects (cancellable), then after.
    expect(working).toEqual([
      ['checking', chosen.amount.toString()],
      ['checking', chosen.amount.toString()],
      ['ordering', chosen.amount.toString()],
      ['signing', chosen.amount.toString()],
    ]);
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      paying: { amount: chosen.amount.toString(), network: 'devnet', chain: 'solana' },
    });
  });

  it('is the open order itself while it is continued', async () => {
    const run = await setup();
    await run.session.start();
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    const record = await recordOf(run.offer);
    const from = run.views.length;
    await run.session.pay('Fake');
    const steps = run.views.slice(from).filter((view) => view.kind === 'working');
    expect(steps.length).toBeGreaterThan(0);
    for (const view of steps) {
      expect(view).toMatchObject({ paying: { amount: record.amount } });
    }
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store', paying: { amount: record.amount } });
  });
});

/** The same offer, verified again at `now`, with a new price on the listing and its payouts. */
function repriced(offer: Ready, now: number): Ready {
  return {
    ...raised(offer, now),
    offer: {
      ...offer.offer,
      product: { ...offer.offer.product, price: { amount: '99', currency: 'USD' } },
    },
  };
}

describe('what a progress screen is about', () => {
  it('names the new terms while a new order is placed beside an open one on old terms', async () => {
    const run = await setup();
    await run.session.start();
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    expect((await recordOf(run.offer)).state).toBe('ordered');
    run.advance(600);
    run.deps.reloadOffer = async () => repriced(run.offer, NOW + 630);
    // The first press finds the change and shows it; the next one places the new order.
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'offer_changed' } });
    const from = run.views.length;
    await run.session.pay('Fake');
    const early = run.views
      .slice(from)
      .filter((view) => view.kind === 'working' && view.step !== 'signing');
    expect(early.length).toBeGreaterThan(0);
    for (const view of early) {
      expect(view).toMatchObject({ about: { product: { price: { amount: '99' } } } });
    }
  });

  it('names the order’s own product and price after a reload, whatever the store lists now', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.session.dispose();
    const now = repriced(run.offer, NOW + 30);
    const again = new CheckoutSession(now, run.deps);
    await again.start();
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      about: {
        product: { price: run.offer.offer.product.price },
        store: { name: run.offer.offer.profile.name, level: run.offer.offer.level },
      },
    });
  });

  it('shows the email this session sent with the order, and none after a reload', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    run.deps.collectEmail = true;
    await run.session.start();
    run.session.setEmail('buyer@example.com');
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      about: { email: 'buyer@example.com' },
    });
    run.session.dispose();
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    const view = run.last();
    expect(view?.kind).toBe('waiting_payment');
    expect(view?.kind === 'waiting_payment' ? view.about.email : 'none').toBeUndefined();
  });

  it('says when a still-unsure attempt is long, and stops saying it once it is over', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const record = await recordOf(run.offer);
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      signed: false,
      followOnly: false,
      unserved: false,
      unsureAt: (record.marker?.setAt ?? 0) + 600,
    });
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    expect(run.last()).not.toHaveProperty('unsureAt');
  });
});

/** The chain's RPC, with its block-height read failing on demand and the session's reads counted. */
function epochRpc(chain: FakeSolana) {
  const state = { fails: false, throwsAtOnce: false, sessionReads: 0 };
  const rpc = new Proxy(chain.rpc, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'getEpochInfo' || typeof value !== 'function') {
        return value;
      }
      return (config: unknown) => {
        const request = value(config) as { send(options?: unknown): Promise<unknown> };
        const sendAsync = async (options?: { abortSignal?: AbortSignal }) => {
          // Only the session's own read carries a timeout.
          if (options?.abortSignal !== undefined) {
            state.sessionReads += 1;
            if (state.fails) {
              throw new Error('node down');
            }
          }
          return request.send(options);
        };
        return {
          send: (options?: { abortSignal?: AbortSignal }) => {
            // A client that throws before returning a promise, on the session's read only.
            if (options?.abortSignal !== undefined && state.throwsAtOnce) {
              throw new Error('broken client');
            }
            return sendAsync(options);
          },
        };
      };
    },
  });
  return { rpc, state };
}

describe('the retry countdown', () => {
  async function failed() {
    const run = await setup();
    const epoch = epochRpc(run.chain);
    run.deps.rpcFor = () => epoch.rpc;
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const record = await recordOf(run.offer);
    const marker = record.marker;
    if (marker?.rail !== 'solana') {
      throw new Error('no Solana attempt');
    }
    return { run, epoch, lastValid: BigInt(marker.lastValidBlockHeight), record };
  }

  it('counts the blocks to the settle margin from the finalized height, as an estimate', async () => {
    const { run, lastValid } = await failed();
    await run.timers.tick();
    await run.timers.tick();
    const left = Number(lastValid + RETRY_SETTLE_BLOCKS - run.chain.height);
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      canRetry: false,
      retryIn: { seconds: Math.ceil(left * SLOT_SECS_ESTIMATE) },
    });
  });

  it('never counts back up when the chain is slower than the estimate', async () => {
    const { run } = await failed();
    await run.timers.tick();
    await run.timers.tick();
    const first = run.last();
    const known = first?.kind === 'waiting_payment' ? first.retryIn : undefined;
    if (known === undefined) {
      throw new Error('no estimate');
    }
    // Ten seconds pass and the chain does not move: the estimate keeps counting down.
    run.advance(10);
    await run.timers.tick();
    await run.timers.tick();
    const later = run.last();
    const next = later?.kind === 'waiting_payment' ? later.retryIn : undefined;
    expect(next).toBeDefined();
    expect(next?.seconds ?? Infinity).toBeLessThanOrEqual(
      Math.max(0, known.seconds - ((next?.at ?? 0) - known.at)),
    );
  });

  it('never stops the watch when the read throws at once', async () => {
    const { run, epoch } = await failed();
    epoch.state.throwsAtOnce = true;
    await run.timers.tick();
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
  });

  it('shows none until a read succeeds, and keeps the last one through a failed read', async () => {
    const { run, epoch } = await failed();
    epoch.state.fails = true;
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).not.toHaveProperty('retryIn');
    epoch.state.fails = false;
    await run.timers.tick();
    await run.timers.tick();
    const view = run.last();
    const known = view?.kind === 'waiting_payment' ? view.retryIn : undefined;
    expect(known).toBeDefined();
    epoch.state.fails = true;
    run.advance(5);
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ retryIn: known });
  });

  it('reaches 0 no later than the watch may judge the attempt over, and then reads no more', async () => {
    const { run, epoch, lastValid } = await failed();
    expect(RETRY_SETTLE_BLOCKS).toBe(32n);
    // At exactly the settle margin: the countdown is done, the attempt not yet over.
    run.chain.advance(lastValid + RETRY_SETTLE_BLOCKS - run.chain.height);
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      canRetry: false,
      retryIn: { seconds: 0 },
    });
    const reads = epoch.state.sessionReads;
    await run.timers.tick();
    expect(epoch.state.sessionReads).toBe(reads);
    // One block more: over.
    run.chain.advance(1n);
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    expect(run.last()).not.toHaveProperty('retryIn');
  });

  it('never shows the countdown of an earlier attempt for a new one', async () => {
    const { run } = await failed();
    await run.timers.tick();
    await run.timers.tick();
    expect(run.last()).toHaveProperty('retryIn');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'sign';
    run.chain.dropSends = true;
    await run.session.retry('Fake');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false, signed: true });
    expect(run.last()).not.toHaveProperty('retryIn');
  });
});

describe('a press, held against changes', () => {
  it('never changes the payout while a pay press is running', async () => {
    const second = solanaAddress();
    const run = await setup({ transform: (offer) => withSecondPayout(offer, second) });
    await run.session.start();
    const pressed = run.session.pay('Fake');
    run.session.choosePayout(1);
    await pressed;
    const record = await recordOf(run.offer);
    expect(record.payout.address).toBe(run.offer.payouts[0]?.target.address);
  });

  it('opens no wallet for a retry while the attempt may still land', async () => {
    const run = await setup();
    let connects = 0;
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: async () => {
          connects += 1;
          return run.wallet;
        },
      },
    ];
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const requests = run.wallet.requests;
    const before = connects;
    run.wallet.behaviour = 'sign';
    await run.session.retry('Fake');
    expect(connects).toBe(before);
    expect(run.wallet.requests).toBe(requests);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: false });
  });

  it('shows the retry working before the wallet connects, and never ends on it', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const record = await recordOf(run.offer);
    // A wallet that never answers: the retry stays on its working view.
    run.deps.wallets = () => [{ name: 'Fake', connect: () => new Promise(() => undefined) }];
    void run.session.retry('Fake');
    await settle();
    expect(run.last()).toMatchObject({
      kind: 'working',
      step: 'checking',
      paying: { amount: record.amount },
      about: { product: { title: record.offer.product.title } },
    });
  });

  it('never leaves a retry on its working view when the network went away meanwhile', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    let served = true;
    const chainRpc = run.chain.rpc;
    run.deps.rpcFor = () => (served ? chainRpc : undefined);
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: async () => {
          served = false;
          return run.wallet;
        },
      },
    ];
    await run.session.retry('Fake');
    expect(run.last()?.kind).not.toBe('working');
  });
});

/** A promise the test settles by hand. */
function held<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settleWith, failWith) => {
    resolve = settleWith;
    reject = failWith;
  });
  return { promise, resolve, reject };
}

/** A wallet error as wallets throw them: a code and a message. */
function walletError(code: number, message = 'wallet error'): Error {
  return Object.assign(new Error(message), { code });
}

describe('cancel while the wallet connects', () => {
  it('ends the press at once: the offer again, nothing asked, and a new press works', async () => {
    const run = await setup();
    await run.session.start();
    const connect = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => connect.promise }];
    const pressed = run.session.pay('Fake');
    await settle();
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    run.session.cancel();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(run.last()).not.toHaveProperty('problem');
    // The late answer is dropped: no order, no request, no view.
    const views = run.views.length;
    connect.resolve(run.wallet);
    await pressed;
    await settle();
    expect(run.views.length).toBe(views);
    expect(run.wallet.requests).toBe(0);
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(0);
    // Busy and pressing were released: a new press pays.
    run.deps.wallets = () => [{ name: 'Fake', connect: async () => run.wallet }];
    await run.session.pay('Fake');
    expect(run.wallet.requests).toBe(1);
    expect(run.last()).toMatchObject({ kind: 'waiting_payment' });
  });

  it('a connect refused after the cancel draws nothing', async () => {
    const run = await setup();
    await run.session.start();
    const connect = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => connect.promise }];
    const pressed = run.session.pay('Fake');
    await settle();
    run.session.cancel();
    const views = run.views.length;
    connect.reject(walletError(4001));
    await pressed;
    await settle();
    expect(run.views.length).toBe(views);
  });

  it('signs with the new press’s own wallet, never the cancelled press’s late one', async () => {
    const run = await setup();
    await run.session.start();
    const first = held<FakeWallet>();
    const other = await FakeWallet.create();
    run.deps.wallets = () => [
      { name: 'A', connect: () => first.promise },
      { name: 'B', connect: async () => other },
    ];
    const pressA = run.session.pay('A');
    await settle();
    run.session.cancel();
    // B connects, then waits on the chain time; A's connect answers meanwhile.
    const chainTime = held<number>();
    run.deps.chainTime = () => chainTime.promise;
    const pressB = run.session.pay('B');
    await settle();
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    expect(run.last()).not.toHaveProperty('cancellable');
    first.resolve(run.wallet);
    await pressA;
    await settle();
    // Still B's press: busy is held (a refresh draws nothing), and A is ignored.
    const views = run.views.length;
    run.session.refresh();
    expect(run.views.length).toBe(views);
    chainTime.resolve(NOW + 30);
    await pressB;
    expect(other.requests).toBe(1);
    expect(run.wallet.requests).toBe(0);
  });

  it('a cancelled press ending late never frees the payout of a press still starting', async () => {
    const run = await setup({ transform: (offer) => withSecondPayout(offer, solanaAddress()) });
    await run.session.start();
    const connect = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => connect.promise }];
    const pressA = run.session.pay('Fake');
    await settle();
    run.session.cancel();
    // Press B is held before its guard (the delivery-first check).
    const before = held<boolean>();
    const hooks = run.session as unknown as { deliveryFirst(): Promise<boolean> };
    hooks.deliveryFirst = () => before.promise;
    const pressB = run.session.pay('Fake');
    connect.resolve(run.wallet);
    await pressA;
    await settle();
    const views = run.views.length;
    run.session.choosePayout(1);
    expect(run.views.length).toBe(views);
    before.resolve(true);
    await pressB;
  });

  it('cancels a retry back to the retry rows; a late answer changes nothing', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const connect = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => connect.promise }];
    const retried = run.session.retry('Fake');
    await settle();
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    run.session.cancel();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const views = run.views.length;
    const requests = run.wallet.requests;
    run.wallet.behaviour = 'sign';
    connect.resolve(run.wallet);
    await retried;
    await settle();
    expect(run.views.length).toBe(views);
    expect(run.wallet.requests).toBe(requests);
  });

  it('shows the order the store cancelled during the wait', async () => {
    const run = await setup();
    await run.session.start();
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    const record = await recordOf(run.offer);
    expect(record.state).toBe('ordered');
    const connect = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => connect.promise }];
    const pressed = run.session.pay('Fake');
    await settle();
    await storeSays(run.shop, run.relays, record, { status: 'cancelled', delivery: undefined });
    run.session.cancel();
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
    connect.resolve(run.wallet);
    await pressed;
  });

  it('is not offered once the wallet answered; Cancel then does nothing', async () => {
    const run = await setup();
    await run.session.start();
    const chainTime = held<number>();
    run.deps.chainTime = () => chainTime.promise;
    const pressed = run.session.pay('Fake');
    await settle();
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking' });
    expect(run.last()).not.toHaveProperty('cancellable');
    const views = run.views.length;
    run.session.cancel();
    expect(run.views.length).toBe(views);
    chainTime.resolve(NOW + 30);
    await pressed;
    const later = run.views
      .slice(views)
      .filter((view) => view.kind === 'working' && view.cancellable === true);
    expect(later).toHaveLength(0);
    expect(run.wallet.requests).toBe(1);
  });

  it('names a refusal and a busy wallet at connect (both rails share the reading)', async () => {
    const run = await setup();
    await run.session.start();
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: () => Promise.reject(walletError(4001, 'User rejected the request.')),
      },
    ];
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rejected' } });
    run.deps.wallets = () => [
      { name: 'Fake', connect: () => Promise.reject(walletError(-32002, 'Request pending')) },
    ];
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'wallet_busy' } });
    run.deps.wallets = () => [
      { name: 'Fake', connect: () => Promise.reject(new Error('no account')) },
    ];
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'no_wallet' } });
  });
});

describe('a cancelled retry, after it', () => {
  it('signs with the new retry’s own wallet, never the cancelled retry’s late one', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    const first = held<FakeWallet>();
    const other = await FakeWallet.create();
    run.deps.wallets = () => [
      { name: 'A', connect: () => first.promise },
      { name: 'B', connect: async () => other },
    ];
    const requestsBefore = run.wallet.requests;
    const retryA = run.session.retry('A');
    await settle();
    run.session.cancel();
    const chainTime = held<number>();
    run.deps.chainTime = () => chainTime.promise;
    const retryB = run.session.retry('B');
    await settle();
    run.wallet.behaviour = 'sign';
    first.resolve(run.wallet);
    await retryA;
    await settle();
    chainTime.resolve(run.deps.now());
    await retryB;
    expect(other.requests).toBe(1);
    expect(run.wallet.requests).toBe(requestsBefore);
  });

  it('a new order shows the payout chosen, not the cancelled retry’s order', async () => {
    const run = await setup({ transform: (offer) => withSecondPayout(offer, solanaAddress()) });
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    const connect = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => connect.promise }];
    const retried = run.session.retry('Fake');
    await settle();
    run.session.cancel();
    connect.resolve(run.wallet);
    await retried;
    await run.session.startOver();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    // A new order that stays acknowledged and unpaid (too little in the wallet).
    run.deps.wallets = () => [{ name: 'Fake', connect: async () => run.wallet }];
    run.wallet.behaviour = 'sign';
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    const chosen = run.offer.payouts[1];
    if (chosen === undefined) {
      throw new Error('two payouts');
    }
    run.session.choosePayout(1);
    const next = held<FakeWallet>();
    run.deps.wallets = () => [{ name: 'Fake', connect: () => next.promise }];
    const pressed = run.session.pay('Fake');
    await settle();
    expect(run.last()).toMatchObject({
      kind: 'working',
      step: 'checking',
      paying: { amount: chosen.amount.toString() },
    });
    run.session.cancel();
    next.resolve(run.wallet);
    await pressed;
  });

  it('a cancelled retry ending late leaves the next retry naming its own order', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    const record = await recordOf(run.offer);
    // A retry finds the offer dearer: the payout chosen now differs from the order's.
    run.advance(200);
    run.deps.reloadOffer = async () => {
      const now = run.deps.now();
      return raised(await loaded(run.shop, run.relays, now), now);
    };
    await run.session.retry('Fake');
    expect(run.last()).toMatchObject({ problem: { reason: 'offer_changed' } });
    const first = held<FakeWallet>();
    const second = held<FakeWallet>();
    let presses = 0;
    run.deps.wallets = () => [
      {
        name: 'Fake',
        connect: () => {
          presses += 1;
          return presses === 1 ? first.promise : second.promise;
        },
      },
    ];
    const retryA = run.session.retry('Fake');
    await settle();
    run.session.cancel();
    const retryB = run.session.retry('Fake');
    await settle();
    first.resolve(run.wallet);
    await retryA;
    await settle();
    const from = run.views.length;
    second.resolve(run.wallet);
    await settle();
    const checking = run.views
      .slice(from)
      .find((view) => view.kind === 'working' && view.step === 'checking');
    expect(checking).toMatchObject({ paying: { amount: record.amount } });
    await retryB;
  });
});

/** Record the delays the session asks of one-shot timers (the test still runs them by hand). */
function recordDelays(run: Awaited<ReturnType<typeof setup>>): number[] {
  const delays: number[] = [];
  run.deps.setTimeout = (handler, ms) => {
    delays.push(ms);
    return run.timers.set(handler);
  };
  return delays;
}

describe('the chain-time read', () => {
  it('gives up after its deadline: rpc_error on the offer, nothing placed', async () => {
    const run = await setup();
    await run.session.start();
    const delays = recordDelays(run);
    run.deps.chainTime = () => new Promise<number>(() => undefined);
    const pressed = run.session.pay('Fake');
    await settle();
    await run.timers.tick();
    await pressed;
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rpc_error' } });
    expect(await store.forProduct(run.offer.productAddress)).toHaveLength(0);
    expect(delays).toEqual([CHAIN_TIME_TIMEOUT_MS]);
  });

  it('gives up on a retry too: rpc_error on the wait', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    const delays = recordDelays(run);
    run.deps.chainTime = () => new Promise<number>(() => undefined);
    const retried = run.session.retry('Fake');
    await settle();
    await run.timers.tick();
    await retried;
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      problem: { reason: 'rpc_error' },
    });
    expect(delays).toEqual([CHAIN_TIME_TIMEOUT_MS]);
  });
});

describe('the receipt', () => {
  it('names a store with no profile name "Unnamed store", on screen and in the copy', async () => {
    const nameless = (offer: Ready): Ready => ({
      ...offer,
      offer: { ...offer.offer, profile: { ...offer.offer.profile, name: undefined } },
    });
    const run = await setup({ transform: nameless });
    await run.session.start();
    await run.session.pay('Fake');
    await run.timers.tick();
    await storeSays(run.shop, run.relays, await recordOf(run.offer));
    const view = run.last();
    const receipt = view?.kind === 'delivered' ? view.receipt : undefined;
    if (receipt === undefined) {
      throw new Error('no receipt');
    }
    expect(receipt.store).toBe('Unnamed store');
    expect(receiptText(receipt, 'delivered')).toContain('Store: Unnamed store');
  });

  it('shows no payment rows for an order the store answered without this checkout seeing it paid', async () => {
    const run = await setup();
    await run.session.start();
    const tokens = run.chain.tokens;
    run.chain.tokens = 1n;
    await run.session.pay('Fake');
    run.chain.tokens = tokens;
    const record = await recordOf(run.offer);
    await storeSays(run.shop, run.relays, record);
    const view = run.last();
    expect(view).toMatchObject({ kind: 'delivered' });
    const receipt = view?.kind === 'delivered' ? view.receipt : undefined;
    expect(receipt).toMatchObject({ orderId: record.orderId, product: 'Agents 101' });
    expect(receipt).not.toHaveProperty('paid');
    expect(receipt?.answeredAt).toBeDefined();
  });
});

/** The chain's RPC with its signature-status read answered by the test, reads counted. */
function statusRpc(chain: FakeSolana, answer: (signature: string) => Promise<unknown> | 'real') {
  const state = { reads: 0 };
  const rpc = new Proxy(chain.rpc, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'getSignatureStatuses' || typeof value !== 'function') {
        return value;
      }
      return (signatures: string[], config: unknown) => {
        const real = value(signatures, config) as { send(options?: unknown): Promise<unknown> };
        return {
          send: (options?: { abortSignal?: AbortSignal }) => {
            // Only the receipt's look-up carries a timeout (the watch's reads do not).
            if (options?.abortSignal === undefined) {
              return real.send(options);
            }
            state.reads += 1;
            const answered = answer(signatures[0] ?? '');
            return answered === 'real' ? real.send(options) : answered;
          },
        };
      };
    },
  });
  return { rpc, state };
}

/** A completed order whose payment this checkout's watch never confirmed: the store answered first. */
async function answeredFirst(rpcFor?: (chain: FakeSolana) => SessionDeps['rpcFor']) {
  const run = await setup();
  if (rpcFor !== undefined) {
    run.deps.rpcFor = rpcFor(run.chain);
  }
  // The transaction lands, but the watch cannot read it yet: no `paidTx`.
  run.chain.indexLag = true;
  await run.session.start();
  await run.session.pay('Fake');
  const record = await recordOf(run.offer);
  const marker = record.marker;
  if (marker?.rail !== 'solana' || marker.signature === undefined) {
    throw new Error('no signed attempt');
  }
  await storeSays(run.shop, run.relays, record);
  return { run, signature: marker.signature };
}

function receiptOfView(view: View | undefined) {
  return view?.kind === 'delivered' || view?.kind === 'refunded' ? view.receipt : undefined;
}

describe('the transaction a receipt names', () => {
  it('names the transaction this checkout sent once the chain says it went through, never "Paid"', async () => {
    const { run, signature } = await answeredFirst();
    const deliveries = run.views.filter((view) => view.kind === 'delivered');
    // Drawn first without it (the look-up runs after), then with it.
    expect(receiptOfView(deliveries[0])).not.toHaveProperty('sent');
    const receipt = receiptOfView(run.last());
    expect(receipt).not.toHaveProperty('paid');
    expect(receipt?.sent).toEqual({
      tx: signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
    if (receipt === undefined) {
      throw new Error('no receipt');
    }
    const text = receiptText(receipt, 'delivered');
    expect(text).toContain('Total: 49 USDC · Solana devnet');
    expect(text).not.toContain('Paid');
    expect(text).not.toContain('not seen');
    expect(text.split('\n').at(-1)).toBe(`Transaction sent: ${signature}`);
  });

  it('names nothing for a transaction the chain does not know', async () => {
    const run = await setup();
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    await storeSays(run.shop, run.relays, await recordOf(run.offer));
    await settle();
    const receipt = receiptOfView(run.last());
    expect(receipt).toBeDefined();
    expect(receipt).not.toHaveProperty('sent');
    expect(receipt).not.toHaveProperty('paid');
  });

  for (const [name, answer] of [
    [
      'failed on chain',
      async () => ({ value: [{ err: { failed: true }, confirmationStatus: 'finalized' }] }),
    ],
    ['only processed', async () => ({ value: [{ err: null, confirmationStatus: 'processed' }] })],
    [
      'a look-up that throws',
      async () => {
        throw new Error('node down');
      },
    ],
    ['a look-up that never answers', () => new Promise(() => undefined)],
  ] as const) {
    it(`names nothing for ${name}`, async () => {
      const probe: { state?: { reads: number } } = {};
      const { run } = await answeredFirst((chain) => {
        const made = statusRpc(chain, answer);
        probe.state = made.state;
        return () => made.rpc;
      });
      await settle();
      expect(probe.state?.reads).toBe(1);
      expect(receiptOfView(run.last())).not.toHaveProperty('sent');
    });
  }

  it('looks nothing up, and names nothing, without a client for the order network', async () => {
    const probe: { state?: { reads: number } } = {};
    const { run } = await answeredFirst((chain) => {
      const made = statusRpc(chain, () => 'real');
      probe.state = made.state;
      return () => made.rpc;
    });
    // The page loses its RPC before the receipt is first drawn again (a new session).
    run.session.dispose();
    run.deps.rpcFor = () => undefined;
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    await settle();
    expect(receiptOfView(run.last())).not.toHaveProperty('sent');
    expect(probe.state?.reads).toBe(1);
  });

  it('never names an attempt proven over, whatever the chain would say', async () => {
    const probe: { state?: { reads: number } } = {};
    const run = await setup();
    const made = statusRpc(run.chain, async () => ({
      value: [{ err: null, confirmationStatus: 'finalized' }],
    }));
    probe.state = made.state;
    run.deps.rpcFor = () => made.rpc;
    run.chain.dropSends = true;
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    // The store releases the order by hand.
    await storeSays(run.shop, run.relays, await recordOf(run.offer));
    await settle();
    expect(receiptOfView(run.last())).toBeDefined();
    expect(receiptOfView(run.last())).not.toHaveProperty('sent');
    expect(probe.state?.reads).toBe(0);
  });

  it('shows no transaction while the look-up is still out, on any redraw', async () => {
    const { run } = await answeredFirst((chain) => {
      const made = statusRpc(chain, () => new Promise(() => undefined));
      return () => made.rpc;
    });
    run.session.refresh();
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(receiptOfView(run.last())).not.toHaveProperty('sent');
  });

  it('a look-up that answers during an action draws nothing', async () => {
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { run } = await answeredFirst((chain) => {
      const made = statusRpc(chain, () => held);
      return () => made.rpc;
    });
    const drawn = run.views.length;
    const startingOver = run.session.startOver();
    release({ value: [{ err: null, confirmationStatus: 'finalized' }] });
    await startingOver;
    await settle();
    const after = run.views.slice(drawn);
    expect(after.some((view) => receiptOfView(view)?.sent !== undefined)).toBe(false);
    expect(run.last()).toMatchObject({ kind: 'offer' });
  });
});

describe('the explorer link', () => {
  it('encodes the transaction into the URL', () => {
    expect(explorerLink('a/b?c#d', 'mainnet')).toBe('https://explorer.solana.com/tx/a%2Fb%3Fc%23d');
    expect(explorerLink('sig', 'devnet')).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
  });
});

describe('a decline in the wallet', () => {
  it('goes back to the offer at once, and the next press pays the same order', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rejected' } });
    expect(run.views.some((view) => view.kind === 'waiting_payment')).toBe(false);
    expect(run.statuses.at(-1)).toBe('ordered');
    const first = await recordOf(run.offer);
    expect(first.state).toBe('ordered');
    expect(first.marker).toBeUndefined();
    run.wallet.behaviour = 'sign';
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
    const after = await recordOf(run.offer);
    expect(after.orderId).toBe(first.orderId);
  });

  it('a declined retry returns to ordered: paying, then ordered, and pays again', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    run.chain.expire();
    run.chain.nextBlockhash();
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', canRetry: true });
    run.wallet.behaviour = 'reject';
    await run.session.retry('Fake');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rejected' } });
    const paying = run.statuses.lastIndexOf('paying');
    expect(paying).toBeGreaterThanOrEqual(0);
    expect(run.statuses.slice(paying + 1)).toContain('ordered');
    expect(run.statuses.at(-1)).toBe('ordered');
    run.wallet.behaviour = 'sign';
    await run.session.pay('Fake');
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store' });
  });

  it('shows the cancellation when the store cancelled while the wallet was open', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    run.wallet.duringPrompt = async () => {
      const current = await recordOf(run.offer);
      await store.update(current.orderId, current.version, {
        status: { status: 'cancelled', at: NOW + 40 },
      });
    };
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({ kind: 'cancelled' });
  });

  it('another tab hears the order is open again', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    const otherStatuses: CheckoutState[] = [];
    const other = new CheckoutSession(run.offer, {
      ...run.deps,
      onView: () => undefined,
      onStatus: (state) => otherStatuses.push(state),
    });
    await other.start();
    expect(otherStatuses.at(-1)).toBe('paying');
    // This tab's attempt is released as a decline would release it.
    const current = await recordOf(run.offer);
    await store.clearMarker(
      current.orderId,
      current.version,
      current.marker?.attemptId ?? '',
      'ordered',
    );
    await run.timers.tick();
    await settle();
    expect(otherStatuses.at(-1)).toBe('ordered');
  });

  it('any other wallet failure still waits out the attempt', async () => {
    const run = await setup();
    run.wallet.behaviour = 'throw';
    await run.session.start();
    await run.session.pay('Fake');
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      problem: { reason: 'wallet_failed' },
    });
  });
});
