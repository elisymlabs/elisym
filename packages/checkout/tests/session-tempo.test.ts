/**
 * The widget's session paying on Tempo: a fake chain that evaluates log
 * filters, a finalized head the test moves, and an EIP-1193 wallet whose
 * payment lands as a real `TransferWithMemo` receipt.
 */
import { type OrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import { type LoadedOffer, OrderStore, applyStatus, loadOffer } from '@elisym/commerce/buyer';
import type { OrderRecord } from '@elisym/commerce/buyer';
import type { TempoWallet } from '@elisym/commerce/buyer';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryRelays,
  NOW,
  type Shop,
  inboxList,
  makeShop,
} from '../../commerce/tests/buyer/fixtures';
import { TRANSFER_WITH_MEMO_TOPIC } from '../../pay-core/src/evm/constants';
import { type FakeChainOptions, fakeTempoChain } from '../../pay-core/tests/tempo-chain';
import { TempoChainUnsupported } from '../src/app/evm-wallets';
import { type Banner, CheckoutSession, type SessionDeps, type View } from '../src/app/session';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';
import { framePage } from './page-harness';

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

beforeEach(async () => {
  store = new OrderStore(new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())));
});

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

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
  for (let turn = 0; turn < 60; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  const wallet = { behaviour: 'land' as Behaviour, requests: 0 };
  const tempoWallet: TempoWallet = {
    address: PAYER,
    chainId: async () => 42431,
    sendCall: async (call) => {
      wallet.requests += 1;
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
  const timers = new Timers();
  const views: View[] = [];
  const banners: Banner[] = [];
  let clock = NOW + 30;
  const deps: SessionDeps = {
    store,
    readClient: relays,
    clientFor: () => relays,
    rpcFor: () => undefined,
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
    onStatus: () => undefined,
    onBanner: (banner) => banners.push(banner),
  };
  return {
    shop,
    relays,
    offer,
    deps,
    wallet,
    timers,
    views,
    banners,
    land,
    pastDeadline,
    completed,
    receipts: options.receipts,
    session: new CheckoutSession(offer, deps),
    advance: (seconds: number) => {
      clock += seconds;
    },
    last: () => views.at(-1),
  };
}

async function records(offer: Ready): Promise<OrderRecord[]> {
  return store.forProduct(offer.productAddress);
}

describe('paying on Tempo in the widget', () => {
  it('pays with an EIP-6963 wallet and waits for the store', async () => {
    const run = await setup();
    await run.session.start();
    expect(run.last()).toMatchObject({ kind: 'offer', wallets: [{ name: 'MetaMask' }] });
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(1);
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store', noAnswer: false });
    const [record] = await records(run.offer);
    expect(record).toMatchObject({ state: 'paid', paidTx: HASH });
    // Thirty minutes on and the store still silent: contact it.
    run.advance(31 * 60);
    // The page stays open: the note comes by its own timer, not by a reload.
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'waiting_store', noAnswer: true });
  });

  it('ends the order on a rejection, with no old-prompt question for the next one', async () => {
    const run = await setup();
    run.wallet.behaviour = 'reject';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rejected' } });
    const [ended] = await records(run.offer);
    expect(ended).toMatchObject({ state: 'ended-unpaid', endedBy: 'rejected' });
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(2);
  });

  it('ends an attempt proven over, and asks about the old prompt before the next payment', async () => {
    const run = await setup();
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', tempo: true, canRetry: false });
    const [paying] = await records(run.offer);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'attempt_over' } });
    const [over] = await records(run.offer);
    expect(over).toMatchObject({ state: 'ended-unpaid', endedBy: 'over' });
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt', orders: 1 });
    const requested = run.wallet.requests;
    await run.session.confirmOldPrompt();
    expect(run.wallet.requests).toBe(requested + 1);
  });

  it('finds a late approval of an ended order on the next load, as a banner', async () => {
    const run = await setup();
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    const [paying] = await records(run.offer);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    run.session.dispose();
    const [over] = await records(run.offer);
    // The old prompt is approved after all.
    run.land((over as OrderRecord).reference);
    const again = new CheckoutSession(run.offer, run.deps);
    await again.start();
    expect(run.banners).toEqual([
      expect.objectContaining({ orderId: (over as OrderRecord).orderId, state: 'paid' }),
    ]);
    expect((await records(run.offer))[0]).toMatchObject({ state: 'paid', paidTx: HASH });
  });

  it('watches a payment approved after another tab ended the order, and shows it when found', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    // Until it is found, no other payment of the product: the approval is in flight.
    run.wallet.behaviour = 'land';
    const before = run.wallet.requests;
    await run.session.pay('MetaMask');
    expect(run.wallet.requests).toBe(before);
    expect(run.last()).toMatchObject({ problem: { reason: 'late_approval' } });
    await run.timers.tick();
    expect(run.banners).toEqual([expect.objectContaining({ state: 'paid' })]);
    expect((await records(run.offer))[0]).toMatchObject({ state: 'paid', paidTx: HASH });
  });

  it('asks for a fixed email before the wallet connects or switches chain', async () => {
    const run = await setup();
    run.deps.collectEmail = true;
    let connects = 0;
    run.deps.tempoWallets = () => [
      {
        name: 'MetaMask',
        connect: async () => {
          connects += 1;
          throw new Error('never connected');
        },
      },
    ];
    await run.session.start();
    run.session.setEmail('not an email');
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'bad_email' } });
    expect(connects).toBe(0);
    expect(await records(run.offer)).toHaveLength(0);
  });

  it('counts down to the request’s late deadline only while the wallet has not answered', async () => {
    const run = await setup();
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    const [paying] = await records(run.offer);
    const request = JSON.parse(paying?.paymentRequest ?? '{}') as {
      created_at: number;
      expiry_secs: number;
    };
    const now = NOW + 30;
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      tempo: true,
      signed: false,
      requestEndsIn: { seconds: request.created_at + request.expiry_secs + 1800 - now, at: now },
    });
  });

  it('counts nothing down once the wallet returned a hash', async () => {
    const run = await setup();
    run.wallet.behaviour = 'drop';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'waiting_payment', tempo: true, signed: true });
    expect(run.last()).not.toHaveProperty('requestEndsIn');
  });

  it('changes no payout under the old-prompt question, and asks it again after a redraw', async () => {
    const run = await setup();
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    const [paying] = await records(run.offer);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    run.wallet.behaviour = 'land';
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt', orders: 1, paying: { chain: 'tempo' } });
    const shown = run.views.length;
    run.session.choosePayout(0);
    expect(run.views.length).toBe(shown);
    // A wallet registers: the offer is drawn again, and the question is gone.
    run.session.refresh();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    const redrawn = run.views.length;
    run.session.choosePayout(0);
    expect(run.views.length).toBe(redrawn + 1);
    const requested = run.wallet.requests;
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'old_prompt', orders: 1 });
    expect(run.wallet.requests).toBe(requested);
  });

  it('names the Tempo payment on the progress screens', async () => {
    const run = await setup();
    run.wallet.behaviour = 'drop';
    await run.session.start();
    await run.session.pay('MetaMask');
    const signing = run.views.find((view) => view.kind === 'working' && view.step === 'signing');
    expect(signing).toMatchObject({
      paying: { amount: PRICE.toString(), network: 'devnet', chain: 'tempo' },
    });
    expect(run.last()).toMatchObject({
      kind: 'waiting_payment',
      tempo: true,
      paying: { chain: 'tempo', network: 'devnet' },
    });
  });
});

