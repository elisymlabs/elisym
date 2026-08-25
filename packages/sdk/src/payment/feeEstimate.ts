/**
 * SOL-denominated fee estimator for payment requests.
 *
 * For a USDC payment the user still spends SOL to cover the base signature fee,
 * the priority fee, and (for first-time recipients) the ATA rent-exemption
 * deposit. Before calling `send_payment` the customer wants to know whether
 * their SOL balance is sufficient - that's what this helper answers.
 *
 * Browser-safe: no Node-specific imports. The web dashboard will use the same
 * function.
 */

import { NATIVE_ASSET_SENTINEL, deriveAssetStatsAddress } from '@elisym/config-client';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { type Address, type Rpc, type SolanaRpcApi, address } from '@solana/kit';
import { getProtocolProgramId } from '../constants';
import type { Network, PaymentRequestData } from '../types';
import {
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  resolveAssetFromPaymentRequest,
  type Asset,
} from './assets';
import { estimatePriorityFeeMicroLamports } from './priorityFee';

/**
 * Default compute-unit limit attached to payment transactions.
 *
 * Kept in sync with `DEFAULT_COMPUTE_UNIT_LIMIT` in solana.ts. Duplicating the
 * constant keeps the estimator browser-safe without pulling the build path.
 */
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
const DEFAULT_PRIORITY_FEE_PERCENTILE = 75;

/** Base fee per signature (lamports). See `SystemProgram::get_fee_payer`. */
const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Rent-exemption minimum for a 165-byte SPL Token account, as of Solana 1.18+.
 *
 * Used as a fallback when `getMinimumBalanceForRentExemption` is unavailable.
 * The real on-chain value is ~2039280 lamports (= 0.00203928 SOL).
 */
const FALLBACK_ATA_RENT_LAMPORTS = 2_039_280n;

/** SPL Token account size in bytes. */
const SPL_TOKEN_ACCOUNT_SIZE = 165;

/**
 * A Token-2022 ATA always carries the mandatory `ImmutableOwner` extension:
 * 165 base + 1 account-type byte + 4 TLV header = 170 bytes, rent-exempt at
 * 2_074_080 lamports.
 */
const FALLBACK_T22_ATA_RENT_LAMPORTS = 2_074_080n;
const T22_TOKEN_ACCOUNT_SIZE = 170;

/**
 * `AssetStats` PDA of the elisym-config program: 8-byte discriminator + 130
 * bytes of state = 138 bytes, rent-exempt at 1_851_360 lamports. Charged once
 * per mint network-wide when the payment self-registers a brand-new asset
 * (ops pre-creates the PDAs for known assets, so this is normally 0).
 */
const FALLBACK_ASSET_STATS_RENT_LAMPORTS = 1_851_360n;
const ASSET_STATS_ACCOUNT_SIZE = 138;

export interface SolFeeEstimate {
  /** Base per-signature fee. Currently 5000 lamports * 1 signature. */
  baseFeeLamports: bigint;
  /**
   * Priority fee in lamports: `ceil(priorityFeeMicroLamports * computeUnitLimit
   * / 1_000_000)`. Rounded up so we don't underestimate.
   */
  priorityFeeLamports: bigint;
  /**
   * Rent-exemption deposit for ATAs that the tx creates.
   *
   * 0 for native SOL. For SPL, `rentPerAta * (# of missing ATAs)`: recipient
   * ATA is missing iff the recipient has never received this token; treasury
   * ATA is missing only on the first-ever protocol fee into this mint.
   */
  rentLamports: bigint;
  /**
   * Rent-exemption deposit for the per-mint `AssetStats` PDA the bundled
   * `increment_stats_v2` instruction creates when this payment is the
   * network's first in a brand-new asset (native SOL included, via the
   * sentinel PDA). 0 whenever the PDA already exists - ops pre-creates it for
   * every known asset, so a non-zero value here is exceptional.
   */
  assetStatsRentLamports: bigint;
  /** `baseFeeLamports + priorityFeeLamports + rentLamports + assetStatsRentLamports`. */
  totalLamports: bigint;
  breakdown: {
    numSignatures: number;
    priorityFeeMicroLamports: bigint;
    computeUnitLimit: number;
    rentPerAtaLamports: bigint;
    missingAtaCount: number;
  };
}

