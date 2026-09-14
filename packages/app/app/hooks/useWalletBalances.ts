import { assetKey, type Asset } from '@elisym/sdk';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  address as toAddress,
  createSolanaRpc,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
} from '@solana/kit';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SOLANA_RPC_URL } from '~/lib/cluster';
import { useWalletStandardChange } from './useWalletStandardChange';

// 30s, not 10: a wallet balance rarely moves on its own, and the events that
// do move it are handled without waiting for a tick - a purchase or a
// delegation change calls `invalidateWalletBalances`, and coming back to the
// tab refetches on focus. That last one needs `refetchOnWindowFocus: 'always'`
// below: the default `true` only refetches once the data is already older than
// `staleTime`, so at 30s it would sleep through exactly the case it is here
// for - the user returning from topping up in their wallet. The interval
// is the fallback, and every tick it does run costs a paid-endpoint RPC call
// per asset.
const BALANCE_STALE_MS = 1000 * 30;
const BALANCE_REFETCH_MS = 1000 * 30;

const SOL_BALANCE_QUERY_KEY = 'sol-balance-raw';
const SPL_BALANCE_QUERY_KEY = 'spl-balance-raw';

/**
 * How long a click-time balance read may take before the buy gives up on it.
 * Short on purpose: the read only ever tightens the buy gate, never loosens
 * it, so waiting longer than this costs more than the check is worth.
 */
const BALANCE_RECHECK_TIMEOUT_MS = 2500;

/**
 * Trigger an immediate refetch of the wallet's SOL + SPL balances.
 *
 * Call this from flows that mutate the wallet on-chain (e.g. after a payment
 * tx confirms) so the UI reflects the new balance without waiting for the
 * next polling tick.
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

// These two fail loudly rather than returning `0n`. A fabricated zero is the
// one answer this module must never produce: the queries are `enabled` only
// with a wallet, so reaching either guard is a caller bug, and an errored
// query keeps its last good reading while the click path maps the failure to
// `null` (unknown) - both correct, unlike a confident zero.
async function fetchSolLamports(walletAddress: string | null): Promise<bigint> {
  if (!walletAddress) {
    throw new Error('No wallet connected');
  }
  const owner = toAddress(walletAddress);
  const { value: lamports } = await balanceRpc.getBalance(owner).send();
  return BigInt(lamports.toString());
}

async function fetchSplRaw(walletAddress: string | null, asset: Asset): Promise<bigint> {
  if (!walletAddress) {
    throw new Error('No wallet connected');
  }
  if (!asset.mint) {
    throw new Error(`${asset.symbol} has no mint - it is not an SPL asset`);
  }
  const owner = toAddress(walletAddress);
  const tokenProgram = asset.tokenProgram ? toAddress(asset.tokenProgram) : TOKEN_PROGRAM_ADDRESS;
  const [ata] = await findAssociatedTokenPda({
    owner,
    tokenProgram,
    mint: toAddress(asset.mint),
  });
  try {
    const { value } = await balanceRpc.getTokenAccountBalance(ata).send();
    return BigInt(value.amount);
  } catch (error) {
    // No ATA for this owner yet => user has never held the token. Only the
    // node's "could not find account" refusal (JSON-RPC -32602) maps to 0n -
    // transient failures (network, 5xx, rate limits) re-throw so TanStack
    // marks the query errored instead of rendering a false zero balance.
    // Matched via the typed server message, not error.message, which
    // collapses to an opaque error code in production builds.
    if (
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS) &&
      /could not find account/i.test(error.context.__serverMessage)
    ) {
      return 0n;
    }
    throw error;
  }
}

/**
 * Bound a click-time read: resolve `null` instead of hanging, so an
 * unreachable RPC abstains from the affordability check rather than holding a
 * purchase open on a socket the browser may never time out on its own.
 *
 * Exported, with the bound as an argument, so the abandon behavior is testable
 * without standing up an RPC.
 */
