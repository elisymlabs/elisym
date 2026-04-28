import { USDC_SOLANA_DEVNET } from '@elisym/sdk';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { address as toAddress, createSolanaRpc } from '@solana/kit';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery, type QueryClient } from '@tanstack/react-query';

const BALANCE_STALE_MS = 1000 * 10;
const BALANCE_REFETCH_MS = 1000 * 10;

const SOL_BALANCE_QUERY_KEY = 'sol-balance-raw';
const USDC_BALANCE_QUERY_KEY = 'usdc-balance-raw';

/**
 * Trigger an immediate refetch of the wallet's SOL + USDC balances.
 *
 * Call this from flows that mutate the wallet on-chain (e.g. after a payment
 * tx confirms) so the UI reflects the new balance without waiting for the
 * 10s polling tick.
 */
export function invalidateWalletBalances(
  queryClient: QueryClient,
  walletAddress: string | null,
): void {
  queryClient.invalidateQueries({ queryKey: [SOL_BALANCE_QUERY_KEY, walletAddress] });
  queryClient.invalidateQueries({ queryKey: [USDC_BALANCE_QUERY_KEY, walletAddress] });
}

// Module-level Kit RPC singleton: balance queries fire from many components
// and we want to share a single connection. Kept in step with the devnet
// hardcode in Providers.tsx.
const balanceRpc = createSolanaRpc('https://api.devnet.solana.com');

interface WalletBalances {
  solLamports: bigint | null;
  usdcRaw: bigint | null;
  isSolLoading: boolean;
  isUsdcLoading: boolean;
}

/**
 * Fetch the connected wallet's SOL and USDC balances as raw subunits.
 *
 * Callers format for display (round, convert to whole units) - we return
 * subunit BigInts so the wallet menu can show a rounded number while the
 * Buy button can do exact `>=` math against a job_price subunit value.
 *
 * Query keys are scoped to the wallet base58 string so multiple consumers
 * (header WalletMenu + agent page Buy button) share a single TanStack cache
 * entry and only one RPC call fires per refetch window.
 *
 * USDC ATA-not-found resolves to `0n` (a fresh wallet that has never held
 * USDC). Other RPC errors propagate so TanStack Query can mark the query as
 * errored and stop the refetch loop until the wallet reconnects.
 */
export function useWalletBalances(): WalletBalances {
  const { publicKey } = useWallet();
  const walletAddress = publicKey?.toBase58() ?? null;

  const { data: solLamports = null, isLoading: isSolLoading } = useQuery({
    queryKey: [SOL_BALANCE_QUERY_KEY, walletAddress],
    queryFn: async (): Promise<bigint> => {
      if (!walletAddress) {
        return 0n;
      }
      const owner = toAddress(walletAddress);
      const { value: lamports } = await balanceRpc.getBalance(owner).send();
      return BigInt(lamports.toString());
    },
    enabled: !!walletAddress,
    staleTime: BALANCE_STALE_MS,
    refetchInterval: BALANCE_REFETCH_MS,
  });

  const { data: usdcRaw = null, isLoading: isUsdcLoading } = useQuery({
    queryKey: [USDC_BALANCE_QUERY_KEY, walletAddress],
    queryFn: async (): Promise<bigint> => {
      if (!walletAddress) {
        return 0n;
      }
      const mintAddress = USDC_SOLANA_DEVNET.mint;
      if (!mintAddress) {
        throw new Error('USDC asset missing mint');
      }
      const owner = toAddress(walletAddress);
      const [ata] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: toAddress(mintAddress),
      });
      try {
        const { value } = await balanceRpc.getTokenAccountBalance(ata).send();
        return BigInt(value.amount);
      } catch {
        // No ATA for this owner yet => user has never held USDC.
        return 0n;
      }
    },
    enabled: !!walletAddress,
    staleTime: BALANCE_STALE_MS,
    refetchInterval: BALANCE_REFETCH_MS,
  });

  return {
    solLamports,
    usdcRaw,
    isSolLoading: !!walletAddress && isSolLoading,
    isUsdcLoading: !!walletAddress && isUsdcLoading,
  };
}