export interface EstimateSolFeeOptions {
  /** Override the compute-unit limit used by `buildTransaction`. */
  computeUnitLimit?: number;
  /** Override the priority fee directly (skips RPC). */
  priorityFeeMicroLamports?: bigint;
  /**
   * Percentile of the recent priority-fee distribution to charge when
   * `priorityFeeMicroLamports` is not supplied. Defaults to 75.
   */
  priorityFeePercentile?: number;
  /** Override the number of signatures. Defaults to 1. */
  numSignatures?: number;
}

/**
 * One-time lamports the payment transaction charges the payer to create the
 * per-asset `AssetStats` PDA, or 0n when it already exists.
 *
 * Every payment bundles `increment_stats_v2`, which `init_if_needed`s that PDA
 * - native SOL included, via the sentinel PDA - so a preview that omits this
 * understates the first payment in an asset by ~0.0019 SOL. Surfaces exist
 * (the web app's gas line) that estimate a fee without a payment request; they
 * add this on top of their own base + priority + ATA math.
 *
 * `programId` must be the one the payment will be built against; it defaults to
 * this network's protocol program, which is what `buildPaymentInstructions`
 * uses unless a caller overrides it. Probing under a different program would
 * quote 0 rent for a payment that still pays it.
 */
export async function estimateAssetStatsRentLamports(
  rpc: Rpc<SolanaRpcApi>,
  network: Network,
  asset: Asset,
  programId: Address = getProtocolProgramId(network),
): Promise<bigint> {
  const statsMint = asset.mint ? address(asset.mint) : NATIVE_ASSET_SENTINEL;
  const assetStatsPda = await deriveAssetStatsAddress(programId, statsMint);
  const missingAssetStatsCount = await countMissingAccounts(rpc, [assetStatsPda]);
  return missingAssetStatsCount > 0
    ? await fetchRentExemption(rpc, ASSET_STATS_ACCOUNT_SIZE, FALLBACK_ASSET_STATS_RENT_LAMPORTS)
    : 0n;
}

/**
 * Estimate the SOL cost (in lamports) to submit the transaction that would pay
 * this payment request from `payerAddress`.
 *
 * Returns a breakdown and a total. Does not submit anything on-chain.
 */
export async function estimateSolFeeLamports(
  rpc: Rpc<SolanaRpcApi>,
  paymentRequest: PaymentRequestData,
  _payerAddress: string,
  network: Network,
  options?: EstimateSolFeeOptions,
): Promise<SolFeeEstimate> {
  const numSignatures = options?.numSignatures ?? 1;
  const computeUnitLimit = options?.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const priorityFeeMicroLamports =
    options?.priorityFeeMicroLamports ??
    (await estimatePriorityFeeMicroLamports(rpc, {
      network,
      percentile: options?.priorityFeePercentile ?? DEFAULT_PRIORITY_FEE_PERCENTILE,
    }));

  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(numSignatures);
  const priorityFeeLamports = ceilDiv(
    priorityFeeMicroLamports * BigInt(computeUnitLimit),
    1_000_000n,
  );

  const asset = resolveAssetFromPaymentRequest(paymentRequest);
  let rentLamports = 0n;
  let rentPerAtaLamports = 0n;
  let missingAtaCount = 0;

  const assetStatsRentLamports = await estimateAssetStatsRentLamports(rpc, network, asset);

  if (asset.mint) {
    rentPerAtaLamports = await fetchAtaRent(rpc, asset.tokenProgram);
    const mint = address(asset.mint);
    const tokenProgram = asset.tokenProgram ? address(asset.tokenProgram) : TOKEN_PROGRAM_ADDRESS;

    const ataAccountsToCheck: Address[] = [];
    const [recipientAta] = await findAssociatedTokenPda({
      owner: address(paymentRequest.recipient),
      tokenProgram,
      mint,
    });
    ataAccountsToCheck.push(recipientAta);

    const feeAmount = paymentRequest.fee_amount ?? 0;
    if (paymentRequest.fee_address && feeAmount > 0) {
      const [treasuryAta] = await findAssociatedTokenPda({
        owner: address(paymentRequest.fee_address),
        tokenProgram,
        mint,
      });
      ataAccountsToCheck.push(treasuryAta);
    }

    missingAtaCount = await countMissingAccounts(rpc, ataAccountsToCheck);
    rentLamports = rentPerAtaLamports * BigInt(missingAtaCount);
  }

  const totalLamports =
    baseFeeLamports + priorityFeeLamports + rentLamports + assetStatsRentLamports;
  return {
    baseFeeLamports,
    priorityFeeLamports,
    rentLamports,
    assetStatsRentLamports,
    totalLamports,
    breakdown: {
      numSignatures,
      priorityFeeMicroLamports,
      computeUnitLimit,
      rentPerAtaLamports,
      missingAtaCount,
    },
  };
}

