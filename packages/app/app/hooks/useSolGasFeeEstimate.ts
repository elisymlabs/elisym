import { estimatePriorityFeeMicroLamports, getProtocolProgramId } from '@elisym/sdk';
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

const PRIORITY_FEE_PERCENTILE = 75;
const REFRESH_MS = 30_000;

// Shared across all consumers so we only hit RPC once per refresh window.
const rpc = createSolanaRpc('https://api.devnet.solana.com');
// Kept for a future extension that scopes priority-fee samples to the
// protocol program address. `estimatePriorityFeeMicroLamports` ignores it
// today but keeping the lookup here avoids re-importing from every caller.
void getProtocolProgramId('devnet');

/**
 * Rough estimate of the lamports the wallet will spend in network fees for a
 * SOL payment: base signature fee plus a 75th-percentile priority fee sized
 * to the payment tx's compute-unit limit. Does not include ATA rent (only
 * relevant for SPL payments, which the web flow doesn't support yet).
 *
 * Refreshes every 30s so the number follows live network conditions. Falls
 * back to the base fee if RPC is unreachable.
 */
export function useSolGasFeeEstimate(): number {
  const [lamports, setLamports] = useState<number>(BASE_FEE_LAMPORTS);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      estimatePriorityFeeMicroLamports(rpc, { percentile: PRIORITY_FEE_PERCENTILE })
        .then((microLamportsPerCu) => {
          if (cancelled) {
            return;
          }
          const priorityLamports = Number(
            (microLamportsPerCu * BigInt(COMPUTE_UNIT_LIMIT) + 999_999n) / 1_000_000n,
          );
          setLamports(BASE_FEE_LAMPORTS + priorityLamports);
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

  return lamports;
}
