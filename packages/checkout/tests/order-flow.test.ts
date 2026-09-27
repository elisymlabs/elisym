import {
  type OrderMessage,
  buildOrderMessage,
  deriveOrderPaymentReference,
  unwrapOrderMessage,
  wrapOrderMessage,
} from '@elisym/commerce';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadOffer } from '../src/core/offer';
import {
  type OrderDeps,
  applyStatus,
  clockAgrees,
  compareOffers,
  deliveryLink,
  listenForStatus,
  mediumOf,
  placeOrder,
  resumeOrder,
  sendReceipt,
  statusFor,
} from '../src/core/order-flow';
import { type OrderRecord, recordToShow } from '../src/core/order-record';
import { OrderStore, openOrderDatabase } from '../src/core/order-store';
import type { RelayClient } from '../src/core/relay-client';
import { MemoryRelays, NOW, type Shop, inboxList, makeShop, nostrKey } from './fixtures';

const INBOX = ['wss://inbox-a.example.com', 'wss://inbox-b.example.com'];
const PAGE = 'https://merchant.example';

let store: OrderStore;

beforeEach(async () => {
  store = new OrderStore(await openOrderDatabase(new IDBFactory()));
});

async function ready(shop: Shop, relays: MemoryRelays) {
  const loaded = await loadOffer(shop.naddr, {
    client: relays,
    pageOrigin: PAGE,
    families: ['solana'],
    now: NOW,
  });
  if (!loaded.ok) {
    throw new Error(loaded.message);
  }
  const payout = loaded.payouts[0];
  if (payout === undefined) {
    throw new Error('no payout');
  }
  return { loaded, payout };
}

function deps(relays: MemoryRelays): OrderDeps {
  return { store, readClient: relays, clientFor: () => relays };
}

async function placed(shop: Shop, relays: MemoryRelays) {
  const { loaded, payout } = await ready(shop, relays);
  const result = await placeOrder(
    { offer: loaded, payout, chainTime: NOW, deviceTime: NOW + 30, email: 'b@example.com' },
    deps(relays),
  );
  return { result, loaded, payout };
}

/** What the store reads from the order wrap. */
function asStore(shop: Shop, wrap: OrderRecord['orderWrap']) {
  if (wrap === undefined) {
    throw new Error('no wrap');
  }
  const opened = unwrapOrderMessage(wrap, shop.store.secretKey);
  if (opened === undefined) {
    throw new Error('the store cannot open it');
  }
  return opened;
}

/** A status the store sends to the buyer key. */
function storeSays(shop: Shop, record: OrderRecord, message: Partial<OrderMessage> = {}) {
  const status = {
    type: 'status',
    buyerPubkey: record.buyerPubkey,
    orderId: record.orderId,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course' },
    ...message,
  } as OrderMessage;
  return wrapOrderMessage(
    buildOrderMessage(status, NOW + 100),
    shop.store.secretKey,
    record.buyerPubkey,
  ).recipientWrap;
}

