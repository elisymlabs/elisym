import { PROTOCOL_FEE_BPS, PROTOCOL_TREASURY, USDC_SOLANA_DEVNET } from '@elisym/sdk';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address as toAddress, createSolanaRpc } from '@solana/kit';
import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js-light';
import { SOLANA_RPC_URL } from '~/lib/cluster';

/**
 * Stats derived entirely from the protocol treasury. Volume is projected back
 * from the fee balance: every successful job sends `PROTOCOL_FEE_BPS /
 * BPS_DENOMINATOR` of the gross payment to treasury, so scaling the inflow
 * gives lifetime gross volume. Assumes treasury hasn't been drained -
 * withdrawals would understate.
 */
export interface UiNetworkStats {
  jobCount: number;
  /** Total volume in lamports (1e9 = 1 SOL). */
  totalLamports: number;
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
async function fetchTreasuryStats(): Promise<UiNetworkStats> {
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
  return useQuery<UiNetworkStats>({
    queryKey: ['network-stats'],
    queryFn: fetchTreasuryStats,
    retry: 3,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 3_000),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
