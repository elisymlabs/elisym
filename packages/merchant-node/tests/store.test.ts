import { evaluateOffer, unwrapOrderMessage } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import { buildDeliveryReply } from '../src/reply';
import {
  buildListingEvent,
  buildStoreWideEvents,
  listingHash,
  listingTerms,
  payoutTerms,
  storeNostrJson,
} from '../src/store-events';
import { D, PAYOUT, T0, USDC_DEVNET_CAIP19, key } from './fixtures';

const CONFIG = {
  name: 'Test shop',
  payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
  inboxRelays: ['wss://inbox.example.com'],
};
const PRODUCT = {
  d: D,
  title: 'Agents 101',
  description: 'Twelve lessons.',
  priceUsd: '1',
  onSale: true,
};
const TEMPO_USDC = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';

describe('the store events', () => {
  it('publish an offer per product the checkout verifies, with the terms it offers', () => {
    const store = key();
    const owner = key();
    const keys = { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey };
    const wide = buildStoreWideEvents(CONFIG, keys, T0, T0);
    const listings = [
      buildListingEvent(PRODUCT, CONFIG.payouts, store.secretKey, T0),
      buildListingEvent(
        { ...PRODUCT, d: 'deposit-10', priceUsd: '10' },
        CONFIG.payouts,
        store.secretKey,
        T0,
      ),
    ];
    const events = [wide.payoutList, ...wide.others, ...listings];
    for (const d of [D, 'deposit-10']) {
      expect(
        evaluateOffer({ storePubkey: store.pubkey, d }, { events }, { now: T0 + 4 * 24 * 60 * 60 }),
      ).toMatchObject({
        ok: true,
        offer: { level: 'C', storePubkey: store.pubkey, ownerPubkey: owner.pubkey },
      });
    }
    expect(listingTerms(PRODUCT, CONFIG.payouts)).toEqual([
      { caip19: USDC_DEVNET_CAIP19, amount: '1000000' },
    ]);
    expect(listingTerms({ priceUsd: '10' }, CONFIG.payouts)).toEqual([
      { caip19: USDC_DEVNET_CAIP19, amount: '10000000' },
    ]);
    expect(payoutTerms(CONFIG.payouts)).toEqual([{ caip19: USDC_DEVNET_CAIP19, payout: PAYOUT }]);
    expect(wide.payoutList.created_at).toBe(T0);
    expect(buildStoreWideEvents(CONFIG, keys, T0 + 3600, T0).payoutList.created_at).toBe(T0);
    const inbox = wide.others.find((event) => event.kind === 10050);
    expect(inbox?.tags).toEqual([['relay', 'wss://inbox.example.com']]);
    expect(inbox?.pubkey).toBe(store.pubkey);
  });

  it('list a stopped product sold out, which every buyer refuses', () => {
    const store = key();
    const owner = key();
    const keys = { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey };
    const wide = buildStoreWideEvents(CONFIG, keys, T0, T0);
    const stopped = buildListingEvent(
      { ...PRODUCT, onSale: false },
      CONFIG.payouts,
      store.secretKey,
      T0,
    );
    expect(stopped.tags).toContainEqual(['visibility', 'sold-out']);
    expect(
      evaluateOffer(
        { storePubkey: store.pubkey, d: D },
        { events: [wide.payoutList, ...wide.others, stopped] },
        { now: T0 + 4 * 24 * 60 * 60 },
      ),
    ).toMatchObject({ ok: false, refusal: 'product_not_on_sale' });
  });

  it("hash a listing's content, never its date; a sold-out one without its coins (M38)", () => {
    const withTempo = [...CONFIG.payouts, { caip19: TEMPO_USDC, address: '0x' + '1'.repeat(40) }];
    const base = listingHash(PRODUCT, CONFIG.payouts);
    expect(listingHash(PRODUCT, CONFIG.payouts)).toBe(base);
    expect(listingHash({ ...PRODUCT, priceUsd: '2' }, CONFIG.payouts)).not.toBe(base);
    expect(listingHash({ ...PRODUCT, title: 'Agents 102' }, CONFIG.payouts)).not.toBe(base);
    expect(listingHash({ ...PRODUCT, description: 'Ten.' }, CONFIG.payouts)).not.toBe(base);
    expect(listingHash({ ...PRODUCT, summary: 'Short' }, CONFIG.payouts)).not.toBe(base);
    expect(listingHash({ ...PRODUCT, onSale: false }, CONFIG.payouts)).not.toBe(base);
    // A coin change republishes an on-sale listing, not a sold-out one.
    expect(listingHash(PRODUCT, withTempo)).not.toBe(base);
    expect(listingHash({ ...PRODUCT, onSale: false }, withTempo)).toBe(
      listingHash({ ...PRODUCT, onSale: false }, CONFIG.payouts),
    );
    // A payout address change alone does not touch a listing.
    expect(listingHash(PRODUCT, [{ caip19: USDC_DEVNET_CAIP19, address: 'other' }])).toBe(base);
  });

  it('names the store and the owner in nostr.json under the nip05 name', () => {
    const store = key();
    const owner = key();
    expect(storeNostrJson({ nip05: 'shop@shop.example' }, store.pubkey, owner.pubkey)).toEqual({
      names: { shop: store.pubkey, owner: owner.pubkey },
    });
    expect(storeNostrJson({ nip05: 'shop.example' }, store.pubkey, owner.pubkey).names._).toBe(
      store.pubkey,
    );
    expect(() =>
      storeNostrJson({ nip05: 'owner@shop.example' }, store.pubkey, owner.pubkey),
    ).toThrow(/owner/);
    // Names are case-insensitive: `Owner` is `owner`.
    expect(() =>
      storeNostrJson({ nip05: 'Owner@shop.example' }, store.pubkey, owner.pubkey),
    ).toThrow(/owner/);
  });
});

