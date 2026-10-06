import { unwrapOrderMessage } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { deliverOrder, publishSelfCopy } from '../src/deliver';
import type { MerchantOrder } from '../src/ledger';
import type { PublishPool } from '../src/publish';
import { T0, USDC_DEVNET_CAIP19, key, signatureOf } from './fixtures';

const RELAYS = ['wss://inbox-a', 'wss://inbox-b', 'wss://inbox-c'];

function recordingPool(sent: { url: string; event: NostrEvent }[]): PublishPool {
  return {
    ensureRelay: async (url) => ({
      publish: async (event: NostrEvent) => {
        sent.push({ url, event });
        return '';
      },
      auth: async () => '',
    }),
  };
}

describe('delivering a paid order', () => {
  it("sends the buyer's reply to the relays not yet taken, and hands back the store's own copy", async () => {
    const store = key();
    const buyer = key();
    const order: MerchantOrder = {
      key: `${buyer.pubkey}:o-1`,
      buyerPubkey: buyer.pubkey,
      orderId: 'b3a7c2d4-0000-4000-8000-00000000f001',
      rumorId: 'r',
      createdAt: T0,
      reference: 'x',
      product: `30402:${'s'.repeat(64)}:course-101`,
      reportedTxs: [],
      paid: {
        signature: signatureOf(61),
        amount: '1000000',
        blockTime: T0,
        caip19: USDC_DEVNET_CAIP19,
        medium: 'solana-devnet',
      },
    };
    const sent: { url: string; event: NostrEvent }[] = [];
    const deps = {
      pool: recordingPool(sent),
      inboxRelays: RELAYS,
      storeSecretKey: store.secretKey,
      auth: async (template: Parameters<typeof finalizeEvent>[0]) =>
        finalizeEvent(template, store.secretKey),
      log: () => undefined,
      now: () => T0 + 10,
    };
    const attempt = await deliverOrder(deps, order, ['wss://inbox-a']);
    expect(sent.map((entry) => entry.url)).toEqual(['wss://inbox-b', 'wss://inbox-c']);
    expect(attempt.taken).toEqual(['wss://inbox-b', 'wss://inbox-c']);
    // What went out is the buyer's wrap; what comes back is the store's own copy.
    expect(unwrapOrderMessage(sent[0]?.event ?? attempt.selfWrap, buyer.secretKey)).toBeDefined();
    expect(attempt.selfWrap.tags).toContainEqual(['p', store.pubkey]);
    expect(unwrapOrderMessage(attempt.selfWrap, store.secretKey)?.message).toMatchObject({
      type: 'status',
      status: 'completed',
    });
    const buyerCopy = unwrapOrderMessage(sent[0]?.event ?? attempt.selfWrap, buyer.secretKey);
    expect(buyerCopy?.message).toMatchObject({ type: 'status', status: 'completed' });
    expect(buyerCopy?.message).not.toHaveProperty('delivery');
    // The copy goes to every inbox relay, including the one that took the buyer's.
    sent.length = 0;
    await publishSelfCopy(deps)(attempt.selfWrap);
    expect(sent.map((entry) => entry.url)).toEqual(RELAYS);
    expect(sent.every((entry) => entry.event.id === attempt.selfWrap.id)).toBe(true);
  });
});