describe('the Tempo wallet connect', () => {
  it('can be cancelled while it waits, and a late refusal draws nothing', async () => {
    const run = await setup();
    await run.session.start();
    let refuse: (error: unknown) => void = () => undefined;
    const pending = new Promise<TempoWallet>((_, failWith) => {
      refuse = failWith;
    });
    run.deps.tempoWallets = () => [{ name: 'MetaMask', connect: () => pending }];
    const pressed = run.session.pay('MetaMask');
    await settle();
    expect(run.last()).toMatchObject({ kind: 'working', step: 'checking', cancellable: true });
    run.session.cancel();
    expect(run.last()).toMatchObject({ kind: 'offer' });
    expect(run.last()).not.toHaveProperty('problem');
    const views = run.views.length;
    refuse(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    await pressed;
    await settle();
    expect(run.views.length).toBe(views);
    expect(await records(run.offer)).toHaveLength(0);
  });

  it('names a wallet that cannot use Tempo, and a refusal, in the open wallet list', async () => {
    const run = await setup();
    await run.session.start();
    run.deps.tempoWallets = () => [
      { name: 'MetaMask', connect: () => Promise.reject(new TempoChainUnsupported()) },
    ];
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'tempo_unsupported' } });
    run.deps.tempoWallets = () => [
      {
        name: 'MetaMask',
        connect: () => Promise.reject(Object.assign(new Error('declined'), { code: 4001 })),
      },
    ];
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'rejected' } });
    run.deps.tempoWallets = () => [
      {
        name: 'MetaMask',
        connect: () => Promise.reject(Object.assign(new Error('pending'), { code: -32002 })),
      },
    ];
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'wallet_busy' } });
  });
});

