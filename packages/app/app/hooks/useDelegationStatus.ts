import {
  assetKey,
  deriveOwnerDelegationAta,
  getDelegation,
  resolveUsdcAsset,
  type CapabilityCard,
  type DelegationStatus,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { resolvePaymentAsset } from '~/lib/cardAsset';
import { SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';

const DELEGATION_STATUS_QUERY_KEY = 'delegation-status';
/** Label freshness only - the money decision re-reads on-chain state at buy time. */
const DELEGATION_STATUS_STALE_MS = 30_000;

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

export type DelegatedBuyMode = 'per-job' | 'loading' | 'use' | 'delegate';

/**
 * Which action the buy button offers for a delegation-advertising card:
 *
 * - `'use'` - the connected wallet holds an active allowance to the card's
 *   delegate key covering the price: the button submits a delegated job.
 * - `'delegate'` - the card advertises delegation and this wallet could use
 *   it, but no covering allowance exists (none yet, delegated to a different
 *   key, or cap/balance below the price): the button routes to the
 *   Delegation tab instead of buying.
 * - `'loading'` - the card advertises delegation but the allowance read has
 *   not resolved yet: the button shows a spinner instead of flashing Buy and
 *   then flipping to Use/Delegate.
 * - `'per-job'` - delegation does not apply here (free card, no delegation on
 *   the card, no wallet, wallet without `signMessage`) or the allowance read
 *   failed after retries: the regular per-job payment flow.
 *
 * Presentation-layer only: BuyContext re-verifies the allowance on-chain at
 * click time before any delegated submit.
 */
export function useDelegatedBuyMode(card: CapabilityCard): DelegatedBuyMode {
  const { publicKey, signMessage } = useWallet();
  const walletAddress = publicKey?.toBase58();
  const descriptor = card.delegation;
  const price = BigInt(card.payment?.job_price ?? 0);
  // USDC-only mirrors the provider-side load guard: `job_price` on any other
  // asset is in different subunits (e.g. lamports), so comparing it against a
  // USDC allowance would light up Use for a wildly wrong amount.
  //
  // Must be the SAME test BuyContext applies before taking the delegated path
  // (asset identity, not the card's `token` string). A looser test here lights
  // up "Use" for a card the buy then refuses, and that refusal does not
  // invalidate the status - so the button stays lit and every click repeats
  // the same error.
  const cardAsset = resolvePaymentAsset(card.payment, SOLANA_CLUSTER);
  const capable =
    price > 0n &&
    cardAsset !== null &&
    assetKey(cardAsset) === assetKey(resolveUsdcAsset(SOLANA_CLUSTER)) &&
    descriptor !== undefined &&
    walletAddress !== undefined &&
    signMessage !== undefined;
  const { data: status, isFetched } = useQuery({
    queryKey: [DELEGATION_STATUS_QUERY_KEY, walletAddress],
    enabled: capable,
    staleTime: DELEGATION_STATUS_STALE_MS,
    queryFn: async (): Promise<DelegationStatus | null> => {
      if (walletAddress === undefined) {
        throw new Error('Wallet disconnected.');
      }
      const ownerAta = await deriveOwnerDelegationAta(walletAddress, SOLANA_CLUSTER);
      // getDelegation returns null for a missing ATA (no USDC, hence no
      // delegation) and throws on real RPC failures - a failed read leaves
      // `status` undefined and the mode falls back to 'per-job'.
      return getDelegation(kitRpc, ownerAta);
    },
  });
  if (!capable || descriptor === undefined) {
    return 'per-job';
  }
  if (!isFetched) {
    return 'loading';
  }
  if (status === undefined) {
    return 'per-job';
  }
  const covering =
    status !== null &&
    status.delegate === descriptor.delegate_pubkey &&
    status.remainingCap >= price &&
    status.balance >= price;
  return covering ? 'use' : 'delegate';
}