describe('placeOrder', () => {
  it('sends a direct order the store can read, and counts it placed once the inbox took it', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { result, loaded } = await placed(shop, relays);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { record } = result;
    expect(record).toMatchObject({
      state: 'ordered',
      inboxRelays: INBOX,
      medium: 'solana-devnet',
      amount: '49000000',
      createdAt: NOW,
    });
    expect(new Set(record.acknowledgedRelays)).toEqual(new Set(INBOX));
    const opened = asStore(shop, record.orderWrap);
    expect(opened.senderPubkey).toBe(record.buyerPubkey);
    expect(opened.createdAt).toBe(NOW);
    expect(opened.message).toMatchObject({
      type: 'order',
      storePubkey: shop.store.pubkey,
      orderId: record.orderId,
      items: [{ product: loaded.productAddress, quantity: 1 }],
      total: { amount: '49', currency: 'USD' },
      email: 'b@example.com',
    });
    // The merchant derives the same reference from what it read.
    expect(record.reference).toBe(
      deriveOrderPaymentReference({
        storePubkey: shop.store.pubkey,
        buyerPubkey: opened.senderPubkey,
        orderId: record.orderId,
      }).solana,
    );
    expect(relays.published.at(-1)?.relays).toEqual(INBOX);
  });

  it('refuses when the device clock is off, or the store names no inbox', async () => {
    const shop = makeShop();
    const withInbox = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { loaded, payout } = await ready(shop, withInbox);
    expect(
      await placeOrder(
        { offer: loaded, payout, chainTime: NOW, deviceTime: NOW + 301 },
        deps(withInbox),
      ),
    ).toEqual({ ok: false, reason: 'clock_skew' });
    const noInbox = new MemoryRelays(shop.events);
    expect(
      await placeOrder({ offer: loaded, payout, chainTime: NOW, deviceTime: NOW }, deps(noInbox)),
    ).toEqual({ ok: false, reason: 'no_store_inbox' });
    expect(await store.forProduct(loaded.productAddress)).toEqual([]);
  });

  it('is not placed while too few inbox relays took it, and becomes placed on resume', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays(
      [...shop.events, inboxList(shop.store, INBOX)],
      [INBOX[1] ?? ''],
    );
    const { result } = await placed(shop, relays);
    expect(result).toMatchObject({ ok: false, reason: 'not_acknowledged' });
    const record = result.record;
    if (record === undefined) {
      throw new Error('no record');
    }
    expect(record.state).toBe('created');
    expect(record.acknowledgedRelays).toEqual([INBOX[0]]);
    relays.refuse = [];
    const resumed = await resumeOrder(record, deps(relays), NOW + 60);
    expect(resumed.record.state).toBe('ordered');
    // The same wrap, byte for byte.
    expect(relays.published.at(-1)?.event).toEqual(record.orderWrap);
  });
});

