import { NATIVE_SOL, USDC_SOLANA_DEVNET } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import type { Paying, Receipt } from '../src/app/session';
import {
  amountText,
  networkLabel,
  paidLine,
  payingLine,
  payoutLabel,
  receiptMoment,
  receiptText,
  shortId,
} from '../src/app/ui/text';

const AT = Date.UTC(2031, 4, 6, 12, 0, 0) / 1000;
const TX = '5'.repeat(88);
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const paying: Paying = {
  amount: '1500000',
  asset: USDC_SOLANA_DEVNET,
  network: 'mainnet',
  chain: 'solana',
};

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    store: 'Demo Shop',
    product: 'Agents 101',
    paying,
    orderId: 'order-1',
    ...overrides,
  };
}

describe('receiptMoment', () => {
  it('the payment first, whatever the kind', () => {
    const shown = receipt({ paid: { tx: TX, at: AT }, answeredAt: AT + 60, orderedAt: AT - 60 });
    for (const kind of ['delivered', 'refunded', 'open'] as const) {
      expect(receiptMoment(shown, kind)).toEqual({ label: 'Payment confirmed on', at: AT });
    }
  });

  it('then the store’s answer to a finished order, never to an open one (P15)', () => {
    const shown = receipt({ paid: { tx: TX }, answeredAt: AT + 60, orderedAt: AT - 60 });
    expect(receiptMoment(shown, 'delivered')).toEqual({ label: 'Completed on', at: AT + 60 });
    expect(receiptMoment(shown, 'refunded')).toEqual({ label: 'Refunded on', at: AT + 60 });
    expect(receiptMoment(shown, 'open')).toEqual({ label: 'Ordered on', at: AT - 60 });
  });

  it('nothing when the receipt has no date', () => {
    expect(receiptMoment(receipt(), 'delivered')).toBeUndefined();
    expect(receiptMoment(receipt({ orderedAt: AT }), 'delivered')).toBeUndefined();
    expect(receiptMoment(receipt(), 'open')).toBeUndefined();
  });
});

describe('receiptText, unchanged by the refactor', () => {
  it('a completed order paid and seen', () => {
    const text = receiptText(
      receipt({ paid: { tx: TX, at: AT }, answeredAt: AT + 60 }),
      'delivered',
    );
    expect(text).toBe(
      [
        'Store: Demo Shop',
        'Product: Agents 101',
        'Paid: 1.5 USDC · Solana',
        `Payment confirmed on: ${when(AT)}`,
        'Order: order-1',
        `Transaction: ${TX}`,
      ].join('\n'),
    );
  });

  it('a completed order known only by the store’s answer', () => {
    expect(receiptText(receipt({ answeredAt: AT + 60 }), 'delivered')).toBe(
      [
        'Store: Demo Shop',
        'Product: Agents 101',
        'Total: 1.5 USDC · Solana',
        `Completed on: ${when(AT + 60)}`,
        'Order: order-1',
      ].join('\n'),
    );
  });

  it('a refund', () => {
    expect(receiptText(receipt({ answeredAt: AT + 60 }), 'refunded')).toBe(
      [
        'Store: Demo Shop',
        'Product: Agents 101',
        'Total: 1.5 USDC · Solana',
        `Refunded on: ${when(AT + 60)}`,
        'Refunded by the store',
        'Order: order-1',
      ].join('\n'),
    );
  });

  it('an open purchase: when it was ordered and where it stands, never an answer date', () => {
    expect(
      receiptText(
        receipt({
          answeredAt: AT + 60,
          orderedAt: AT,
          openStatus: 'waiting_store',
          sent: { tx: TX },
        }),
        'open',
      ),
    ).toBe(
      [
        'Store: Demo Shop',
        'Product: Agents 101',
        'Total: 1.5 USDC · Solana',
        `Ordered on: ${when(AT)}`,
        'Status: waiting for the store',
        'Order: order-1',
        `Transaction sent: ${TX}`,
      ].join('\n'),
    );
  });
});

describe('short forms and amounts', () => {
  it('shortens an order id as a transaction: first 6, last 4', () => {
    expect(shortId('0123456789abcdef-c7e7-47c0-b790-cfdebe6d55a3')).toBe('012345…55a3');
    expect(shortId('order-1')).toBe('order-1');
  });

  it('writes amounts whole, with no exponent, for 6 and 18 decimals', () => {
    expect(amountText({ ...paying, amount: '1500000' })).toBe('1.5 USDC');
    const eth = { ...NATIVE_SOL, token: 'eth', symbol: 'ETH', decimals: 18 };
    expect(amountText({ ...paying, asset: eth, amount: '1' })).toBe('0.000000000000000001 ETH');
    expect(amountText({ ...paying, asset: eth, amount: '123456789012345678901' })).toBe(
      '123.456789012345678901 ETH',
    );
  });
});

describe('network labels', () => {
  it('real money: the chain alone; a test network: the chain and the network', () => {
    expect(networkLabel('solana', 'mainnet')).toBe('Solana');
    expect(networkLabel('tempo', 'mainnet')).toBe('Tempo');
    expect(networkLabel('solana', 'devnet')).toBe('Solana devnet');
    expect(networkLabel('tempo', 'devnet')).toBe('Tempo devnet');
  });

  it('every line that names a network uses that one label', () => {
    const tempo: Paying = { ...paying, chain: 'tempo' };
    expect(payoutLabel(paying)).toBe('USDC · Solana');
    expect(payoutLabel(tempo)).toBe('USDC · Tempo');
    expect(payingLine(paying)).toBe('Paying 1.5 USDC · Solana');
    expect(paidLine(paying)).toBe('1.5 USDC · Solana');
    expect(paidLine({ ...paying, network: 'devnet' })).toBe('1.5 USDC · Solana devnet');
  });
});
