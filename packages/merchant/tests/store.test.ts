import { evaluateOffer, unwrapOrderMessage } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import { buildDeliveryReply } from '../src/reply';
import { buildStoreEvents } from '../src/store-events';
import { D, PAYOUT, T0, USDC_DEVNET_CAIP19, key } from './fixtures';

const CONFIG = {
  name: 'Test shop',
  product: { d: D, title: 'Agents 101', description: 'Twelve lessons.', priceUsd: '1' },
  payouts: [{ caip19: USDC_DEVNET_CAIP19, address: PAYOUT }],
  inboxRelays: ['wss://inbox.example.com'],
};

describe('buildStoreEvents', () => {
  it('publishes an offer the checkout verifies, and records the terms it offers', () => {
    const store = key();
    const owner = key();
    const built = buildStoreEvents(
      CONFIG,
      { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey },
      T0,
    );
    const verification = evaluateOffer(
      { storePubkey: store.pubkey, d: D },
      { events: built.events },
      { now: T0 + 4 * 24 * 60 * 60 },
    );
    expect(verification).toMatchObject({
      ok: true,
      offer: { level: 'C', storePubkey: store.pubkey, ownerPubkey: owner.pubkey },
    });
    expect(built.terms).toEqual([
      { caip19: USDC_DEVNET_CAIP19, payout: PAYOUT, amount: '1000000' },
    ]);
    const payto = built.events.find((event) => event.kind === 10133);
    expect(payto?.created_at).toBe(T0);
    // An unchanged payout list keeps its first date when published again.
    const again = buildStoreEvents(
      CONFIG,
      { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey },
      T0 + 3600,
      { paytoCreatedAt: T0 },
    );
    expect(again.events.find((event) => event.kind === 10133)?.created_at).toBe(T0);
    expect(again.events.find((event) => event.kind === 30402)?.created_at).toBe(T0 + 3600);
    const inbox = built.events.find((event) => event.kind === 10050);
    expect(inbox?.tags).toEqual([['relay', 'wss://inbox.example.com']]);
    expect(inbox?.pubkey).toBe(store.pubkey);
  });

  it('names the store and the owner in nostr.json under the nip05 name', () => {
    const store = key();
    const owner = key();
    const keys = { storeSecretKey: store.secretKey, ownerSecretKey: owner.secretKey };
    expect(buildStoreEvents({ ...CONFIG, nip05: 'shop@shop.example' }, keys, T0).nostrJson).toEqual(
      {
        names: { shop: store.pubkey, owner: owner.pubkey },
      },
    );
    expect(buildStoreEvents({ ...CONFIG, nip05: 'shop.example' }, keys, T0).nostrJson.names._).toBe(
      store.pubkey,
    );
    expect(() => buildStoreEvents({ ...CONFIG, nip05: 'owner@shop.example' }, keys, T0)).toThrow(
      /owner/,
    );
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
        receipt: { medium: 'solana-devnet', tx: '5'.repeat(88), amount: '1000000', fee: '0' },
      },
    });
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