describe('fresh offers and acknowledgements', () => {
  it('refuses a stale offer, or a payout it does not hold at that price', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { loaded, payout } = await ready(shop, relays);
    const base = { offer: loaded, chainTime: NOW, deviceTime: NOW };
    expect(
      await placeOrder(
        { ...base, payout, deviceTime: NOW + 121, chainTime: NOW + 121 },
        deps(relays),
      ),
    ).toEqual({ ok: false, reason: 'stale_offer' });
    expect(
      await placeOrder(
        { ...base, payout: { ...payout, amount: payout.amount - 1n } },
        deps(relays),
      ),
    ).toEqual({ ok: false, reason: 'stale_offer' });
    expect(await store.forProduct(loaded.productAddress)).toEqual([]);
  });

  it('adds new acknowledgements to earlier ones, counting only the current inbox', async () => {
    const shop = makeShop();
    const [first = '', second = ''] = INBOX;
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)], [second]);
    const { result } = await placed(shop, relays);
    const record = result.record;
    if (record === undefined) {
      throw new Error('no record');
    }
    // Now only the second takes it: with the first's earlier OK, two servers.
    relays.refuse = [first];
    const resumed = await resumeOrder(record, deps(relays), NOW + 60);
    expect(resumed.record.state).toBe('ordered');
    expect(new Set(resumed.record.acknowledgedRelays)).toEqual(new Set(INBOX));
  });

  it('never counts a relay that left the inbox, and orders nothing without an inbox list', async () => {
    const shop = makeShop();
    const [first = '', second = ''] = INBOX;
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)], [second]);
    const { result } = await placed(shop, relays);
    const record = result.record;
    if (record === undefined) {
      throw new Error('no record');
    }
    // The store moved to two new relays; only one of them takes the order.
    const moved = ['wss://new-d.example.com', 'wss://new-e.example.com'];
    await relays.publish(['wss://x.example.com'], inboxList(shop.store, moved, NOW));
    relays.refuse = [moved[1] ?? ''];
    const resumed = await resumeOrder(record, deps(relays), NOW + 60);
    expect(resumed.relays).toContain(first);
    expect(resumed.record.state).toBe('created');

    // The stored record, as it is now (the resume above wrote to it).
    const stored = await store.get(record.orderId);
    if (stored === undefined) {
      throw new Error('no record');
    }
    // Every relay would take it now - but without an inbox list, nothing is ordered.
    relays.refuse = [];
    const lost = new MemoryRelays(shop.events);
    const blind = await resumeOrder(stored, { ...deps(relays), readClient: lost }, NOW + 60);
    expect(blind.record.state).toBe('created');
    expect(blind.record.version).toBe(stored.version);
  });

  it('reports an order placed when another tab ordered it meanwhile', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { loaded, payout } = await ready(shop, relays);
    // Another tab resumes the new record and orders it just before this tab's write.
    let raced = false;
    const racing = {
      add: store.add.bind(store),
      get: store.get.bind(store),
      update: async (...args: Parameters<OrderStore['update']>) => {
        if (!raced) {
          raced = true;
          await store.update(args[0], args[1], { state: 'ordered', acknowledgedRelays: INBOX });
        }
        return store.update(...args);
      },
    } as unknown as OrderStore;
    const result = await placeOrder(
      { offer: loaded, payout, chainTime: NOW, deviceTime: NOW + 30 },
      { ...deps(relays), store: racing },
    );
    expect(result).toMatchObject({ ok: true, record: { state: 'ordered' } });
  });

  it('merges its acknowledgements with those another tab wrote first', async () => {
    const shop = makeShop();
    const first = INBOX[0] ?? '';
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { loaded, payout } = await ready(shop, relays);
    // This tab reaches only the second relay; another tab's resume got the first
    // one and wrote the record first. Together they place the order.
    relays.refuse = [first];
    let raced = false;
    const racing = {
      add: store.add.bind(store),
      get: store.get.bind(store),
      update: async (...args: Parameters<OrderStore['update']>) => {
        if (!raced) {
          raced = true;
          await store.update(args[0], args[1], { acknowledgedRelays: [first] });
        }
        return store.update(...args);
      },
    } as unknown as OrderStore;
    const result = await placeOrder(
      { offer: loaded, payout, chainTime: NOW, deviceTime: NOW + 30 },
      { ...deps(relays), store: racing },
    );
    expect(result).toMatchObject({ ok: true, record: { state: 'ordered' } });
  });

  it('writes nothing on a resume that changes nothing', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { result } = await placed(shop, relays);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const resumed = await resumeOrder(result.record, deps(relays), NOW + 60);
    expect(resumed.record.version).toBe(result.record.version);
  });

  it('never sends a receipt it could not record', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { result } = await placed(shop, relays);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    await store.update(result.record.orderId, result.record.version, { state: 'completed' });
    const sent = relays.published.length;
    const written = await sendReceipt(result.record, '5'.repeat(88), NOW + 60, deps(relays));
    expect(written.ok).toBe(false);
    expect(relays.published).toHaveLength(sent);
  });
});

describe('the receipt and resume', () => {
  it('sends a receipt the store reads under the derived reference, and republishes it as sent', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { result } = await placed(shop, relays);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const written = await sendReceipt(result.record, '5'.repeat(88), NOW + 60, deps(relays));
    if (!written.ok) {
      throw new Error(written.reason);
    }
    const opened = asStore(shop, written.record.receiptWrap);
    expect(opened.message).toEqual({
      type: 'receipt',
      storePubkey: shop.store.pubkey,
      orderId: result.record.orderId,
      payment: { medium: 'solana-devnet', reference: result.record.reference, tx: '5'.repeat(88) },
    });
    // The store moved its inbox: both wraps go again, as they were, to old and new.
    relays.published = [];
    await relays.publish(
      ['wss://x.example.com'],
      inboxList(shop.store, ['wss://new.example.com'], NOW),
    );
    relays.published = [];
    const resumed = await resumeOrder(written.record, deps(relays), NOW + 120);
    expect(resumed.relays).toEqual(['wss://new.example.com', ...INBOX]);
    expect(relays.published.map((entry) => entry.event)).toEqual([
      written.record.orderWrap,
      written.record.receiptWrap,
    ]);
    // Receipts from now on go where the store reads today.
    expect(resumed.record.inboxRelays).toEqual(['wss://new.example.com']);
  });
});

