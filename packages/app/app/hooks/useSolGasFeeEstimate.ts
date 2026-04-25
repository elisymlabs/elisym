import {
  estimatePriorityFeeMicroLamports,
  getProtocolProgramId,
  type CapabilityCard,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { useEffect, useState } from 'react';

/**
 * Base fee per signature (lamports) for a Solana transaction.
 * Matches `BASE_FEE_LAMPORTS_PER_SIGNATURE` in the SDK.
 */
const BASE_FEE_LAMPORTS = 5_000;

/**
 * Compute-unit limit attached to payment transactions.
 * Matches `DEFAULT_COMPUTE_UNIT_LIMIT` in the SDK.
 */
const COMPUTE_UNIT_LIMIT = 200_000;

/**
 * Rent-exempt minimum for a 165-byte SPL Token account, in lamports.
 * Worst-case the SPL flow creates two ATAs (recipient + treasury), so
 * USDC previews add 2x this value when no on-chain probing is done.
 *
 * If you ever change this, double-check against
 * `rpc.getMinimumBalanceForRentExemption(165n).send()` on devnet.
 */
const ATA_RENT_LAMPORTS = 2_039_280;

const PRIORITY_FEE_PERCENTILE = 75;
const REFRESH_MS = 30_000;

// Shared across all consumers so we only hit RPC once per refresh window.
const rpc = createSolanaRpc('https://api.devnet.solana.com');
// Kept for a future extension that scopes priority-fee samples to the
// protocol program address. `estimatePriorityFeeMicroLamports` ignores it
// today but keeping the lookup here avoids re-importing from every caller.
void getProtocolProgramId('devnet');

function isUsdcCard(card: CapabilityCard | undefined): boolean {
  const token = card?.payment?.token;
  return typeof token === 'string' && token.toLowerCase() === 'usdc';
}

/**
 * Rough estimate of the lamports the wallet will spend in network fees for a
 * payment: base signature fee plus a 75th-percentile priority fee sized to
 * the payment tx's compute-unit limit. For USDC cards we additionally add
 * `2 * ATA_RENT_LAMPORTS` as a worst-case allowance for recipient + treasury
 * ATA creation - the SDK builder issues idempotent-create instructions that
 * are no-ops when the ATA already exists, but the wallet preview can't tell
 * upfront, so we surface the rent rather than understate the gas line.
 *
 * Refreshes every 30s so the number follows live network conditions. Falls
 * back to the base fee if RPC is unreachable.
 */
export function useSolGasFeeEstimate(card?: CapabilityCard): number {
  const [priorityLamports, setPriorityLamports] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      estimatePriorityFeeMicroLamports(rpc, { percentile: PRIORITY_FEE_PERCENTILE })
        .then((microLamportsPerCu) => {
          if (cancelled) {
            return;
          }
          const lamports = Number(
            (microLamportsPerCu * BigInt(COMPUTE_UNIT_LIMIT) + 999_999n) / 1_000_000n,
          );
          setPriorityLamports(lamports);
        })
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const ataAllowance = isUsdcCard(card) ? 2 * ATA_RENT_LAMPORTS : 0;
  return BASE_FEE_LAMPORTS + priorityLamports + ataAllowance;
}
