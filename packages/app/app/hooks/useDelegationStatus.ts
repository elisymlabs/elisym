import {
  deriveOwnerDelegationAta,
  getDelegation,
  type CapabilityCard,
  type DelegationStatus,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import {
  resolveDelegatedBuyMode,
  usesDelegatedRail,
  type DelegatedBuyMode,
} from '~/lib/delegatedBuyMode';

const DELEGATION_STATUS_QUERY_KEY = 'delegation-status';
/** Label freshness only - the money decision re-reads on-chain state at buy time. */
const DELEGATION_STATUS_STALE_MS = 30_000;
/**
 * Re-read cadence after a failed read. A failure holds every send on a
 * delegated-rail card ('check-failed'), and nothing else would refetch until
 * the window regains focus or the surface remounts.
 */
const DELEGATION_STATUS_ERROR_RETRY_MS = 15_000;

const kitRpc = createSolanaRpc(SOLANA_RPC_URL);

/**
 * Drop the cached allowance read for a wallet so every delegated-buy button
 * recomputes its mode. Call after anything that moves the allowance: an
 * approve/revoke in the Delegation tab, or a delivered delegated job (the
 * provider's pull reduced the remaining cap).
 */
export function invalidateDelegationStatus(queryClient: QueryClient, walletAddress: string): void {
  void queryClient.invalidateQueries({
    queryKey: [DELEGATION_STATUS_QUERY_KEY, walletAddress],
  });
}

/** The action a send surface offers for `card` - see `DelegatedBuyMode`. */
export function useDelegatedBuyMode(card: CapabilityCard): DelegatedBuyMode {
  const { publicKey, signMessage } = useWallet();
  const walletAddress = publicKey?.toBase58();
  const canSignMessage = signMessage !== undefined;
  const {
    data: status,
    isFetched,
    isError,
  } = useQuery({
    queryKey: [DELEGATION_STATUS_QUERY_KEY, walletAddress],
    enabled: usesDelegatedRail(card) && walletAddress !== undefined && canSignMessage,
    staleTime: DELEGATION_STATUS_STALE_MS,
    refetchInterval: (query) =>
      query.state.status === 'error' ? DELEGATION_STATUS_ERROR_RETRY_MS : false,
    queryFn: async (): Promise<DelegationStatus | null> => {
      if (walletAddress === undefined) {
        throw new Error('Wallet disconnected.');
      }
      const ownerAta = await deriveOwnerDelegationAta(walletAddress, SOLANA_CLUSTER);
      // getDelegation returns null for a missing ATA (no USDC, hence no
      // delegation) and throws on real RPC failures - a failed read holds the
      // send as 'check-failed', even when a refetch keeps an earlier result.
      return getDelegation(kitRpc, ownerAta);
    },
  });
  return resolveDelegatedBuyMode({
    card,
    walletAddress,
    canSignMessage,
    isFetched,
    isError,
    status,
  });
}
