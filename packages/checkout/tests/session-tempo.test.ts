/**
 * The widget's session paying on Tempo: a fake chain that evaluates log
 * filters, a finalized head the test moves, and an EIP-1193 wallet whose
 * payment lands as a real `TransferWithMemo` receipt.
 */
import { type LoadedOffer, OrderStore, loadOffer } from '@elisym/commerce/buyer';
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
import { type Banner, CheckoutSession, type SessionDeps, type View } from '../src/app/session';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';

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

type Behaviour = 'land' | 'drop' | 'reject' | 'fail' | 'ended-meanwhile';

async function setup() {
  const shop: Shop = makeShop({ caip19: TEMPO_CAIP19, payout: PAYOUT });
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const load = (now: number) =>
    loadOffer(shop.naddr, { client: relays, pageOrigin: PAGE, families: ['evm'], now });
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
      if (wallet.behaviour === 'ended-meanwhile') {
        // Another tab ended the order while this prompt was open; the buyer approves anyway.
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
        land(`0x${call.data.slice(-64)}`);
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
});
