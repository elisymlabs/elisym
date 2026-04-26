import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_TREASURY,
  USDC_SOLANA_DEVNET,
  type NetworkStats,
} from '@elisym/sdk';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address as toAddress, createSolanaRpc } from '@solana/kit';
import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js-light';
import { useEffect, useRef } from 'react';
import { SOLANA_RPC_URL } from '~/lib/cluster';
import { useElisymClient } from './useElisymClient';

class EmptyStatsError extends Error {
  constructor() {
    super('Relays returned no agents (likely timeout or stale pool)');
    this.name = 'EmptyStatsError';
  }
}

/**
 * UI-side stats shape that augments NetworkStats with per-asset volumes.
 * Volume is derived from the protocol treasury's current balance: every
 * successful job sends `PROTOCOL_FEE_BPS / BPS_DENOMINATOR` of the gross
 * payment to treasury, so projecting back gives lifetime gross volume.
 * Assumes treasury hasn't been drained - withdrawals would understate.
 */
export interface UiNetworkStats extends NetworkStats {
  /** Total volume in USDC subunits (1e6 = 1 USDC). */
  totalUsdcMicro: number;
}

const BPS_DENOMINATOR = 10000;
// Initial seed transfer from the devnet faucet on 2026-03-05 (5 SOL into the
// treasury wallet). Subtracted before scaling so it doesn't masquerade as
// protocol revenue, and dropped from jobCount so it doesn't count as a job.
// Reset to empty on mainnet.
const TREASURY_SEED_LAMPORTS = 5_000_000_000n;
const TREASURY_SEED_SIGNATURE =
  '26EYz6HixU7KDu51j9JyfFkCwWGCqqX5xUJN4qCLR74mwq4Cy1h37vUtc1hyCF4XaFvGCu7ZD3gW97tZbXPJ5SMB';
const treasuryRpc = createSolanaRpc(SOLANA_RPC_URL);

/** Keep the max of each stat field */
function mergeMax(prev: UiNetworkStats, next: UiNetworkStats): UiNetworkStats {
  return {
    totalAgentCount: Math.max(prev.totalAgentCount, next.totalAgentCount),
    agentCount: Math.max(prev.agentCount, next.agentCount),
    jobCount: Math.max(prev.jobCount, next.jobCount),
    totalLamports: Math.max(prev.totalLamports, next.totalLamports),
    totalUsdcMicro: Math.max(prev.totalUsdcMicro, next.totalUsdcMicro),
  };
}

const ZERO: UiNetworkStats = {
  totalAgentCount: 0,
  agentCount: 0,
  jobCount: 0,
  totalLamports: 0,
  totalUsdcMicro: 0,
};

interface TreasuryStats {
  jobCount: number;
  totalLamports: number;
  totalUsdcMicro: number;
}

/**
 * Pull all stats from the protocol treasury in a single RPC fan-out:
 * - SOL fees land in the treasury wallet, USDC fees in the treasury USDC ATA.
 * - `getBalance` / `getTokenAccountBalance` give us cumulative inflow.
 * - `getSignaturesForAddress` (limit 1000) on each address: dedupe by sig and
 *   drop failed txs to approximate completed-job count. USDC fee txs touch
 *   both addresses (CreateAssociatedTokenIdempotent references the wallet,
 *   TransferChecked references the ATA), so naive sum double-counts every
 *   USDC payment. Still a slight overcount from non-fee activity (initial
 *   funding, ATA setup, admin ops). Capped at 1000 most recent per address;
 *   pagination not implemented.
 */
async function fetchTreasuryStats(): Promise<TreasuryStats> {
  const usdcMint = USDC_SOLANA_DEVNET.mint;
  if (!usdcMint) {
    throw new Error('USDC asset missing mint');
  }
  const treasury = toAddress(PROTOCOL_TREASURY);
  const [treasuryUsdcAta] = await findAssociatedTokenPda({
    owner: treasury,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint: toAddress(usdcMint),
  });

  const [solRes, usdcRes, solSigs, usdcSigs] = await Promise.all([
    treasuryRpc.getBalance(treasury).send(),
    treasuryRpc
      .getTokenAccountBalance(treasuryUsdcAta)
      .send()
      .catch(() => null),
    treasuryRpc.getSignaturesForAddress(treasury, { limit: 1000 }).send(),
    treasuryRpc
      .getSignaturesForAddress(treasuryUsdcAta, { limit: 1000 })
      .send()
      .catch(
        () =>
          [] as Awaited<ReturnType<ReturnType<typeof treasuryRpc.getSignaturesForAddress>['send']>>,
      ),
  ]);

  const scale = new Decimal(BPS_DENOMINATOR).div(PROTOCOL_FEE_BPS);
  const netSolLamports =
    solRes.value > TREASURY_SEED_LAMPORTS ? solRes.value - TREASURY_SEED_LAMPORTS : 0n;
  const totalLamports = new Decimal(netSolLamports.toString()).mul(scale);
  const totalUsdcMicro = usdcRes ? new Decimal(usdcRes.value.amount).mul(scale) : new Decimal(0);

  const successSigs = new Set<string>();
  for (const sig of solSigs) {
    if (sig.err === null && sig.signature !== TREASURY_SEED_SIGNATURE) {
      successSigs.add(sig.signature);
    }
  }
  for (const sig of usdcSigs) {
    if (sig.err === null) {
      successSigs.add(sig.signature);
    }
  }

  return {
    jobCount: successSigs.size,
    totalLamports: Number(totalLamports.toFixed(0)),
    totalUsdcMicro: Number(totalUsdcMicro.toFixed(0)),
  };
}

export function useStats() {
  const { client, resetPool } = useElisymClient();
  const highWater = useRef<UiNetworkStats>(ZERO);

  const query = useQuery<UiNetworkStats>({
    queryKey: ['network-stats'],
    queryFn: async () => {
      const [totalAgentCount, treasuryStats] = await Promise.all([
        client.discovery.fetchAllAgentCount(),
        fetchTreasuryStats(),
      ]);

      // `NostrPool.querySync` swallows relay timeouts and resolves to `[]`,
      // which surfaces here as `totalAgentCount === 0`. The devnet registry is
      // never actually empty - treat it as a transient failure so the
      // retry/refetch logic below kicks in instead of caching a bogus zero.
      if (totalAgentCount === 0) {
        throw new EmptyStatsError();
      }

      const stats: UiNetworkStats = {
        totalAgentCount,
        agentCount: totalAgentCount,
        jobCount: treasuryStats.jobCount,
        totalLamports: treasuryStats.totalLamports,
        totalUsdcMicro: treasuryStats.totalUsdcMicro,
      };

      highWater.current = mergeMax(highWater.current, stats);
      return highWater.current;
    },
    // Exponential backoff with an upper bound. 4 attempts at 0.75s / 1.5s / 3s
    // ≈ 5s total before giving up and surfacing the error.
    retry: 3,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 3_000),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  // Mirror useAgents: if all retries exhausted because the pool is stuck on
  // empty results, drop the SimplePool once and refetch with a clean socket.
  const resetOnceRef = useRef(false);
  useEffect(() => {
    if (query.isError && query.error instanceof EmptyStatsError && !resetOnceRef.current) {
      resetOnceRef.current = true;
      resetPool();
      query.refetch();
    }
    if (!query.isError) {
      resetOnceRef.current = false;
    }
  }, [query.isError, query.error, query, resetPool]);

  return query;
}
