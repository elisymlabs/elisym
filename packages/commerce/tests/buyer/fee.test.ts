import { FeeConfigError } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import {
  NO_FEE,
  feePlanFor,
  feeRefusalOf,
  planFee,
  sameFeePlan,
  storedFeePlan,
} from '../../src/buyer/fee';
import { loadOffer } from '../../src/buyer/offer';
import { MemoryRelays, NOW, makeShop, solanaAddress } from './fixtures';

const TREASURY = solanaAddress();
const PAYOUT = solanaAddress();
const PAYER = solanaAddress();
const TERMS = { feeBps: 300, treasury: TREASURY };
const PRICE = 49_000_000n;
const EVM_TREASURY = '0xabcdef1111111111111111111111111111111111';

describe('the fee a buyer plans', () => {
  it('carries no leg at a zero fee, for any store', () => {
    for (const feeSupport of [true, false]) {
      expect(
        feePlanFor({ feeSupport }, { feeBps: 0, treasury: '' }, { payout: PAYOUT }, PRICE),
      ).toEqual({ ok: true, plan: NO_FEE });
    }
  });

  it('carries the leg to a store that declares fee support, and refuses one that does not', () => {
    expect(
      feePlanFor({ feeSupport: true }, TERMS, { payout: PAYOUT, payer: PAYER }, PRICE),
    ).toEqual({ ok: true, plan: { amount: 1_470_000n, treasury: TREASURY } });
    expect(
      feePlanFor({ feeSupport: false }, TERMS, { payout: PAYOUT, payer: PAYER }, PRICE),
    ).toEqual({ ok: false, reason: 'store_outdated' });
  });

  it('carries no leg when the treasury is the payout or the payer: no store is refused for it', () => {
    for (const parties of [{ payout: TREASURY }, { payout: PAYOUT, payer: TREASURY }]) {
      expect(feePlanFor({ feeSupport: false }, TERMS, parties, PRICE)).toEqual({
        ok: true,
        plan: NO_FEE,
      });
    }
    // EVM addresses compare case-insensitively.
    expect(
      feePlanFor(
        { feeSupport: false },
        { feeBps: 300, treasury: EVM_TREASURY },
        { payout: EVM_TREASURY.toUpperCase().replace('0X', '0x') },
        PRICE,
      ),
    ).toEqual({ ok: true, plan: NO_FEE });
  });

  it('maps a failed terms read to a retryable or a final reason', async () => {
    const cases: [unknown, string][] = [
      [new FeeConfigError('unavailable', 'down'), 'fee_config_unavailable'],
      [new Error('socket hang up'), 'fee_config_unavailable'],
      [new FeeConfigError('wrong_cluster', 'devnet'), 'fee_config_invalid'],
      [new FeeConfigError('no_evm_treasury', 'none'), 'fee_config_invalid'],
      [new FeeConfigError('bad_config', 'bad'), 'fee_config_invalid'],
    ];
    for (const [error, reason] of cases) {
      expect(feeRefusalOf(error)).toBe(reason);
      const planned = await planFee(
        async () => {
          throw error;
        },
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        { feeSupport: true },
        { payout: PAYOUT },
        PRICE,
      );
      expect(planned).toEqual({ ok: false, reason });
    }
  });

  it('reads the terms for the chain it is asked about', async () => {
    const asked: string[] = [];
    const planned = await planFee(
      async (chain) => {
        asked.push(chain);
        return TERMS;
      },
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      { feeSupport: true },
      { payout: PAYOUT },
      PRICE,
    );
    expect(asked).toEqual(['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1']);
    expect(planned).toEqual({ ok: true, plan: { amount: 1_470_000n, treasury: TREASURY } });
  });

  it('reads a stored request as its fee leg, absent fields as none', () => {
    expect(storedFeePlan({})).toEqual(NO_FEE);
    expect(storedFeePlan({ fee_amount: 0 })).toEqual(NO_FEE);
    expect(storedFeePlan({ fee_address: TREASURY, fee_amount: 0 })).toEqual(NO_FEE);
    expect(storedFeePlan({ fee_address: TREASURY, fee_amount: 5 })).toEqual({
      amount: 5n,
      treasury: TREASURY,
    });
    expect(storedFeePlan({ fee_address: EVM_TREASURY, fee_amount: '7' })).toEqual({
      amount: 7n,
      treasury: EVM_TREASURY,
    });
  });

  it('compares two legs by amount and treasury', () => {
    const leg = { amount: 5n, treasury: TREASURY };
    expect(sameFeePlan(leg, { ...leg })).toBe(true);
    expect(sameFeePlan(leg, { ...leg, amount: 6n })).toBe(false);
    expect(sameFeePlan(leg, { ...leg, treasury: PAYOUT })).toBe(false);
    expect(sameFeePlan(NO_FEE, NO_FEE)).toBe(true);
    expect(sameFeePlan(NO_FEE, leg)).toBe(false);
    expect(
      sameFeePlan(
        { amount: 5n, treasury: EVM_TREASURY },
        { amount: 5n, treasury: EVM_TREASURY.toUpperCase().replace('0X', '0x') },
      ),
    ).toBe(true);
    // A base58 treasury is compared exactly.
    const base58 = 'So11111111111111111111111111111111111111112';
    expect(
      sameFeePlan({ amount: 5n, treasury: base58 }, { amount: 5n, treasury: base58.toLowerCase() }),
    ).toBe(false);
  });
});

describe("the store's fee declaration", () => {
  it('is read from the store profile into the verified offer', async () => {
    for (const fee of [true, false]) {
      const shop = makeShop({ fee });
      const offer = await loadOffer(shop.naddr, {
        client: new MemoryRelays(shop.events),
        pageOrigin: 'https://merchant.example',
        families: ['solana'],
        now: NOW,
      });
      expect(offer).toMatchObject({ ok: true, offer: { feeSupport: fee } });
    }
  });
});
