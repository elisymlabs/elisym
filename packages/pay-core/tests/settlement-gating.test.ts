/**
 * Settlement gating: an `eip3009` chain (Ethereum, Arbitrum, Base) is in the
 * registry and is EVM, but every Tempo path refuses it. A Base USDC payout never
 * reaches a Tempo request, a Tempo verdict or a Tempo outcome - none of them
 * may read "`eip155:` means Tempo".
 */
import { describe, expect, it } from 'vitest';
import { resolveTempoTransferOutcome } from '../src/evm/outcome';
import { createTempoPaymentRequest } from '../src/evm/request';
import { verifyTempoPayment } from '../src/evm/verify';
import type { ParsedPaymentRequestV2 } from '../src/payment/schema-v2';
import { EIP3009_USDC } from './eip3009-coins';

const PAYER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const RECIPIENT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const MEMO = `0x${'5a'.repeat(32)}`;
const HASH = `0x${'ab'.repeat(32)}`;

/** A client that fails the test if anything reads through it. */
const UNREAD = {
  request: () => {
    throw new Error('no Tempo path may read for an eip3009 chain');
  },
};

describe('the eip3009 USDC checked below', () => {
  it('are all six: three chains, mainnet and devnet', () => {
    expect(EIP3009_USDC.map(({ chain }) => chain.chainName)).toEqual([
      'Ethereum',
      'Sepolia',
      'Arbitrum One',
      'Arbitrum Sepolia',
      'Base',
      'Base Sepolia',
    ]);
  });
});

describe.each(EIP3009_USDC)(
  'the Tempo paths refuse $chain.chainName',
  ({ chain, asset, caip19 }) => {
    const usdc = asset.mint ?? '';
    it('verifyTempoPayment refuses its request as wrong_chain, reading nothing', async () => {
      const request = {
        v: 2,
        chain: chain.caip2,
        asset: caip19,
        recipient: RECIPIENT,
        amount: '1000000',
        memo: MEMO,
        created_at: 1_789_400_000,
        expiry_secs: 600,
      } as ParsedPaymentRequestV2;
      expect(
        await verifyTempoPayment(UNREAD, request, { txSignature: HASH, fromBlock: 1 }),
      ).toEqual({
        outcome: 'refused',
        code: 'wrong_chain',
      });
    });

    it('resolveTempoTransferOutcome refuses to read it', async () => {
      await expect(
        resolveTempoTransferOutcome(
          UNREAD,
          [{ token: usdc, from: PAYER, to: RECIPIENT, amount: 1_000_000n, memo: MEMO }],
          { chain, hash: HASH, floor: 1, validBefore: 1_789_400_600 },
        ),
      ).rejects.toThrow(/cannot read/);
    });

    it('createTempoPaymentRequest refuses it before any read', async () => {
      await expect(
        createTempoPaymentRequest(UNREAD, chain, {
          recipient: RECIPIENT,
          amount: 1_000_000n,
          asset,
          feeTerms: { feeBps: 0, treasury: '' },
        }),
      ).rejects.toThrow(/not a Tempo chain/);
    });
  },
);
