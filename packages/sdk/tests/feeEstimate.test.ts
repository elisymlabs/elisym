import { NATIVE_ASSET_SENTINEL, deriveAssetStatsAddress } from '@elisym/config-client';
import { type Address, type Rpc, type SolanaRpcApi, address, getAddressDecoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  type Asset,
  LSM_SOLANA_MAINNET,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  calculateProtocolFee,
  estimateSolFeeLamports,
  formatFeeBreakdown,
  getProtocolProgramId,
} from '../src';

function requireMint(asset: Asset): string {
  if (!asset.mint) {
    throw new Error(`asset ${asset.token} has no mint`);
  }
  return asset.mint;
}

// AssetStats PDAs the estimator probes (payment txs bundle increment_stats_v2).
// The program id is byte-identical on both clusters, so the PDA depends only
// on the mint.
const PROGRAM_ID = getProtocolProgramId('devnet');
const ASSET_STATS_PDAS: ReadonlySet<string> = new Set(
  await Promise.all([
    deriveAssetStatsAddress(PROGRAM_ID, NATIVE_ASSET_SENTINEL),
    deriveAssetStatsAddress(PROGRAM_ID, address(requireMint(USDC_SOLANA_DEVNET))),
    deriveAssetStatsAddress(PROGRAM_ID, address(requireMint(USDC_SOLANA_MAINNET))),
    deriveAssetStatsAddress(PROGRAM_ID, address(requireMint(LSM_SOLANA_MAINNET))),
  ]),
);

const ADDRESS_DECODER = getAddressDecoder();

function makeAddress(): Address {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes);
}

const TEST_FEE_BPS = 300;
const TEST_TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy' as Address;

/**
 * Build an RPC stub that returns the supplied priority-fee samples and lets
 * the caller control whether `getAccountInfo` returns null (missing ATA) or
 * a populated value (existing ATA).
 */
function createMockRpc(options: {
  priorityFees?: Array<{ slot: number; prioritizationFee: bigint }>;
  atasExist?: boolean;
  /** Whether the probed AssetStats PDA exists. Defaults to true (ops pre-creates them). */
  assetStatsExist?: boolean;
}): Rpc<SolanaRpcApi> {
  const fees = options.priorityFees ?? [
    { slot: 1, prioritizationFee: 1_000n },
    { slot: 2, prioritizationFee: 1_000n },
  ];
  const atasExist = options.atasExist ?? false;
  const assetStatsExist = options.assetStatsExist ?? true;
  return {
    getRecentPrioritizationFees: () => ({
      send: () => Promise.resolve(fees),
    }),
    getMinimumBalanceForRentExemption: (size: bigint) => ({
      send: () =>
        Promise.resolve(size === 138n ? 1_851_360n : size === 170n ? 2_074_080n : 2_039_280n),
    }),
    getAccountInfo: (accountAddress: Address) => ({
      send: () => {
        const exists = ASSET_STATS_PDAS.has(accountAddress as string) ? assetStatsExist : atasExist;
        return Promise.resolve({
          value: exists ? { lamports: 2_039_280n, data: new Uint8Array() } : null,
        });
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('estimateSolFeeLamports', () => {
  const payer = makeAddress();

  const usdcRequest = () => ({
    recipient: makeAddress(),
    amount: 50_000_000,
    reference: makeAddress(),
    fee_address: TEST_TREASURY as string,
    fee_amount: calculateProtocolFee(50_000_000, TEST_FEE_BPS),
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 600,
    asset: {
      chain: 'solana',
      token: 'usdc',
      mint: USDC_SOLANA_DEVNET.mint!,
      decimals: 6,
    },
  });

  it('SOL payment: rent is 0, total is base + priority', async () => {
    const rpc = createMockRpc({});
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: makeAddress(),
        amount: 1_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      payer,
      'devnet',
    );
    expect(est.rentLamports).toBe(0n);
    expect(est.assetStatsRentLamports).toBe(0n);
    expect(est.totalLamports).toBe(est.baseFeeLamports + est.priorityFeeLamports);
    expect(est.baseFeeLamports).toBe(5_000n);
  });

  it('SOL payment with a missing sentinel AssetStats PDA quotes the stats rent', async () => {
    const rpc = createMockRpc({ assetStatsExist: false });
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: makeAddress(),
        amount: 1_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      payer,
      'devnet',
    );
    expect(est.assetStatsRentLamports).toBe(1_851_360n);
    expect(est.totalLamports).toBe(
      est.baseFeeLamports + est.priorityFeeLamports + est.assetStatsRentLamports,
    );
    expect(formatFeeBreakdown(est)).toContain('Stats rent:');
  });

  it('LSM (Token-2022) payment on mainnet sizes ATA rent at 170 bytes', async () => {
    const rpc = createMockRpc({ atasExist: false });
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: makeAddress(),
        amount: 5_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
        asset: {
          chain: 'solana',
          token: 'lsm',
          mint: requireMint(LSM_SOLANA_MAINNET),
          decimals: 6,
        },
      },
      payer,
      'mainnet',
    );
    expect(est.breakdown.rentPerAtaLamports).toBe(2_074_080n);
    expect(est.breakdown.missingAtaCount).toBe(1);
    expect(est.rentLamports).toBe(2_074_080n);
    expect(est.assetStatsRentLamports).toBe(0n);
  });

  it('USDC + both ATAs missing: rent = 2x rentPerAta', async () => {
    const rpc = createMockRpc({ atasExist: false });
    const est = await estimateSolFeeLamports(rpc, usdcRequest(), payer, 'devnet');
    expect(est.breakdown.missingAtaCount).toBe(2);
    expect(est.rentLamports).toBe(2n * 2_039_280n);
  });

  it('USDC + both ATAs exist: rent is 0', async () => {
    const rpc = createMockRpc({ atasExist: true });
    const est = await estimateSolFeeLamports(rpc, usdcRequest(), payer, 'devnet');
    expect(est.breakdown.missingAtaCount).toBe(0);
    expect(est.rentLamports).toBe(0n);
  });

  it('USDC without fee: missing ATA count is 1 when recipient ATA missing', async () => {
    const rpc = createMockRpc({ atasExist: false });
    const request = usdcRequest();
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: request.recipient,
        amount: request.amount,
        reference: request.reference,
        created_at: request.created_at,
        expiry_secs: request.expiry_secs,
        asset: request.asset,
      },
      payer,
      'devnet',
    );
    expect(est.breakdown.missingAtaCount).toBe(1);
    expect(est.rentLamports).toBe(2_039_280n);
  });

  it('formatFeeBreakdown hides the ATA rent line when rentLamports=0', async () => {
    const rpc = createMockRpc({});
    const est = await estimateSolFeeLamports(
      rpc,
      {
        recipient: makeAddress(),
        amount: 1_000_000,
        reference: makeAddress(),
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      },
      payer,
      'devnet',
    );
    const formatted = formatFeeBreakdown(est);
    expect(formatted).toContain('Base fee:');
    expect(formatted).toContain('Priority fee:');
    expect(formatted).toContain('Total:');
    expect(formatted).not.toContain('ATA rent:');
  });
});

// Satisfy import used only by another test file pattern
void vi;