describe('the store status', () => {
  async function ordered() {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
    const { result } = await placed(shop, relays);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return { shop, relays, record: result.record };
  }

  it("accepts only the store's status for this order and this buyer", async () => {
    const { shop, record } = await ordered();
    expect(statusFor(record, storeSays(shop, record))).toMatchObject({ status: 'completed' });
    const stranger = nostrKey();
    const forged = wrapOrderMessage(
      buildOrderMessage(
        {
          type: 'status',
          buyerPubkey: record.buyerPubkey,
          orderId: record.orderId,
          status: 'completed',
        },
        NOW + 100,
      ),
      stranger.secretKey,
      record.buyerPubkey,
    ).recipientWrap;
    expect(statusFor(record, forged)).toBeUndefined();
    expect(
      statusFor(
        record,
        storeSays(shop, record, { orderId: 'b3a7c2d4-0000-4000-8000-000000000000' }),
      ),
    ).toBeUndefined();
    expect(
      statusFor(record, storeSays(shop, record, { buyerPubkey: stranger.pubkey })),
    ).toBeUndefined();
  });

  it('listens back two days and the skew from the order: replies are back-dated', async () => {
    const { record } = await ordered();
    let asked: unknown;
    let keyedWith = '';
    const closed: string[] = [];
    const client = {
      subscribe: (_relays: readonly string[], filter: unknown) => {
        asked = filter;
        return { close: () => closed.push('subscription') };
      },
      close: () => closed.push('client'),
    } as unknown as RelayClient;
    const listening = listenForStatus(
      record,
      INBOX,
      {
        // Its own client, answering AUTH with the buyer key.
        clientFor: (buyerSecretKey) => {
          keyedWith = bytesToHex(buyerSecretKey);
          return client;
        },
      },
      () => undefined,
    );
    expect(keyedWith).toBe(record.buyerSecretKey);
    expect(asked).toEqual({
      kinds: [1059],
      '#p': [record.buyerPubkey],
      since: record.createdAt - 2 * 24 * 60 * 60 - 15 * 60,
    });
    listening.close();
    expect(closed).toEqual(['subscription', 'client']);
  });

  it('hears a delivery, settles the order and pins the store', async () => {
    const { shop, relays, record } = await ordered();
    const heard: string[] = [];
    const listening = listenForStatus(record, record.inboxRelays, deps(relays), (message) => {
      heard.push(message.status);
      void applyStatus(store, record.orderId, message, NOW + 200);
    });
    await relays.publish(INBOX, storeSays(shop, record));
    listening.close();
    expect(heard).toEqual(['completed']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = await store.get(record.orderId);
    expect(settled).toMatchObject({
      state: 'completed',
      status: { status: 'completed', delivery: 'https://shop.example/course' },
    });
    expect(await store.pins(shop.store.pubkey)).toMatchObject({
      pinnedOwnerPubkey: shop.owner.pubkey,
      knownPayouts: [{ address: shop.payout }],
    });
  });

  it('keeps a delivery on an order not yet placed as a note, without settling it', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)], INBOX);
    const { result } = await placed(shop, relays);
    const record = result.record;
    if (record === undefined) {
      throw new Error('no record');
    }
    const message = statusFor(record, storeSays(shop, record));
    if (message === undefined) {
      throw new Error('no status');
    }
    expect(await applyStatus(store, record.orderId, message, NOW + 200)).toMatchObject({
      state: 'created',
      status: { status: 'completed' },
    });
  });

  it('writes a status heard again only once, and retries a write that lost a race', async () => {
    const { shop, record } = await ordered();
    const message = statusFor(record, storeSays(shop, record));
    if (message === undefined) {
      throw new Error('no status');
    }
    let conflicts = 1;
    const racing = {
      get: (orderId: string) => store.get(orderId),
      update: async (...args: Parameters<OrderStore['update']>) => {
        if (conflicts > 0) {
          conflicts -= 1;
          return { ok: false as const, reason: 'conflict' as const };
        }
        return store.update(...args);
      },
      rememberDelivery: store.rememberDelivery.bind(store),
    } as unknown as OrderStore;
    const first = await applyStatus(racing, record.orderId, message, NOW + 200);
    expect(first).toMatchObject({ state: 'completed', status: { status: 'completed' } });
    const again = await applyStatus(store, record.orderId, message, NOW + 400);
    expect(again?.version).toBe(first?.version);
  });

  it('settles on a status heard again once the record can take it', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)], INBOX);
    const { result } = await placed(shop, relays);
    const created = result.record;
    if (created === undefined || created.state !== 'created') {
      throw new Error('expected a created record');
    }
    const message = statusFor(created, storeSays(shop, created));
    if (message === undefined) {
      throw new Error('no status');
    }
    // Heard before the order was acknowledged: kept alone.
    const early = await applyStatus(store, created.orderId, message, NOW + 200);
    expect(early).toMatchObject({ state: 'created', status: { status: 'completed' } });
    // Heard again while it still cannot settle: nothing is written.
    const still = await applyStatus(store, created.orderId, message, NOW + 300);
    expect(still?.version).toBe(early?.version);
    // Once the order is acknowledged it settles at once: the same wrap is not
    // handed on again this session.
    relays.refuse = [];
    const resumed = await resumeOrder(early ?? created, deps(relays), NOW + 60);
    expect(resumed.record.state).toBe('completed');
    expect(await store.pins(shop.store.pubkey)).toMatchObject({
      pinnedOwnerPubkey: shop.owner.pubkey,
    });
    // Heard again later: nothing more to write.
    const again = await applyStatus(store, created.orderId, message, NOW + 400);
    expect(again?.version).toBe(resumed.record.version);
  });

  it('settles a held cancellation on acknowledgement only when it carries a refund', async () => {
    for (const refund of [undefined, { tx: '6'.repeat(88), amount: '49000000' }]) {
      const shop = makeShop();
      const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)], INBOX);
      const { result } = await placed(shop, relays);
      const created = result.record;
      if (created === undefined) {
        throw new Error('no record');
      }
      const message = statusFor(
        created,
        storeSays(shop, created, {
          status: 'cancelled',
          delivery: undefined,
          ...(refund === undefined ? {} : { refund }),
        } as Partial<OrderMessage>),
      );
      if (message === undefined) {
        throw new Error('no status');
      }
      const held = await applyStatus(store, created.orderId, message, NOW + 200);
      relays.refuse = [];
      const resumed = await resumeOrder(held ?? created, deps(relays), NOW + 60);
      expect(resumed.record.state).toBe(refund === undefined ? 'ordered' : 'refunded');
    }
  });

  it('ends an order refunded on a cancellation with a refund, and only notes one without', async () => {
    const { shop, record } = await ordered();
    const plain = statusFor(
      record,
      storeSays(shop, record, { status: 'cancelled', delivery: undefined }),
    );
    if (plain === undefined) {
      throw new Error('no status');
    }
    expect(await applyStatus(store, record.orderId, plain, NOW + 200)).toMatchObject({
      state: 'ordered',
      status: { status: 'cancelled' },
    });
    const refunded = statusFor(
      record,
      storeSays(shop, record, {
        status: 'cancelled',
        delivery: undefined,
        refund: { tx: '6'.repeat(88), amount: '49000000' },
      } as Partial<OrderMessage>),
    );
    if (refunded === undefined) {
      throw new Error('no status');
    }
    expect(await applyStatus(store, record.orderId, refunded, NOW + 300)).toMatchObject({
      state: 'refunded',
      status: { refunded: true },
    });
  });
});