/** The same offer with every payout's explorer page on another (non-https) address. */
function withExplorer(explorerTx: string) {
  return (offer: Ready): Ready => ({
    ...offer,
    offer: {
      ...offer.offer,
      payouts: offer.offer.payouts.map((payout) => ({
        ...payout,
        caip19: { ...payout.caip19, chain: { ...payout.caip19.chain, explorerTx } },
      })),
    },
    payouts: offer.payouts.map((payout) => ({
      ...payout,
      target: {
        ...payout.target,
        caip19: {
          ...payout.target.caip19,
          chain: { ...payout.target.caip19.chain, explorerTx },
        },
      },
    })),
  });
}

describe('the receipt of a Tempo order', () => {
  for (const explorerTx of ['http://explorer.example/tx/{tx}', '']) {
    it(`links no explorer page that is not https (${explorerTx || 'none'})`, async () => {
      const run = await setup(withExplorer(explorerTx));
      await run.session.start();
      await run.session.pay('MetaMask');
      await run.timers.tick();
      const [record] = await records(run.offer);
      if (record === undefined) {
        throw new Error('no record');
      }
      const status = {
        type: 'status',
        buyerPubkey: record.buyerPubkey,
        orderId: record.orderId,
        status: 'completed',
        delivery: { method: 'access', value: 'https://shop.example/course' },
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
      const view = run.last();
      expect(view).toMatchObject({ kind: 'delivered' });
      const receipt = view?.kind === 'delivered' ? view.receipt : undefined;
      expect(receipt?.paid?.tx).toBe(HASH);
      expect(receipt?.paid).not.toHaveProperty('explorer');
    });
  }
});

describe('the transaction a Tempo receipt names', () => {
  function sentOf(view: View | undefined) {
    return view?.kind === 'delivered' ? view.receipt?.sent : undefined;
  }

  it('names the hash this checkout sent, once its receipt succeeded, when the store answered first', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    const [record] = await records(run.offer);
    await run.completed(record as OrderRecord);
    await settle();
    const view = run.last();
    expect(view).toMatchObject({ kind: 'delivered' });
    expect(view?.kind === 'delivered' ? view.receipt?.paid : undefined).toBeUndefined();
    expect(sentOf(view)?.tx).toBe(HASH);
  });

  it('names nothing for a hash whose transaction reverted', async () => {
    const run = await setup();
    await run.session.start();
    await run.session.pay('MetaMask');
    run.receipts[HASH] = { ...(run.receipts[HASH] as object), status: '0x0' };
    const [record] = await records(run.offer);
    await run.completed(record as OrderRecord);
    await settle();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(sentOf(run.last())).toBeUndefined();
  });

  it('names a hash the wallet returned after the store had answered (never saved)', async () => {
    const run = await setup();
    run.wallet.behaviour = 'answered-meanwhile';
    await run.session.start();
    await run.session.pay('MetaMask');
    await settle();
    const [record] = await records(run.offer);
    expect(record?.marker?.rail === 'tempo' ? record.marker.txHash : 'unexpected').toBeUndefined();
    expect(run.last()).toMatchObject({ kind: 'delivered' });
    expect(sentOf(run.last())?.tx).toBe(HASH);
  });

  it('names the late hash of an ended order the store then delivered, once the chain shows it', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile-unseen';
    await run.session.start();
    await run.session.pay('MetaMask');
    expect(run.last()).toMatchObject({ kind: 'offer', problem: { reason: 'late_approval' } });
    const [ended] = await records(run.offer);
    if (ended === undefined) {
      throw new Error('no record');
    }
    expect(ended).toMatchObject({ state: 'ended-unpaid' });
    // The approval lands now; the watcher has not looked again before the store answers.
    run.land(ended.reference);
    await run.completed(ended);
    await settle();
    const view = run.last();
    expect(view).toMatchObject({ kind: 'delivered' });
    expect(view?.kind === 'delivered' ? view.receipt?.paid : undefined).toBeUndefined();
    expect(sentOf(view)?.tx).toBe(HASH);
  });

  it('still names the late hash when its watcher closed before the store answer was shown', async () => {
    const run = await setup();
    run.wallet.behaviour = 'ended-meanwhile-unseen';
    await run.session.start();
    await run.session.pay('MetaMask');
    const [ended] = await records(run.offer);
    if (ended === undefined) {
      throw new Error('no record');
    }
    // Another tab hears the delivery first: the watcher finds the order closed and stops.
    const delivery = {
      type: 'status',
      buyerPubkey: ended.buyerPubkey,
      orderId: ended.orderId,
      status: 'completed',
      delivery: { method: 'access', value: 'https://shop.example/course' },
    } as OrderMessage;
    if (delivery.type !== 'status') {
      throw new Error('not a status');
    }
    await applyStatus(store, ended.orderId, delivery, NOW + 100);
    await run.timers.tick();
    expect(run.banners).toEqual([expect.objectContaining({ state: 'completed' })]);
    expect(run.last()).toMatchObject({ kind: 'offer' });
    // The approval shows on the chain after all; this tab then hears the answer.
    run.receipts[HASH] = { transactionHash: HASH, status: '0x1', logs: [] };
    await run.completed(ended);
    await settle();
    const view = run.last();
    expect(view).toMatchObject({ kind: 'delivered' });
    expect(sentOf(view)?.tx).toBe(HASH);
  });
});

