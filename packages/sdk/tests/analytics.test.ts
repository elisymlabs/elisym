import {
  type AssetStatsArgs,
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveNetworkStatsAddress,
  getAssetStatsEncoder,
  getNetworkStatsEncoder,
  type NetworkStatsArgs,
} from '@elisym/config-client';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { address } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  ELISYM_PROTOCOL_TAG,
  LSM_SOLANA_MAINNET,
  NATIVE_SOL,
  PROTOCOL_PROGRAM_ID_DEVNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  aggregateNetworkStats,
  assetKey,
  getNetworkStats,
} from '../src';

interface SignatureRow {
  signature: string;
  err: unknown;
}

interface FakeTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface FakeTransaction {
  meta: {
    err: unknown;
    preBalances: bigint[];
    postBalances: bigint[];
    preTokenBalances?: FakeTokenBalance[];
    postTokenBalances?: FakeTokenBalance[];
  } | null;
  transaction: {
    message: { accountKeys: string[] };
  };
}

function makeRpc(
  signatures: SignatureRow[],
  txByHash: Record<string, FakeTransaction | null>,
  capturedSigArgs?: { address?: string },
): Rpc<SolanaRpcApi> {
  return {
    getSignaturesForAddress: (addr: string) => {
      if (capturedSigArgs) capturedSigArgs.address = addr;
      return { send: () => Promise.resolve(signatures) };
    },
    getTransaction: (sig: string) => ({
      send: () => Promise.resolve(txByHash[sig] ?? null),
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('aggregateNetworkStats', () => {
  it('queries getSignaturesForAddress with the protocol tag', async () => {
    const captured: { address?: string } = {};
    const rpc = makeRpc([], {}, captured);
    await aggregateNetworkStats(rpc);
    expect(captured.address).toBe(ELISYM_PROTOCOL_TAG);
  });

  it('returns empty result when no signatures are returned', async () => {
    const rpc = makeRpc([], {});
    const result = await aggregateNetworkStats(rpc);
    expect(result.jobCount).toBe(0);
    expect(result.volumeByAsset).toEqual({});
    expect(result.latestSignature).toBeUndefined();
  });

  it('skips signatures whose err field is non-null', async () => {
    const rpc = makeRpc(
      [
        { signature: 'sig-failed', err: { InstructionError: [0, 'X'] } },
        { signature: 'sig-ok', err: null },
      ],
      {
        'sig-ok': {
          meta: {
            err: null,
            preBalances: [1000n, 0n, 0n],
            postBalances: [400n, 500n, 100n],
          },
          transaction: { message: { accountKeys: ['payer', 'recipient', 'treasury'] } },
        },
      },
    );
    const result = await aggregateNetworkStats(rpc);
    expect(result.jobCount).toBe(1);
    expect(result.volumeByAsset.native).toBe(600n);
  });

  it('sums positive lamport deltas across non-payer accounts (native SOL)', async () => {
    const rpc = makeRpc([{ signature: 'native-1', err: null }], {
      'native-1': {
        meta: {
          err: null,
          // payer paid out 200000000, recipient got 194000000, treasury got 6000000
          preBalances: [1_000_000_000n, 0n, 0n],
          postBalances: [800_000_000n, 194_000_000n, 6_000_000n],
        },
        transaction: { message: { accountKeys: ['payer', 'recipient', 'treasury'] } },
      },
    });
    const result = await aggregateNetworkStats(rpc);
    expect(result.volumeByAsset.native).toBe(200_000_000n);
  });

  it('excludes the AssetStats PDA rent deposit from native volume', async () => {
    // The first native payment on a cluster self-registers the sentinel
    // AssetStats PDA via increment_stats_v2, crediting it rent from the payer.
    // That is money spent, but it is not payment volume.
    const sentinelPda = await deriveAssetStatsAddress(
      PROTOCOL_PROGRAM_ID_DEVNET,
      NATIVE_ASSET_SENTINEL,
    );
    const rpc = makeRpc([{ signature: 'native-first', err: null }], {
      'native-first': {
        meta: {
          err: null,
          preBalances: [1_000_000_000n, 0n, 0n],
          postBalances: [797_925_920n, 194_000_000n, 1_851_360n],
        },
        transaction: {
          message: { accountKeys: ['payer', 'recipient', sentinelPda as string] },
        },
      },
    });
    const result = await aggregateNetworkStats(rpc);
    expect(result.volumeByAsset.native).toBe(194_000_000n);
  });

  it('sums positive token-balance deltas per mint (SPL) and ignores native lamport deltas (ATA rent)', async () => {
    const usdcMint = USDC_SOLANA_DEVNET.mint!;
    const rpc = makeRpc([{ signature: 'spl-1', err: null }], {
      'spl-1': {
        meta: {
          err: null,
          // payer paid 4 SOL of rent for two ATA creates - must NOT count as volume.
          preBalances: [10_000_000_000n, 0n, 0n, 0n],
          postBalances: [5_980_000_000n, 0n, 2_000_000_000n, 2_000_000_000n],
          preTokenBalances: [{ accountIndex: 1, mint: usdcMint, uiTokenAmount: { amount: '0' } }],
          postTokenBalances: [
            { accountIndex: 1, mint: usdcMint, uiTokenAmount: { amount: '50000000' } },
            { accountIndex: 2, mint: usdcMint, uiTokenAmount: { amount: '1500000' } },
          ],
        },
        transaction: {
          message: { accountKeys: ['payer', 'recipientAta', 'treasuryAta', 'payerAta'] },
        },
      },
    });
    const result = await aggregateNetworkStats(rpc);
    expect(result.volumeByAsset[usdcMint]).toBe(51_500_000n);
    expect(result.volumeByAsset.native).toBeUndefined();
  });

  it('aggregates across multiple txs', async () => {
    const usdcMint = USDC_SOLANA_DEVNET.mint!;
    const rpc = makeRpc(
      [
        { signature: 'a', err: null },
        { signature: 'b', err: null },
        { signature: 'c', err: null },
      ],
      {
        a: {
          meta: { err: null, preBalances: [10n, 0n], postBalances: [3n, 7n] },
          transaction: { message: { accountKeys: ['payer', 'rcv'] } },
        },
        b: {
          meta: { err: null, preBalances: [20n, 0n], postBalances: [9n, 11n] },
          transaction: { message: { accountKeys: ['payer', 'rcv'] } },
        },
        c: {
          meta: {
            err: null,
            preBalances: [100n, 0n],
            postBalances: [50n, 0n],
            preTokenBalances: [],
            postTokenBalances: [
              { accountIndex: 1, mint: usdcMint, uiTokenAmount: { amount: '777' } },
            ],
          },
          transaction: { message: { accountKeys: ['payer', 'rcvAta'] } },
        },
      },
    );
    const result = await aggregateNetworkStats(rpc);
    expect(result.jobCount).toBe(3);
    expect(result.volumeByAsset.native).toBe(18n);
    expect(result.volumeByAsset[usdcMint]).toBe(777n);
    expect(result.latestSignature).toBe('a');
    expect(result.oldestSignature).toBe('c');
  });

  it('skips txs whose meta is missing or has an error', async () => {
    const rpc = makeRpc(
      [
        { signature: 'no-meta', err: null },
        { signature: 'meta-err', err: null },
        { signature: 'good', err: null },
      ],
      {
        'no-meta': null,
        'meta-err': {
          meta: { err: 'X', preBalances: [10n, 0n], postBalances: [3n, 7n] },
          transaction: { message: { accountKeys: ['p', 'r'] } },
        } as FakeTransaction,
        good: {
          meta: { err: null, preBalances: [10n, 0n], postBalances: [3n, 7n] },
          transaction: { message: { accountKeys: ['p', 'r'] } },
        },
      },
    );
    const result = await aggregateNetworkStats(rpc);
    expect(result.jobCount).toBe(1);
    expect(result.volumeByAsset.native).toBe(7n);
  });

  it('forwards limit and before options to getSignaturesForAddress', async () => {
    const sigSpy = vi.fn().mockResolvedValue([]);
    const rpc = {
      getSignaturesForAddress: vi.fn(() => ({ send: sigSpy })),
      getTransaction: () => ({ send: () => Promise.resolve(null) }),
    } as unknown as Rpc<SolanaRpcApi>;

    await aggregateNetworkStats(rpc, { limit: 50, before: 'cursor-sig' as never });
    const calls = (rpc.getSignaturesForAddress as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ limit: 50, before: 'cursor-sig' });
  });
});

describe('getNetworkStats', () => {
  function makeNetworkStatsBase64(args: Omit<NetworkStatsArgs, 'reserved'>): string {
    const fullArgs: NetworkStatsArgs = {
      ...args,
      reserved: new Uint8Array(128),
    };
    const buf = getNetworkStatsEncoder().encode(fullArgs);
    return Buffer.from(buf).toString('base64');
  }

  function makeAccountInfoRpc(value: { data: [string, 'base64']; owner: string } | null) {
    return {
      getAccountInfo: vi.fn(() => ({
        send: () => Promise.resolve({ value }),
      })),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  it('returns null when the stats PDA is not initialized', async () => {
    const rpc = makeAccountInfoRpc(null);
    const result = await getNetworkStats(rpc, PROTOCOL_PROGRAM_ID_DEVNET, 'devnet');
    expect(result).toBeNull();
  });

  it('decodes job count and per-asset volumes from the on-chain account', async () => {
    const data = makeNetworkStatsBase64({
      version: 1,
      bump: 255,
      jobCount: 42n,
      volumeNative: 5_000_000_000n,
      volumeUsdc: 1_234_567n,
      lastUpdated: 1_700_000_000n,
    });
    const rpc = makeAccountInfoRpc({
      data: [data, 'base64'],
      owner: PROTOCOL_PROGRAM_ID_DEVNET,
    });

    const result = await getNetworkStats(rpc, PROTOCOL_PROGRAM_ID_DEVNET, 'devnet');
    expect(result).not.toBeNull();
    expect(result!.jobCount).toBe(42);
    expect(result!.volumeNative).toBe(5_000_000_000n);
    expect(result!.volumeUsdc).toBe(1_234_567n);
  });

  it('merges legacy volume slots with per-mint AssetStats PDAs, keyed by network (no double count)', async () => {
    const statsData = makeNetworkStatsBase64({
      version: 1,
      bump: 255,
      jobCount: 10n,
      volumeNative: 100n,
      volumeUsdc: 200n,
      lastUpdated: 1_700_000_000n,
    });
    const usdcDevnetMint = USDC_SOLANA_DEVNET.mint ?? '';
    const usdcMainnetMint = USDC_SOLANA_MAINNET.mint ?? '';
    const lsmMint = LSM_SOLANA_MAINNET.mint ?? '';
    const makeAssetStatsBase64 = (mint: string, volume: bigint): string => {
      const args: AssetStatsArgs = {
        version: 1,
        bump: 255,
        mint: address(mint === 'sentinel' ? NATIVE_ASSET_SENTINEL : mint),
        jobCount: 1n,
        volume,
        lastUpdated: 1_700_000_000n,
        reserved: new Uint8Array(64),
      };
      return Buffer.from(getAssetStatsEncoder().encode(args)).toString('base64');
    };
    const makeMultiAccount = (data: string) => ({
      data: [data, 'base64'],
      owner: PROTOCOL_PROGRAM_ID_DEVNET,
      lamports: 1_851_360n,
      executable: false,
      rentEpoch: 0n,
      space: 138n,
    });
    const rpc = {
      getAccountInfo: vi.fn(() => ({
        send: () =>
          Promise.resolve({
            value: { data: [statsData, 'base64'], owner: PROTOCOL_PROGRAM_ID_DEVNET },
          }),
      })),
      // KNOWN_ASSETS order: sol (sentinel), usdc devnet, usdc mainnet, lsm.
      getMultipleAccounts: vi.fn(() => ({
        send: () =>
          Promise.resolve({
            value: [
              makeMultiAccount(makeAssetStatsBase64('sentinel', 11n)),
              makeMultiAccount(makeAssetStatsBase64(usdcDevnetMint, 22n)),
              makeMultiAccount(makeAssetStatsBase64(usdcMainnetMint, 44n)),
              makeMultiAccount(makeAssetStatsBase64(lsmMint, 33n)),
            ],
          }),
      })),
    } as unknown as Rpc<SolanaRpcApi>;

    // Queried as MAINNET: the legacy volume_usdc slot folds into the MAINNET
    // USDC key - a devnet-keyed fold would silently drop mainnet v2 volume.
    const result = await getNetworkStats(rpc, PROTOCOL_PROGRAM_ID_DEVNET, 'mainnet');
    expect(result).not.toBeNull();
    expect(result!.volumeByAssetKey[assetKey(NATIVE_SOL)]).toBe(111n);
    expect(result!.volumeByAssetKey[assetKey(USDC_SOLANA_MAINNET)]).toBe(244n);
    expect(result!.volumeByAssetKey[assetKey(USDC_SOLANA_DEVNET)]).toBe(22n);
    expect(result!.volumeByAssetKey[assetKey(LSM_SOLANA_MAINNET)]).toBe(33n);
    expect(result!.volumeNative).toBe(111n);
    expect(result!.volumeUsdc).toBe(244n);
    // The batched read targets the canonical AssetStats PDAs.
    const lsmPda = await deriveAssetStatsAddress(PROTOCOL_PROGRAM_ID_DEVNET, address(lsmMint));
    const calls = (rpc.getMultipleAccounts as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toContain(lsmPda);
  });

  it('queries the canonical NetworkStats PDA derived from the program id', async () => {
    const rpc = makeAccountInfoRpc(null);
    await getNetworkStats(rpc, PROTOCOL_PROGRAM_ID_DEVNET, 'devnet');
    const expectedPda: Address = await deriveNetworkStatsAddress(PROTOCOL_PROGRAM_ID_DEVNET);
    const calls = (rpc.getAccountInfo as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toBe(expectedPda);
  });
});