describe('helpers', () => {
  it('links a delivery only over https', () => {
    expect(deliveryLink('https://shop.example/x')).toBe('https://shop.example/x');
    expect(deliveryLink('http://shop.example/x')).toBeUndefined();
    expect(deliveryLink('javascript:alert(1)')).toBeUndefined();
    expect(deliveryLink('LICENSE-KEY-123')).toBeUndefined();
  });

  it('names the receipt medium of each chain', () => {
    expect(mediumOf({ slug: 'solana', network: 'mainnet' })).toBe('solana');
    expect(mediumOf({ slug: 'solana', network: 'devnet' })).toBe('solana-devnet');
    expect(mediumOf({ slug: 'tempo', network: 'mainnet' })).toBe('tempo');
    expect(mediumOf({ slug: 'tempo', network: 'devnet' })).toBe('tempo-moderato');
  });

  it('agrees with chain time within five minutes', () => {
    expect(clockAgrees(NOW, NOW + 300)).toBe(true);
    expect(clockAgrees(NOW, NOW - 301)).toBe(false);
  });

  it('compares a fresh offer with the one confirmed', async () => {
    const shop = makeShop();
    const relays = new MemoryRelays(shop.events);
    const { loaded, payout } = await ready(shop, relays);
    expect(compareOffers(payout, [], loaded)).toBe('same');
    expect(compareOffers({ ...payout, amount: payout.amount + 1n }, [], loaded)).toBe('changed');
    expect(compareOffers(payout, [], { ...loaded, confirm: ['payout_changed'] })).toBe('changed');
    expect(
      compareOffers(payout, ['payout_changed'], { ...loaded, confirm: ['payout_changed'] }),
    ).toBe('same');
    expect(compareOffers(payout, [], { ...loaded, payouts: [] })).toBe('gone');
    const elsewhere = { ...payout, target: { ...payout.target, address: 'Other' } };
    expect(compareOffers(elsewhere, [], loaded)).toBe('gone');
  });
});