/** The fixture store is level C: a page with a reference needs level A on its domain. */
function levelA(offer: Ready): Ready {
  return { ...offer, offer: { ...offer.offer, level: 'A', domain: 'merchant.example' } };
}

describe('another account in the same browser, on Tempo', () => {
  it('a late approval of another account’s ended order is stored, never a banner here', async () => {
    const run = await setup(levelA);
    run.wallet.behaviour = 'fail';
    const theirs = new CheckoutSession(run.offer, { ...run.deps, customerRef: 'user_a' });
    await theirs.start();
    await theirs.pay('MetaMask');
    const [paying] = await records(run.offer);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    theirs.dispose();
    const [over] = await records(run.offer);
    run.land((over as OrderRecord).reference);
    const views: View[] = [];
    const page = new CheckoutSession(run.offer, {
      ...run.deps,
      customerRef: 'user_b',
      onView: (view) => views.push(view),
    });
    await page.start();
    // Reconciled here (the record is paid now), never announced to this account.
    expect((await records(run.offer))[0]).toMatchObject({ state: 'paid', paidTx: HASH });
    expect(run.banners).toEqual([]);
    expect(views.at(-1)).toMatchObject({ kind: 'offer' });
  });

  it('another account’s attempt holding the product: a note, then the offer once it is proven over', async () => {
    const run = await setup(levelA);
    run.wallet.behaviour = 'fail';
    const theirs = new CheckoutSession(run.offer, { ...run.deps, customerRef: 'user_a' });
    await theirs.start();
    await theirs.pay('MetaMask');
    theirs.dispose();
    const [paying] = await records(run.offer);
    expect(paying).toMatchObject({ state: 'paying', customerRef: 'user_a' });
    const views: View[] = [];
    const page = new CheckoutSession(run.offer, {
      ...run.deps,
      customerRef: 'user_b',
      onView: (view) => views.push(view),
    });
    await page.start();
    run.wallet.behaviour = 'land';
    await page.pay('MetaMask');
    expect(views.at(-1)).toMatchObject({ kind: 'offer', problem: { reason: 'other_purchase' } });
    // Their request lapses with nothing on chain: this page's follower ends it, silently.
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    const ended = (await records(run.offer)).find((record) => record.customerRef === 'user_a');
    expect(ended).toMatchObject({ state: 'ended-unpaid', endedBy: 'over' });
    expect(views.at(-1)).toMatchObject({ kind: 'offer' });
    expect(views.at(-1)).not.toHaveProperty('problem');
    expect(run.banners).toEqual([]);
  });

  it('another account’s ended order with an open prompt: asked about by count and date only, then paid', async () => {
    const run = await setup(levelA);
    run.wallet.behaviour = 'fail';
    const theirs = new CheckoutSession(run.offer, { ...run.deps, customerRef: 'user_a' });
    await theirs.start();
    await theirs.pay('MetaMask');
    const [paying] = await records(run.offer);
    run.pastDeadline(paying as OrderRecord);
    await run.timers.tick();
    theirs.dispose();
    const [ended] = await records(run.offer);
    expect(ended).toMatchObject({ state: 'ended-unpaid', endedBy: 'over', customerRef: 'user_a' });
    const views: View[] = [];
    const page = new CheckoutSession(run.offer, {
      ...run.deps,
      customerRef: 'user_b',
      onView: (view) => views.push(view),
    });
    await page.start();
    run.wallet.behaviour = 'land';
    await page.pay('MetaMask');
    const asked = views.at(-1);
    expect(asked).toMatchObject({ kind: 'old_prompt', orders: 1 });
    // Only the count and the date come from their order; the rest is this page's terms.
    expect(
      JSON.stringify(asked, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain((ended as OrderRecord).orderId);
    const requested = run.wallet.requests;
    await page.confirmOldPrompt();
    expect(run.wallet.requests).toBe(requested + 1);
    const mine = (await records(run.offer)).find((record) => record.customerRef === 'user_b');
    expect(mine?.confirmedOverIds).toEqual([(ended as OrderRecord).orderId]);
    expect(run.banners).toEqual([]);
  });
});

describe('what a page hears of a refusal with an earlier Tempo order', () => {
  async function frame(run: Awaited<ReturnType<typeof setup>>) {
    const page = await framePage({
      params: {
        naddr: run.shop.naddr,
        network: 'devnet',
        strictOrigin: false,
        theme: 'auto',
        collectEmail: false,
        display: 'modal',
      },
      pageOrigin: PAGE,
      client: run.relays,
      store,
      loadOffer: async () => ({ ok: false, refusal: 'no_payable_payout', message: 'none' }),
      session: {
        readClient: run.relays,
        clientFor: () => run.relays,
        rpcFor: () => undefined,
        wallets: () => [],
        tempoFor: run.deps.tempoFor,
        tempoWallets: run.deps.tempoWallets,
        tempoChainTime: run.deps.tempoChainTime,
        reloadOffer: run.deps.reloadOffer,
        now: run.deps.now,
        chainTime: run.deps.chainTime,
        setInterval: run.timers.set,
        clearInterval: run.timers.clear,
        setTimeout: run.timers.set,
        clearTimeout: run.timers.clear,
      },
    });
    await run.timers.tick();
    await page.settle();
    page.dispose();
    return page;
  }

  /** A Tempo order whose wallet failed: paying, its request still open. */
  async function payingOrder(run: Awaited<ReturnType<typeof setup>>): Promise<OrderRecord> {
    run.wallet.behaviour = 'fail';
    await run.session.start();
    await run.session.pay('MetaMask');
    run.session.dispose();
    const [paying] = await records(run.offer);
    expect(paying).toMatchObject({ state: 'paying' });
    return paying as OrderRecord;
  }

  const NO_ORDER = ['resize:60', 'status:refused', 'resize:180'];

  it('with no order', async () => {
    const run = await setup();
    expect((await frame(run)).heard).toEqual(NO_ORDER);
  });

  it('a paying Tempo order: the buyer sees it, the page hears the no-order sequence', async () => {
    const run = await setup();
    await payingOrder(run);
    const page = await frame(run);
    expect(page.shown().view?.kind).toBe('waiting_payment');
    expect(page.heard).toEqual(NO_ORDER);
  });

  it('a blocked Tempo order: the buyer sees it, the page hears the no-order sequence', async () => {
    const run = await setup();
    const paying = await payingOrder(run);
    const blocked = await store.update(paying.orderId, paying.version, { state: 'blocked' });
    expect(blocked.ok).toBe(true);
    const page = await frame(run);
    expect(page.shown().view?.kind).toBe('blocked');
    expect(page.heard).toEqual(NO_ORDER);
  });
});