describe('buildDeliveryReply', () => {
  it('sends the buyer a completed status with the link and the payment credited', () => {
    const store = key();
    const buyer = key();
    const order = {
      key: 'k',
      buyerPubkey: buyer.pubkey,
      orderId: 'b3a7c2d4-0000-4000-8000-000000000001',
      rumorId: 'r',
      createdAt: T0,
      reference: 'Ref',
      product: `30402:${store.pubkey}:${D}`,
      reportedTxs: [],
      paid: {
        signature: '5'.repeat(88),
        amount: '1000000',
        blockTime: T0,
        caip19: USDC_DEVNET_CAIP19,
        medium: 'solana-devnet',
      },
    };
    const reply = buildDeliveryReply(
      order,
      { method: 'access', value: 'https://shop.example/course' },
      store.secretKey,
      T0 + 10,
    );
    const opened = unwrapOrderMessage(reply.recipientWrap, buyer.secretKey);
    expect(opened).toMatchObject({
      senderPubkey: store.pubkey,
      message: {
        type: 'status',
        orderId: order.orderId,
        status: 'completed',
        delivery: { method: 'access', value: 'https://shop.example/course' },
        receipt: {
          medium: 'solana-devnet',
          tx: '5'.repeat(88),
          amount: '1000000',
          fee: '0',
          caip19: USDC_DEVNET_CAIP19,
        },
      },
    });
    // The store's own copy opens with the store key and carries the same status.
    expect(unwrapOrderMessage(reply.selfWrap, store.secretKey)).toMatchObject({
      senderPubkey: store.pubkey,
      recipientPubkey: buyer.pubkey,
      message: { type: 'status', status: 'completed', receipt: { caip19: USDC_DEVNET_CAIP19 } },
    });
    // An asset the registry no longer knows is left out: the order is still delivered.
    const unknown = buildDeliveryReply(
      {
        ...order,
        paid: { ...order.paid, caip19: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:Gone' },
      },
      { method: 'access', value: 'https://shop.example/course' },
      store.secretKey,
      T0 + 10,
    );
    const openedUnknown = unwrapOrderMessage(unknown.recipientWrap, buyer.secretKey);
    expect(openedUnknown?.message).toMatchObject({ type: 'status', status: 'completed' });
    expect(
      openedUnknown?.message.type === 'status' ? openedUnknown.message.receipt : undefined,
    ).toEqual({ medium: 'solana-devnet', tx: '5'.repeat(88), amount: '1000000', fee: '0' });
    expect(() =>
      buildDeliveryReply(
        { ...order, paid: undefined },
        { method: 'access', value: 'x' },
        store.secretKey,
        T0,
      ),
    ).toThrow(/paid/);
  });
});
