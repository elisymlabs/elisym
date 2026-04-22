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

import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { type Address, type Rpc, type SolanaRpcApi, address } from '@solana/kit';
import type { PaymentRequestData } from '../types';
import { resolveAssetFromPaymentRequest } from './assets';
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
  /** `baseFeeLamports + priorityFeeLamports + rentLamports`. */
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
 * Estimate the SOL cost (in lamports) to submit the transaction that would pay
 * this payment request from `payerAddress`.
 *
 * Returns a breakdown and a total. Does not submit anything on-chain.
 */
export async function estimateSolFeeLamports(
  rpc: Rpc<SolanaRpcApi>,
  paymentRequest: PaymentRequestData,
  _payerAddress: string,
  options?: EstimateSolFeeOptions,
): Promise<SolFeeEstimate> {
  const numSignatures = options?.numSignatures ?? 1;
  const computeUnitLimit = options?.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const priorityFeeMicroLamports =
    options?.priorityFeeMicroLamports ??
    (await estimatePriorityFeeMicroLamports(rpc, {
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

  if (asset.mint) {
    rentPerAtaLamports = await fetchAtaRent(rpc);
    const mint = address(asset.mint);

    const ataAccountsToCheck: Address[] = [];
    const [recipientAta] = await findAssociatedTokenPda({
      owner: address(paymentRequest.recipient),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint,
    });
    ataAccountsToCheck.push(recipientAta);

    const feeAmount = paymentRequest.fee_amount ?? 0;
    if (paymentRequest.fee_address && feeAmount > 0) {
      const [treasuryAta] = await findAssociatedTokenPda({
        owner: address(paymentRequest.fee_address),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
      });
      ataAccountsToCheck.push(treasuryAta);
    }

    missingAtaCount = await countMissingAccounts(rpc, ataAccountsToCheck);
    rentLamports = rentPerAtaLamports * BigInt(missingAtaCount);
  }

  const totalLamports = baseFeeLamports + priorityFeeLamports + rentLamports;
  return {
    baseFeeLamports,
    priorityFeeLamports,
    rentLamports,
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

async function fetchAtaRent(rpc: Rpc<SolanaRpcApi>): Promise<bigint> {
  try {
    const lamports = await rpc
      .getMinimumBalanceForRentExemption(BigInt(SPL_TOKEN_ACCOUNT_SIZE))
      .send();
    if (typeof lamports === 'bigint') {
      return lamports;
    }
    if (typeof lamports === 'number' && Number.isFinite(lamports) && lamports > 0) {
      return BigInt(lamports);
    }
    return FALLBACK_ATA_RENT_LAMPORTS;
  } catch {
    return FALLBACK_ATA_RENT_LAMPORTS;
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
  lines.push(line('Total:', estimate.totalLamports));
  return lines.join('\n');
}

function lamportsToSol(lamports: bigint): string {
  const LAMPORTS_PER_SOL = 1_000_000_000n;
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  return `${whole}.${frac.toString().padStart(9, '0')}`;
}
