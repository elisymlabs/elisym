import { CHAINS, type FeeTerms, type Network, type readFeeTerms } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import { feeTermsReader, feeTermsSourceFor } from '../src/app/fee-terms';

describe('feeTermsSourceFor', () => {
  it("reads a Tempo chain's EVM treasury from its paired Solana network's config", () => {
    expect(feeTermsSourceFor('eip155:4217')).toEqual({ network: 'mainnet', rail: 'tempo' });
    expect(feeTermsSourceFor('eip155:42431')).toEqual({ network: 'devnet', rail: 'tempo' });
  });

  it("reads a Solana chain's Solana treasury from its own network's config", () => {
    expect(feeTermsSourceFor(CHAINS.SOLANA_MAINNET.caip2)).toEqual({
      network: 'mainnet',
      rail: 'solana',
    });
    expect(feeTermsSourceFor(CHAINS.SOLANA_DEVNET.caip2)).toEqual({
      network: 'devnet',
      rail: 'solana',
    });
  });

  it('refuses a chain with no fee config', () => {
    expect(() => feeTermsSourceFor('eip155:1')).toThrow();
  });
});

describe('feeTermsReader', () => {
  const RPC = { name: 'devnet rpc' } as unknown as Parameters<typeof readFeeTerms>[0];
  const TERMS: FeeTerms = { feeBps: 100, treasury: 'treasury' };

  it("reads each chain's terms over its paired network's rpc, for its rail", async () => {
    const calls: unknown[][] = [];
    const read = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(TERMS);
    }) as typeof readFeeTerms;
    const rpcs = new Map<Network, typeof RPC>([['devnet', RPC]]);
    const terms = feeTermsReader((network) => rpcs.get(network), read);
    await expect(terms('eip155:42431')).resolves.toEqual(TERMS);
    await expect(terms(CHAINS.SOLANA_DEVNET.caip2)).resolves.toEqual(TERMS);
    expect(calls).toEqual([
      [RPC, 'devnet', 'tempo'],
      [RPC, 'devnet', 'solana'],
    ]);
  });

  it('refuses as unavailable, reading nothing, without an rpc of that network', async () => {
    let reads = 0;
    const read = (() => {
      reads += 1;
      return Promise.resolve(TERMS);
    }) as typeof readFeeTerms;
    const terms = feeTermsReader(() => undefined, read);
    await expect(terms('eip155:4217')).rejects.toMatchObject({ code: 'unavailable' });
    expect(reads).toBe(0);
  });
});
