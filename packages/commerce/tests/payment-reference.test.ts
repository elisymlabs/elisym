import { PaymentRequestV2Schema } from '@elisym/pay-core';
import { isAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { deriveOrderPaymentReference } from '../src/orders/payment-reference';

const STORE = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const ORDER_ID = '8f14e45f-ceea-467a-9575-1b2c3d4e5f60';

describe('deriveOrderPaymentReference', () => {
  it('is sha256 over the prefixed store, buyer and order id, spelled per rail', () => {
    // Computed independently: sha256("elisym-order-payment:v1:<store>:<buyer>:<orderId>").
    expect(
      deriveOrderPaymentReference({ storePubkey: STORE, buyerPubkey: BUYER, orderId: ORDER_ID }),
    ).toEqual({
      solana: '9X2A3QwTyptFanKJABbs62fSYnsBqUdXZrmeiJRHwGy2',
      tempo: '0x7e8e3a05d7b311fe99a4327022fc7f3d0990b07997a316909bdc1de60bf807fd',
    });
  });

  it('changes with each of its inputs, so no two orders share a reference', () => {
    const base = { storePubkey: STORE, buyerPubkey: BUYER, orderId: ORDER_ID };
    const seen = new Set(
      [
        base,
        { ...base, storePubkey: 'c'.repeat(64) },
        { ...base, buyerPubkey: 'c'.repeat(64) },
        { ...base, orderId: `${ORDER_ID.slice(0, -1)}1` },
        // The fields cannot slide into each other: a hex key holds no separator.
        { ...base, storePubkey: BUYER, buyerPubkey: STORE },
      ].map((input) => deriveOrderPaymentReference(input).tempo),
    );
    expect(seen.size).toBe(5);
  });

  it('is a reference and a memo each rail accepts', () => {
    const reference = deriveOrderPaymentReference({
      storePubkey: STORE,
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
    });
    expect(isAddress(reference.solana)).toBe(true);
    const request = PaymentRequestV2Schema.safeParse({
      v: 2,
      chain: 'eip155:4217',
      asset: 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50',
      recipient: '0x5696da2cecea22f127948458382ac2c59bc8e4bb',
      amount: '1000',
      memo: reference.tempo,
      created_at: 1_790_000_000,
      expiry_secs: 600,
    });
    expect(request.success).toBe(true);
  });

  it('refuses keys that are not lowercase hex and an order id the protocol refuses', () => {
    const base = { storePubkey: STORE, buyerPubkey: BUYER, orderId: ORDER_ID };
    for (const input of [
      { ...base, storePubkey: STORE.toUpperCase() },
      { ...base, buyerPubkey: 'npub1xyz' },
      { ...base, orderId: 'short' },
      { ...base, orderId: 'has:colon-inside' },
    ]) {
      expect(() => deriveOrderPaymentReference(input)).toThrow();
    }
  });
});