/** ATA account size + fallback rent for the given owner token program. */
function ataRentParams(tokenProgram?: string): { size: number; fallback: bigint } {
  if (tokenProgram === TOKEN_2022_PROGRAM_ADDRESS_STR) {
    return { size: T22_TOKEN_ACCOUNT_SIZE, fallback: FALLBACK_T22_ATA_RENT_LAMPORTS };
  }
  return { size: SPL_TOKEN_ACCOUNT_SIZE, fallback: FALLBACK_ATA_RENT_LAMPORTS };
}

async function fetchAtaRent(rpc: Rpc<SolanaRpcApi>, tokenProgram?: string): Promise<bigint> {
  const { size, fallback } = ataRentParams(tokenProgram);
  return fetchRentExemption(rpc, size, fallback);
}

async function fetchRentExemption(
  rpc: Rpc<SolanaRpcApi>,
  size: number,
  fallback: bigint,
): Promise<bigint> {
  try {
    const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(size)).send();
    if (typeof lamports === 'bigint') {
      return lamports;
    }
    if (typeof lamports === 'number' && Number.isFinite(lamports) && lamports > 0) {
      return BigInt(lamports);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function countMissingAccounts(rpc: Rpc<SolanaRpcApi>, accounts: Address[]): Promise<number> {
  if (accounts.length === 0) {
    return 0;
  }
  let missing = 0;
  for (const acct of accounts) {
    try {
      const res = await rpc.getAccountInfo(acct, { encoding: 'base64' }).send();
      if (!res || !res.value) {
        missing++;
      }
    } catch {
      // If we can't tell, assume the ATA must be created - safer to
      // overestimate the cost than to surprise the payer.
      missing++;
    }
  }
  return missing;
}

function ceilDiv(num: bigint, denom: bigint): bigint {
  if (denom === 0n) {
    throw new Error('division by zero in ceilDiv');
  }
  const q = num / denom;
  const r = num % denom;
  return r === 0n ? q : q + 1n;
}

/**
 * Multi-line human-readable breakdown. Used by the MCP `estimate_payment_cost`
 * tool and (in a future PR) by the web dashboard's pre-payment panel.
 *
 * We render lamports as raw integers and also show a SOL decimal with 9 places.
 * The `@elisym/sdk` `formatAssetAmount` helper lives in assets.ts, but the
 * formatter does not need to be identical; this stays dependency-free.
 */
export function formatFeeBreakdown(estimate: SolFeeEstimate): string {
  const line = (label: string, lamports: bigint): string => {
    const label16 = label.padEnd(14);
    return `  ${label16}${lamports.toString()} lamports (${lamportsToSol(lamports)} SOL)`;
  };
  const lines = [
    'Estimated SOL cost for this transaction:',
    line('Base fee:', estimate.baseFeeLamports),
    line('Priority fee:', estimate.priorityFeeLamports),
  ];
  if (estimate.rentLamports > 0n) {
    lines.push(line('ATA rent:', estimate.rentLamports));
  }
  if (estimate.assetStatsRentLamports > 0n) {
    lines.push(line('Stats rent:', estimate.assetStatsRentLamports));
  }
  lines.push(line('Total:', estimate.totalLamports));
  return lines.join('\n');
}

function lamportsToSol(lamports: bigint): string {
  const LAMPORTS_PER_SOL = 1_000_000_000n;
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  return `${whole}.${frac.toString().padStart(9, '0')}`;
}

export interface NetworkBaselineEstimate {
  baseFeeLamports: bigint;
  priorityFeeMicroLamports: bigint;
  computeUnitLimit: number;
  priorityFeeLamports: bigint;
  /** Present only when `includeAtaRent: true`. */
  ataRentLamports?: bigint;
  /** baseFeeLamports + priorityFeeLamports + (ataRentLamports ?? 0n). */
  totalLamports: bigint;
}

export interface NetworkBaselineOptions {
  /** Add one ATA rent-exemption deposit to the total (SPL first-time payer). */
  includeAtaRent?: boolean;
  /**
   * Owner token program of the SPL asset the rent is quoted for. Selects the
   * ATA account size (classic 165 bytes vs Token-2022 170 bytes). Ignored
   * unless `includeAtaRent` is true.
   */
  ataTokenProgram?: string;
  /** Override the priority-fee percentile (default 75). */
  priorityFeePercentile?: number;
  /** Override the compute-unit limit (default 200_000). */
  computeUnitLimit?: number;
  /** Override priority fee directly, skipping the RPC call. */
  priorityFeeMicroLamports?: bigint;
}

/**
 * Estimate the SOL cost of a typical payment transaction on the current
 * cluster, without needing a concrete `payment_request`. Used by MCP
 * confirmation messages (e.g. `buy_capability` price gate) to surface
 * gas before the provider has issued a payment-required feedback.
 *
 * Reuses the priority-fee cache in `estimatePriorityFeeMicroLamports`
 * (TTL 10s) so consecutive confirmations don't double-hit the RPC.
 *
 * This is a FLOOR, not the full invoice: it is asset-agnostic, so it cannot
 * probe the per-mint `AssetStats` PDA and omits that one-time rent (~0.0019
 * SOL, charged only to the first payer of an asset whose PDA has not been
 * pre-created). `estimateSolFeeLamports` takes a concrete asset and includes
 * it - use that whenever a payment request exists.
 */
export async function estimateNetworkBaseline(
  rpc: Rpc<SolanaRpcApi>,
  network: Network,
  options?: NetworkBaselineOptions,
): Promise<NetworkBaselineEstimate> {
  const computeUnitLimit = options?.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const priorityFeeMicroLamports =
    options?.priorityFeeMicroLamports ??
    (await estimatePriorityFeeMicroLamports(rpc, {
      network,
      percentile: options?.priorityFeePercentile ?? DEFAULT_PRIORITY_FEE_PERCENTILE,
    }));
  const baseFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE;
  const priorityFeeLamports = ceilDiv(
    priorityFeeMicroLamports * BigInt(computeUnitLimit),
    1_000_000n,
  );
  const ataRentLamports = options?.includeAtaRent
    ? await fetchAtaRent(rpc, options?.ataTokenProgram)
    : undefined;
  const totalLamports = baseFeeLamports + priorityFeeLamports + (ataRentLamports ?? 0n);
  return {
    baseFeeLamports,
    priorityFeeMicroLamports,
    computeUnitLimit,
    priorityFeeLamports,
    ataRentLamports,
    totalLamports,
  };
}

/**
 * Single-line summary of a network baseline estimate, suitable for embedding
 * inside MCP confirmation strings.
 */
export function formatNetworkBaseline(estimate: NetworkBaselineEstimate): string {
  const total = lamportsToSol(estimate.totalLamports);
  const base = lamportsToSol(estimate.baseFeeLamports);
  const priority = lamportsToSol(estimate.priorityFeeLamports);
  const parts = [`base ${base}`, `priority ${priority}`];
  if (estimate.ataRentLamports !== undefined) {
    parts.push(`ATA rent ${lamportsToSol(estimate.ataRentLamports)}`);
  }
  return `Estimated network gas: ${total} SOL (${parts.join(' + ')}).`;
}
