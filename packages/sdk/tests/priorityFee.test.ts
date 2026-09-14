import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { clearPriorityFeeCache, estimatePriorityFeeMicroLamports, pickPercentileFee } from '../src';

interface FakeSample {
  prioritizationFee: bigint | number;
  slot?: bigint | number;
}

function makeRpc(samples: readonly FakeSample[]): {
  rpc: Rpc<SolanaRpcApi>;
  callCount: () => number;
} {
  let calls = 0;
  const rpc = {
    getRecentPrioritizationFees: () => ({
      send: () => {
        calls += 1;
        return Promise.resolve(samples);
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, callCount: () => calls };
}

describe('pickPercentileFee', () => {
  it('returns the floor when no samples are available', () => {
    expect(pickPercentileFee([], 75)).toBe(1_000n);
  });

  it('picks the median at p50 for a uniform distribution', () => {
    const samples: FakeSample[] = [
      { prioritizationFee: 10_000n },
      { prioritizationFee: 20_000n },
      { prioritizationFee: 30_000n },
      { prioritizationFee: 40_000n },
      { prioritizationFee: 50_000n },
    ];
    expect(pickPercentileFee(samples, 50)).toBe(30_000n);
  });

  it('picks the upper quartile at p75', () => {
    const samples: FakeSample[] = [
      { prioritizationFee: 10_000n },
      { prioritizationFee: 20_000n },
      { prioritizationFee: 30_000n },
      { prioritizationFee: 40_000n },
      { prioritizationFee: 50_000n },
    ];
    expect(pickPercentileFee(samples, 75)).toBe(40_000n);
  });

  it('clamps the percentile into [0, 100]', () => {
    const samples: FakeSample[] = [{ prioritizationFee: 1_500n }, { prioritizationFee: 2_500n }];
    // Negative percentile clamps to 0 -> picks lowest sample (1500), above floor.
    expect(pickPercentileFee(samples, -50)).toBe(1_500n);
    // Above 100 clamps to 100 -> picks highest sample (2500).
    expect(pickPercentileFee(samples, 1000)).toBe(2_500n);
  });

  it('treats a sub-floor sample as the floor', () => {
    expect(pickPercentileFee([{ prioritizationFee: 1n }], 50)).toBe(1_000n);
  });

  it('accepts numeric prioritizationFee values', () => {
    const samples: FakeSample[] = [{ prioritizationFee: 5_000 }, { prioritizationFee: 7_500 }];
    expect(pickPercentileFee(samples, 50)).toBe(5_000n);
  });

  // A hostile/misconfigured RPC must not be able to inflate the estimate
  // arbitrarily - the value flows straight into the compute-unit price.
  it('clamps an absurd sample to the ceiling', () => {
    const samples: FakeSample[] = [{ prioritizationFee: 2n ** 60n }];
    expect(pickPercentileFee(samples, 50)).toBe(5_000_000n);
  });

  it('passes through a realistic congestion sample below the ceiling', () => {
    const samples: FakeSample[] = [{ prioritizationFee: 4_999_999n }];
    expect(pickPercentileFee(samples, 50)).toBe(4_999_999n);
  });
});

describe('estimatePriorityFeeMicroLamports', () => {
  it('caches results within ttl', async () => {
    clearPriorityFeeCache();
    const samples: FakeSample[] = [{ prioritizationFee: 5_000n }];
    const { rpc, callCount } = makeRpc(samples);
    const first = await estimatePriorityFeeMicroLamports(rpc, {
      network: 'devnet',
      percentile: 75,
    });
    const second = await estimatePriorityFeeMicroLamports(rpc, {
      network: 'devnet',
      percentile: 75,
    });
    expect(first).toBe(5_000n);
    expect(second).toBe(5_000n);
    expect(callCount()).toBe(1);
  });

  it('refetches after ttl expires', async () => {
    clearPriorityFeeCache();
    const samples: FakeSample[] = [{ prioritizationFee: 7_500n }];
    const { rpc, callCount } = makeRpc(samples);
    vi.useFakeTimers();
    try {
      await estimatePriorityFeeMicroLamports(rpc, {
        network: 'devnet',
        percentile: 75,
        ttlMs: 1000,
      });
      vi.advanceTimersByTime(1500);
      await estimatePriorityFeeMicroLamports(rpc, {
        network: 'devnet',
        percentile: 75,
        ttlMs: 1000,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(callCount()).toBe(2);
  });

  it('falls back to floor when rpc returns empty samples', async () => {
    clearPriorityFeeCache();
    const { rpc } = makeRpc([]);
    const fee = await estimatePriorityFeeMicroLamports(rpc, {
      network: 'devnet',
    });
    expect(fee).toBe(1_000n);
  });

  // H9: the cache key carries the network - identical percentile/accounts on
  // the other cluster must hit its own RPC, never the cached devnet sample.
  it('never serves one cluster cached estimate to the other', async () => {
    clearPriorityFeeCache();
    const devnetSamples: FakeSample[] = [{ prioritizationFee: 5_000n }];
    const mainnetSamples: FakeSample[] = [{ prioritizationFee: 50_000n }];
    const devnetRpc = makeRpc(devnetSamples);
    const mainnetRpc = makeRpc(mainnetSamples);

    const devnetFee = await estimatePriorityFeeMicroLamports(devnetRpc.rpc, {
      network: 'devnet',
      percentile: 75,
    });
    const mainnetFee = await estimatePriorityFeeMicroLamports(mainnetRpc.rpc, {
      network: 'mainnet',
      percentile: 75,
    });
    expect(devnetFee).toBe(5_000n);
    expect(mainnetFee).toBe(50_000n);
    expect(devnetRpc.callCount()).toBe(1);
    expect(mainnetRpc.callCount()).toBe(1);

    // Repeat calls stay within each cluster's own cache entry.
    expect(
      await estimatePriorityFeeMicroLamports(devnetRpc.rpc, {
        network: 'devnet',
        percentile: 75,
      }),
    ).toBe(5_000n);
    expect(
      await estimatePriorityFeeMicroLamports(mainnetRpc.rpc, {
        network: 'mainnet',
        percentile: 75,
      }),
    ).toBe(50_000n);
    expect(devnetRpc.callCount()).toBe(1);
    expect(mainnetRpc.callCount()).toBe(1);
  });
});