export function withReadTimeout(
  read: Promise<bigint>,
  timeoutMs: number = BALANCE_RECHECK_TIMEOUT_MS,
): Promise<bigint | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([read.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Write a freshly read balance into the polling cache so the hook's observers
 * re-gate on it.
 *
 * Cancels any refetch for that key first: left alone it would resolve after
 * this write and put a different balance back. Nothing is cancelled when no
 * fetch is in flight, and a read that came back unknown never gets here, so a
 * failed click never kills a live poll.
 *
 * The trade is deliberate but not free: a poll that started AFTER this read
 * would have been the fresher answer, and cancelling it installs the older
 * one. That costs at most one interval of staleness on a value the click has
 * already decided from, whereas letting a poll issued BEFORE the read land on
 * top of it would undo the refresh entirely.
 */
async function primeBalance(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  balance: bigint,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, balance);
}

/**
 * One asset: read it under the timeout and prime it immediately.
 *
 * Per asset, not after the whole batch - a fast leg must not sit on its result
 * while a slow sibling runs, or a polling tick that lands in between gets
 * overwritten by the older reading.
 *
 * Exported for the same reason as `withReadTimeout`: it takes the read as a
 * promise, so priming is testable against a plain `QueryClient`.
 */
export async function readAndPrimeBalance(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  read: Promise<bigint>,
  timeoutMs: number = BALANCE_RECHECK_TIMEOUT_MS,
): Promise<bigint | null> {
  const balance = await withReadTimeout(read, timeoutMs);
  if (balance !== null) {
    try {
      await primeBalance(queryClient, queryKey, balance);
    } catch {
      // Nothing in `primeBalance` rejects today - `cancelQueries` resolves
      // through `.catch(noop)` and `setQueryData` is a synchronous cache
      // write. This is here so that stays true of the CALLER if it ever grows
      // a fallible step: priming is a cache courtesy, and losing a decided,
      // affordable purchase to a cache write would be absurd.
    }
  }
  return balance;
}

/**
 * Read the wallet's balances now, bypassing the polling cache, and prime the
 * cache with whatever came back.
 *
 * For the moment a purchase actually starts: the button that enabled it was
 * gated on a cached balance that can be well out of date - the interval skips
 * ticks while the tab is hidden, which is exactly where a user goes to spend -
 * and a wallet drained in that window should produce our own message rather
 * than a failure the user only meets inside their wallet. A read that fails or times out resolves to
 * `null` for that asset - unknown, never zero - which callers must treat as
 * "do not block".
 *
 * Deliberately NOT `queryClient.fetchQuery`: when a polling refetch is already
 * in flight, `fetchQuery` hands back that in-flight promise instead of
 * starting a read, so the click would inherit the poll's retry schedule and
 * could be served a value fetched before the click.
 *
 * `splAssets` is what the caller actually needs in order to decide, not every
 * asset on the cluster - the click waits on the slowest read, so a mainnet
 * SOL-priced card has no reason to fetch two token accounts it never consults.
 */
export async function fetchWalletBalancesNow(
  queryClient: QueryClient,
  walletAddress: string,
  splAssets: readonly Asset[],
): Promise<{ solLamports: bigint | null; splRaw: Record<string, bigint | null> }> {
  const [solLamports = null, ...splValues] = await Promise.all([
    readAndPrimeBalance(
      queryClient,
      [SOL_BALANCE_QUERY_KEY, walletAddress],
      fetchSolLamports(walletAddress),
    ),
    ...splAssets.map((asset) =>
      readAndPrimeBalance(
        queryClient,
        [SPL_BALANCE_QUERY_KEY, assetKey(asset), walletAddress],
        fetchSplRaw(walletAddress, asset),
      ),
    ),
  ]);
  const splRaw: Record<string, bigint | null> = {};
  for (const [index, asset] of splAssets.entries()) {
    splRaw[assetKey(asset)] = splValues[index] ?? null;
  }
  return { solLamports, splRaw };
}

interface WalletBalances {
  /**
   * `null` until the first successful read - never a stand-in for zero, so a
   * consumer must abstain rather than tell a wallet that may hold a fortune it
   * is empty. After a failure the last good reading keeps being served.
   */
  solLamports: bigint | null;
  /**
   * Raw SPL balances keyed by `assetKey(asset)` for every requested asset,
   * `null` carrying exactly the same meaning as on `solLamports`.
   */
  splRaw: Record<string, bigint | null>;
}

/**
 * Fetch the connected wallet's SOL balance, plus the SPL balances of the
 * assets the caller asks for, as raw subunits.
 *
 * `splAssets` is what the caller will actually read, not every asset on the
 * cluster: this polls forever while mounted, so an asset nobody consults is a
 * paid RPC call every interval for nothing.
 *
 * Subunit BigInts, never formatted numbers: the affordability gate behind the
 * Buy button does exact `>=` math against a `job_price` subunit value.
 *
 * Query keys are scoped to the wallet base58 string, so every consumer shares
 * one cache entry per asset AND one poll. Mounting the hook several times on a
 * page (the chat composer plus one per retry button) does not multiply the RPC
 * cost: each mount is its own observer, but every query update resynchronizes
 * all of their intervals, so their ticks land together and dedupe onto a
 * single in-flight fetch. `fetchWalletBalancesNow` writes into the same
 * entries but reads around them, so a click adds a call of its own.
 *
 * ATA derivation uses each asset's owner token program (classic SPL for USDC,
 * Token-2022 for LSM). ATA-not-found resolves to `0n` (a fresh wallet that
 * has never held the token). Other RPC errors propagate rather than resolving
 * to a false zero: the query goes errored while keeping its last good
 * reading, and the interval keeps ticking - it is never gated on status - so a
 * transient failure heals on its own.
 */
export function useWalletBalances(splAssets: readonly Asset[]): WalletBalances {
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

  const { data: solData } = useQuery({
    queryKey: [SOL_BALANCE_QUERY_KEY, walletAddress],
    queryFn: (): Promise<bigint> => fetchSolLamports(walletAddress),
    enabled: !!walletAddress,
    staleTime: BALANCE_STALE_MS,
    refetchInterval: BALANCE_REFETCH_MS,
    refetchOnWindowFocus: 'always',
  });

  const splQueries = useQueries({
    queries: splAssets.map((asset) => ({
      queryKey: [SPL_BALANCE_QUERY_KEY, assetKey(asset), walletAddress],
      queryFn: (): Promise<bigint> => fetchSplRaw(walletAddress, asset),
      enabled: !!walletAddress,
      staleTime: BALANCE_STALE_MS,
      refetchInterval: BALANCE_REFETCH_MS,
      refetchOnWindowFocus: 'always' as const,
    })),
  });

  // `data`, deliberately not an error-aware mapping - and deliberately the
  // OPPOSITE policy from the click-time read above, which treats a failed read
  // as unknown and abstains. TanStack keeps the last successful reading on an
  // errored query, and for a render gate deciding real money a stale balance
  // is better evidence than none: blanking it would enable the button for a
  // wallet last seen unable to pay, costing a wasted provider round-trip and a
  // failed entry. The click path can afford to abstain because the wallet is
  // the next arbiter either way. `undefined` (nothing read yet) is the only
  // `null`, and the interval keeps polling, so an outage heals itself.
  const solLamports = solData ?? null;
  const splRaw: Record<string, bigint | null> = {};
  for (const [index, asset] of splAssets.entries()) {
    splRaw[assetKey(asset)] = splQueries[index]?.data ?? null;
  }
  return { solLamports, splRaw };
}
