import { splAssetsForNetwork, assetKey, type Asset } from '@elisym/sdk';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  address as toAddress,
  createSolanaRpc,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
} from '@solana/kit';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { useWalletStandardChange } from './useWalletStandardChange';

const BALANCE_STALE_MS = 1000 * 10;
const BALANCE_REFETCH_MS = 1000 * 10;

const SOL_BALANCE_QUERY_KEY = 'sol-balance-raw';
const SPL_BALANCE_QUERY_KEY = 'spl-balance-raw';

/**
 * The SPL assets that exist on this page's cluster (USDC everywhere; LSM on
 * mainnet only). Module-level and cluster-fixed per page load, like every
 * other network-derived constant in the app.
 */
export const SPL_WALLET_ASSETS: readonly Asset[] = splAssetsForNetwork(SOLANA_CLUSTER);

/**
 * Trigger an immediate refetch of the wallet's SOL + SPL balances.
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
  // SPL keys are [key, assetKey, wallet], so a wallet-scoped prefix match is
  // not possible; invalidating the whole prefix over-invalidates at most a
  // handful of queries and keeps the call signature stable.
  queryClient.invalidateQueries({ queryKey: [SPL_BALANCE_QUERY_KEY] });
}

// Module-level Kit RPC singleton: balance queries fire from many components
// and we want to share a single connection. Cluster comes from `~/lib/cluster`.
const balanceRpc = createSolanaRpc(SOLANA_RPC_URL);

interface WalletBalances {
  solLamports: bigint | null;
  /**
   * Raw SPL balances keyed by `assetKey(asset)` for every `SPL_WALLET_ASSETS`
   * member. `null` while that asset's balance is loading.
   */
  splRaw: Record<string, bigint | null>;
  isSolLoading: boolean;
  /** The SOL balance read failed - unknown, not zero (same rule as SPL). */
  isSolError: boolean;
  /**
   * Per-asset loading flags keyed by `assetKey(asset)`. Display surfaces use
   * these so a slow asset does not put an already-resolved sibling row back
   * into a skeleton.
   */
  isSplLoadingByAsset: Record<string, boolean>;
  /**
   * Per-asset error flags keyed by `assetKey(asset)`. A failed read is not a
   * zero balance: display surfaces must say the balance is unknown rather than
   * render "0" for a wallet that may hold a fortune.
   */
  isSplErrorByAsset: Record<string, boolean>;
}

/**
 * Fetch the connected wallet's SOL and SPL (USDC; LSM on mainnet) balances as
 * raw subunits.
 *
 * Callers format for display (round, convert to whole units) - we return
 * subunit BigInts so the wallet menu can show a rounded number while the
 * Buy button can do exact `>=` math against a job_price subunit value.
 *
 * Query keys are scoped to the wallet base58 string so multiple consumers
 * (header WalletMenu + agent page Buy button) share a single TanStack cache
 * entry and only one RPC call fires per refetch window.
 *
 * ATA derivation uses each asset's owner token program (classic SPL for USDC,
 * Token-2022 for LSM). ATA-not-found resolves to `0n` (a fresh wallet that
 * has never held the token). Other RPC errors propagate so TanStack Query can
 * mark the query as errored and stop the refetch loop until the wallet
 * reconnects.
 */
export function useWalletBalances(): WalletBalances {
  const { publicKey } = useWallet();
  const walletAddress = publicKey?.toBase58() ?? null;
  const queryClient = useQueryClient();

  // Wallet Standard `change` covers cluster toggles AND in-wallet account
  // switches. The query key already keys on `walletAddress`, so an account
  // switch refetches via the new key naturally - the explicit invalidate
  // here primarily covers cluster toggles, where the address is unchanged
  // but we still want fresh balances without waiting for the polling tick.
  useWalletStandardChange(() => {
    invalidateWalletBalances(queryClient, walletAddress);
  });

  const {
    data: solLamports = null,
    isLoading: isSolLoading,
    isError: isSolError,
  } = useQuery({
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

  const splQueries = useQueries({
    queries: SPL_WALLET_ASSETS.map((asset) => ({
      queryKey: [SPL_BALANCE_QUERY_KEY, assetKey(asset), walletAddress],
      queryFn: async (): Promise<bigint> => {
        if (!walletAddress || !asset.mint) {
          return 0n;
        }
        const owner = toAddress(walletAddress);
        const tokenProgram = asset.tokenProgram
          ? toAddress(asset.tokenProgram)
          : TOKEN_PROGRAM_ADDRESS;
        const [ata] = await findAssociatedTokenPda({
          owner,
          tokenProgram,
          mint: toAddress(asset.mint),
        });
        try {
          const { value } = await balanceRpc.getTokenAccountBalance(ata).send();
          return BigInt(value.amount);
        } catch (error) {
          // No ATA for this owner yet => user has never held the token. Only
          // the node's "could not find account" refusal (JSON-RPC -32602)
          // maps to 0n - transient failures (network, 5xx, rate limits)
          // re-throw so TanStack marks the query errored instead of rendering
          // a false zero balance. Matched via the typed server message, not
          // error.message, which collapses to an opaque error code in
          // production builds.
          if (
            isSolanaError(error, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS) &&
            /could not find account/i.test(error.context.__serverMessage)
          ) {
            return 0n;
          }
          throw error;
        }
      },
      enabled: !!walletAddress,
      staleTime: BALANCE_STALE_MS,
      refetchInterval: BALANCE_REFETCH_MS,
    })),
  });

  const splRaw: Record<string, bigint | null> = {};
  const isSplLoadingByAsset: Record<string, boolean> = {};
  const isSplErrorByAsset: Record<string, boolean> = {};
  for (const [index, asset] of SPL_WALLET_ASSETS.entries()) {
    splRaw[assetKey(asset)] = splQueries[index]?.data ?? null;
    isSplLoadingByAsset[assetKey(asset)] = !!walletAddress && !!splQueries[index]?.isLoading;
    isSplErrorByAsset[assetKey(asset)] = !!walletAddress && !!splQueries[index]?.isError;
  }
  return {
    solLamports,
    splRaw,
    isSolLoading: !!walletAddress && isSolLoading,
    isSolError: !!walletAddress && isSolError,
    isSplLoadingByAsset,
    isSplErrorByAsset,
  };
}
