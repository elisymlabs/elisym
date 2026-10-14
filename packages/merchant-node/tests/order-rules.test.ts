import { deriveOrderPaymentReference } from '@elisym/commerce';
import { describe, expect, it } from 'vitest';
import { EARLIEST_ORDER_SECS } from '../src/constants';
import { TEMPO_HASH_RE, isDirectOrder, orderKey, receiptProblem } from '../src/order-rules';
import { T0, key, signatureOf } from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-000000000001';
const TEMPO_TX = `0x${'ab'.repeat(32)}`;

function order(products: string[], quantity = 1) {
  return {
    type: 'order' as const,
    storePubkey: 'a'.repeat(64),
    orderId: ORDER_ID,
    items: products.map((product) => ({ product, quantity })),
    total: { amount: '1', currency: 'USD' },
  };
}

describe('isDirectOrder', () => {
  const first = `30402:${'a'.repeat(64)}:one`;
  const second = `30402:${'a'.repeat(64)}:two`;
  const store = { productAddresses: new Set([first, second]) };

  it('takes one item of any of the given products at quantity 1', () => {
    expect(isDirectOrder(order([first]), T0, store)).toBe(true);
    expect(isDirectOrder(order([second]), T0, store)).toBe(true);
    expect(isDirectOrder(order([second]), EARLIEST_ORDER_SECS, store)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isDirectOrder(order([`30402:${'a'.repeat(64)}:junk`]), T0, store)).toBe(false);
    expect(isDirectOrder(order([first], 2), T0, store)).toBe(false);
    expect(isDirectOrder(order([first, second]), T0, store)).toBe(false);
    expect(isDirectOrder(order([]), T0, store)).toBe(false);
    expect(isDirectOrder(order([first]), EARLIEST_ORDER_SECS - 1, store)).toBe(false);
    expect(isDirectOrder(order([first]), T0, { productAddresses: new Set() })).toBe(false);
  });
});

describe('receiptProblem', () => {
  const store = key();
  const buyer = key();
  const rules = { storePubkey: store.pubkey, mediums: ['solana-devnet', 'tempo-moderato'] };
  const reference = deriveOrderPaymentReference({
    storePubkey: store.pubkey,
    buyerPubkey: buyer.pubkey,
    orderId: ORDER_ID,
  });
  const receipt = (medium: string, ref: string, tx: string) => ({
    type: 'receipt' as const,
    storePubkey: store.pubkey,
    orderId: ORDER_ID,
    payment: { medium, reference: ref, tx },
  });
  const theOrder = { buyerPubkey: buyer.pubkey, orderId: ORDER_ID };

  it('accepts the reference derived for the rail, in the rail spelling', () => {
    expect(
      receiptProblem(receipt('solana-devnet', reference.solana, signatureOf(1)), theOrder, rules),
    ).toBeUndefined();
    expect(
      receiptProblem(receipt('tempo-moderato', reference.tempo, TEMPO_TX), theOrder, rules),
    ).toBeUndefined();
  });

  it('names what is wrong', () => {
    expect(
      receiptProblem(receipt('solana-devnet', reference.tempo, signatureOf(1)), theOrder, rules),
    ).toBe('wrong_reference');
    expect(
      receiptProblem(
        receipt('solana-devnet', reference.solana, signatureOf(1)),
        { buyerPubkey: key().pubkey, orderId: ORDER_ID },
        rules,
      ),
    ).toBe('wrong_reference');
    expect(
      receiptProblem(receipt('solana', reference.solana, signatureOf(1)), theOrder, rules),
    ).toBe('unlisted_medium');
    expect(
      receiptProblem(receipt('solana-devnet', reference.solana, TEMPO_TX), theOrder, rules),
    ).toBe('bad_tx');
    expect(
      receiptProblem(
        receipt('tempo-moderato', reference.tempo, TEMPO_TX.toUpperCase()),
        theOrder,
        rules,
      ),
    ).toBe('bad_tx');
  });
});

describe('receiptProblem with marked Tempo memos', () => {
  const store = key();
  const buyer = key();
  const rules = { storePubkey: store.pubkey, mediums: ['solana-devnet', 'tempo-moderato'] };
  const reference = deriveOrderPaymentReference({
    storePubkey: store.pubkey,
    buyerPubkey: buyer.pubkey,
    orderId: ORDER_ID,
  });
  const other = deriveOrderPaymentReference({
    storePubkey: store.pubkey,
    buyerPubkey: key().pubkey,
    orderId: ORDER_ID,
  });
  const receipt = (medium: string, ref: string, tx: string) => ({
    type: 'receipt' as const,
    storePubkey: store.pubkey,
    orderId: ORDER_ID,
    payment: { medium, reference: ref, tx },
  });
  const theOrder = { buyerPubkey: buyer.pubkey, orderId: ORDER_ID };
  const tempo = (ref: string) =>
    receiptProblem(receipt('tempo-moderato', ref, TEMPO_TX), theOrder, rules);

  it('accepts the legacy and the marked memo of this order', () => {
    expect(tempo(reference.tempo)).toBeUndefined();
    expect(reference.tempoMarked.startsWith('0xfab22e7e')).toBe(true);
    expect(tempo(reference.tempoMarked)).toBeUndefined();
  });

  it('refuses any other memo that looks marked', () => {
    expect(tempo(other.tempoMarked)).toBe('wrong_reference');
    // The magic, then the LAST 28 bytes of the hash.
    expect(tempo(`0xfab22e7e${reference.tempo.slice(10)}`)).toBe('wrong_reference');
    // Another magic before the right 28 bytes.
    expect(tempo(`0xfab22e7f${reference.tempo.slice(2, 58)}`)).toBe('wrong_reference');
    expect(tempo(`0xfab22e7e${'00'.repeat(28)}`)).toBe('wrong_reference');
  });

  it('keeps Solana on its one reference key', () => {
    expect(
      receiptProblem(
        receipt('solana-devnet', reference.tempoMarked, signatureOf(1)),
        theOrder,
        rules,
      ),
    ).toBe('wrong_reference');
    expect(
      receiptProblem(receipt('solana-devnet', reference.solana, signatureOf(1)), theOrder, rules),
    ).toBeUndefined();
  });
});

describe('orderKey and TEMPO_HASH_RE', () => {
  it('keep their spellings', () => {
    expect(orderKey('buyer', 'order')).toBe('buyer:order');
    expect(TEMPO_HASH_RE.test(TEMPO_TX)).toBe(true);
    expect(TEMPO_HASH_RE.test(TEMPO_TX.slice(0, -1))).toBe(false);
  });
});
