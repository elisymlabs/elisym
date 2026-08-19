import { LSM_SOLANA_MAINNET, USDC_SOLANA_DEVNET, USDC_SOLANA_MAINNET } from '@elisym/sdk';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { address } from '@solana/kit';
import { describe, it, expect } from 'vitest';
import {
  fetchUsdcBalance,
  formatSplBalanceValue,
  getRpcUrl,
  validateJobPrice,
  RENT_EXEMPT_MINIMUM,
} from '../src/helpers.js';

const OWNER = address('2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4');

describe('getRpcUrl', () => {
  it('returns the devnet URL for devnet', () => {
    expect(getRpcUrl('devnet')).toBe('https://api.devnet.solana.com');
  });

  it('returns the mainnet URL for mainnet', () => {
    expect(getRpcUrl('mainnet')).toBe('https://api.mainnet-beta.solana.com');
  });

  it('honours SOLANA_RPC_URL override on both networks', () => {
    const prev = process.env.SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = 'https://custom.rpc';
    try {
      expect(getRpcUrl('devnet')).toBe('https://custom.rpc');
      expect(getRpcUrl('mainnet')).toBe('https://custom.rpc');
    } finally {
      if (prev === undefined) {
        delete process.env.SOLANA_RPC_URL;
      } else {
        process.env.SOLANA_RPC_URL = prev;
      }
    }
  });
});

describe('fetchUsdcBalance', () => {
  /** Fake RPC that records the mint filter and returns no token accounts. */
  function fakeRpc(capture: { mint?: string }): Rpc<SolanaRpcApi> {
    return {
      getTokenAccountsByOwner: (_owner: unknown, filter: { mint: string }) => {
        capture.mint = filter.mint;
        return { send: async () => ({ value: [] }) };
      },
    } as unknown as Rpc<SolanaRpcApi>;
  }

  it('queries the devnet USDC mint for a devnet agent', async () => {
    const capture: { mint?: string } = {};
    await fetchUsdcBalance(fakeRpc(capture), OWNER, 'devnet');
    expect(capture.mint).toBe(USDC_SOLANA_DEVNET.mint);
  });

  it('queries the mainnet USDC mint for a mainnet agent', async () => {
    const capture: { mint?: string } = {};
    await fetchUsdcBalance(fakeRpc(capture), OWNER, 'mainnet');
    expect(capture.mint).toBe(USDC_SOLANA_MAINNET.mint);
  });

  it('reports an unreadable balance as null, never as zero', async () => {
    // A rate-limited or failing RPC must not be indistinguishable from an
    // empty wallet - callers render null as "unavailable".
    const throwingRpc = {
      getTokenAccountsByOwner: () => ({
        send: async () => {
          throw new Error('429 Too Many Requests');
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    expect(await fetchUsdcBalance(throwingRpc, OWNER, 'mainnet')).toBeNull();
  });

  it('reports an owner with no token account as zero', async () => {
    const capture: { mint?: string } = {};
    expect(await fetchUsdcBalance(fakeRpc(capture), OWNER, 'mainnet')).toBe(0n);
  });
});

describe('formatSplBalanceValue', () => {
  it('formats a readable balance in whole units', () => {
    expect(formatSplBalanceValue(LSM_SOLANA_MAINNET, 25_000_000n)).toBe('25 LSM');
  });

  it('says the read failed instead of printing a zero balance', () => {
    expect(formatSplBalanceValue(LSM_SOLANA_MAINNET, null)).toBe(
      'unavailable (balance read failed)',
    );
    expect(formatSplBalanceValue(LSM_SOLANA_MAINNET, undefined)).toBe(
      'unavailable (balance read failed)',
    );
  });

  it('still prints a genuine zero as zero', () => {
    expect(formatSplBalanceValue(LSM_SOLANA_MAINNET, 0n)).toBe('0 LSM');
  });
});

describe('validateJobPrice', () => {
  const FEE_BPS = 300;

  it('accepts zero (free mode)', () => {
    expect(validateJobPrice(0, false, FEE_BPS)).toBeNull();
  });

  it('accepts funded wallet with any price', () => {
    expect(validateJobPrice(1_000_000, true, FEE_BPS)).toBeNull();
  });

  it('rejects unfunded wallet with price below rent-exempt after fee', () => {
    // 900_000 lamports -> 3% fee = 27_000 -> net = 873_000 < RENT_EXEMPT_MINIMUM
    const result = validateJobPrice(900_000, false, FEE_BPS);
    expect(result).toContain('rent-exempt');
  });

  it('accepts unfunded wallet with sufficient price', () => {
    // 1_000_000 lamports -> 3% fee = 30_000 -> net = 970_000 > RENT_EXEMPT_MINIMUM
    expect(validateJobPrice(1_000_000, false, FEE_BPS)).toBeNull();
  });

  it('message includes rent-exempt minimum', () => {
    const result = validateJobPrice(900_000, false, FEE_BPS);
    expect(result).toContain(String(RENT_EXEMPT_MINIMUM));
  });
});