describe('which record to show', () => {
  function record(
    orderId: string,
    createdAt: number,
    overrides: Partial<OrderRecord>,
  ): OrderRecord {
    return { orderId, createdAt, state: 'ordered', ...overrides } as OrderRecord;
  }

  it('never lets a finished purchase hide a newer order in progress', () => {
    const done = record('done', 10, {
      state: 'completed',
      status: { status: 'completed', at: 11 },
    });
    const again = record('again', 20, { state: 'paying' });
    expect(recordToShow([done, again])?.orderId).toBe('again');
    expect(recordToShow([done])?.orderId).toBe('done');
  });

  it('puts news first, and an order ended unpaid last', () => {
    const paid = record('paid', 10, { state: 'paid' });
    const blocked = record('blocked', 5, { state: 'blocked' });
    const newer = record('newer', 20, { state: 'ordered' });
    const ended = record('ended', 30, { state: 'ended-unpaid' });
    const done = record('done', 1, { state: 'completed' });
    expect(recordToShow([newer, paid, ended])?.orderId).toBe('paid');
    expect(recordToShow([newer, blocked])?.orderId).toBe('blocked');
    expect(recordToShow([ended, done])?.orderId).toBe('done');
    expect(recordToShow([ended, newer])?.orderId).toBe('newer');
  });
});

// The buyer key is recoverable from the record: it signs the receipt and opens replies.
it('keeps the buyer key it ordered with', async () => {
  const shop = makeShop();
  const relays = new MemoryRelays([...shop.events, inboxList(shop.store, INBOX)]);
  const { result } = await placed(shop, relays);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  expect(hexToBytes(result.record.buyerSecretKey)).toHaveLength(32);
});
