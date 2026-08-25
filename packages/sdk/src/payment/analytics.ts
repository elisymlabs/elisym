import {
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveNetworkStatsAddress,
  fetchAllMaybeAssetStats,
  fetchMaybeNetworkStats,
} from '@elisym/config-client';
import type { Address, Rpc, Signature, SolanaRpcApi } from '@solana/kit';
import { address } from '@solana/kit';
import {
  DEFAULTS,
  ELISYM_PROTOCOL_TAG,
  PROTOCOL_PROGRAM_ID_DEVNET,
  PROTOCOL_PROGRAM_ID_MAINNET,
} from '../constants';
import type { Network } from '../types';
import { KNOWN_ASSETS, NATIVE_SOL, assetKey, resolveUsdcAsset } from './assets';

/**
 * Aggregated on-chain stats across the entire elisym network. Volume is
 * keyed by `'native'` for SOL or by SPL mint address; values are subunits
 * (lamports for native, raw token units for SPL).
 */
export interface NetworkStatsResult {
  jobCount: number;
  volumeByAsset: Record<string, bigint>;
  /** Most-recent signature returned by the RPC (use as cursor for forward sync). */
  latestSignature?: string;
  /** Oldest signature scanned in this batch (use as `before` for next page). */
  oldestSignature?: string;
}

export interface AggregateNetworkStatsOptions {
  /** Cap on signatures fetched in one call. Defaults to 1000 (RPC max). */
  limit?: number;
  /** Page backwards from this signature for historical scans. */
  before?: Signature;
  /** Parallel `getTransaction` calls. Defaults to `DEFAULTS.QUERY_MAX_CONCURRENCY`. */
  concurrency?: number;
}

const DEFAULT_LIMIT = 1000;
const NATIVE_KEY = 'native';

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/**
 * Enumerate every elisym payment transaction reachable from the protocol tag
 * pubkey and aggregate gross volume + count.
 *
 * Implementation detail: for SPL txs we sum positive token-balance deltas per
 * mint (ignores ATA rent that would inflate native lamport deltas in the same
 * tx). For native SOL txs we sum positive lamport deltas across all non-payer
 * accounts except the protocol's stats PDAs, whose one-time rent deposit is
 * not volume - what remains is the provider + optional fee transfers, i.e.
 * gross volume. The `tx_fee` paid by the fee-payer never shows up as a
 * positive delta, so it is naturally excluded.
 */
export async function aggregateNetworkStats(
  rpc: Rpc<SolanaRpcApi>,
  options?: AggregateNetworkStatsOptions,
): Promise<NetworkStatsResult> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const concurrency = options?.concurrency ?? DEFAULTS.QUERY_MAX_CONCURRENCY;
  const tag = address(ELISYM_PROTOCOL_TAG);

  const signatures = await rpc
    .getSignaturesForAddress(tag, { limit, before: options?.before })
    .send();
  const validSigs = signatures.filter((entry) => entry.err === null);

  if (validSigs.length === 0) {
    return { jobCount: 0, volumeByAsset: {} };
  }

  const volumeByAsset: Record<string, bigint> = {};
  const bookkeepingAddresses = await protocolBookkeepingAddresses();
  let jobCount = 0;

  for (let start = 0; start < validSigs.length; start += concurrency) {
    const batch = validSigs.slice(start, start + concurrency);
    const txResults = await Promise.all(
      batch.map((entry) =>
        rpc
          .getTransaction(entry.signature, {
            commitment: 'confirmed',
            encoding: 'json',
            maxSupportedTransactionVersion: 0,
          })
          .send()
          .catch(() => null),
      ),
    );

    for (const tx of txResults) {
      if (!tx?.meta || tx.meta.err) {
        continue;
      }
      jobCount += 1;
      accumulateTransfers(tx, volumeByAsset, bookkeepingAddresses);
    }
  }

  const latest = validSigs[0]?.signature;
  const oldest = validSigs.at(-1)?.signature;

  return {
    jobCount,
    volumeByAsset,
    latestSignature: latest as string | undefined,
    oldestSignature: oldest as string | undefined,
  };
}

interface RawTransaction {
  meta: {
    err: unknown;
    preBalances: readonly bigint[];
    postBalances: readonly bigint[];
    preTokenBalances?: readonly TokenBalanceEntry[];
    postTokenBalances?: readonly TokenBalanceEntry[];
  } | null;
  transaction: {
    message: {
      accountKeys: readonly string[];
    };
  };
}

/**
 * The protocol's own bookkeeping PDAs. `increment_stats_v2` creates the
 * per-mint `AssetStats` PDA inside the payment transaction when it does not
 * exist yet, so its rent-exemption deposit lands as a positive lamport delta
 * on a non-payer account - real money leaving the payer, but not payment
 * volume. Both cluster program ids are covered: they are the same address
 * today and the constants exist so that can change.
 */
async function protocolBookkeepingAddresses(): Promise<Set<string>> {
  const programIds = [...new Set([PROTOCOL_PROGRAM_ID_DEVNET, PROTOCOL_PROGRAM_ID_MAINNET])];
  const addresses = new Set<string>();
  for (const programId of programIds) {
    addresses.add(await deriveNetworkStatsAddress(programId));
    addresses.add(await deriveAssetStatsAddress(programId, NATIVE_ASSET_SENTINEL));
  }
  return addresses;
}

function accumulateTransfers(
  tx: unknown,
  volumeByAsset: Record<string, bigint>,
  bookkeepingAddresses: ReadonlySet<string>,
): void {
  const raw = tx as RawTransaction;
  const meta = raw.meta;
  if (!meta) {
    return;
  }

  const preTokens = meta.preTokenBalances ?? [];
  const postTokens = meta.postTokenBalances ?? [];
  const isSpl = postTokens.length > 0 || preTokens.length > 0;

  if (isSpl) {
    accumulateSplDeltas(preTokens, postTokens, volumeByAsset);
    return;
  }

  accumulateNativeDeltas(
    meta.preBalances,
    meta.postBalances,
    raw.transaction.message.accountKeys,
    bookkeepingAddresses,
    volumeByAsset,
  );
}

function accumulateSplDeltas(
  pre: readonly TokenBalanceEntry[],
  post: readonly TokenBalanceEntry[],
  volumeByAsset: Record<string, bigint>,
): void {
  for (const postEntry of post) {
    const preEntry = pre.find((entry) => entry.accountIndex === postEntry.accountIndex);
    const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
    const postAmount = BigInt(postEntry.uiTokenAmount.amount);
    const delta = postAmount - preAmount;
    if (delta > 0n) {
      volumeByAsset[postEntry.mint] = (volumeByAsset[postEntry.mint] ?? 0n) + delta;
    }
  }
}

function accumulateNativeDeltas(
  pre: readonly bigint[],
  post: readonly bigint[],
  accountKeys: readonly string[],
  bookkeepingAddresses: ReadonlySet<string>,
  volumeByAsset: Record<string, bigint>,
): void {
  // accountKeys[0] is the fee payer; its negative delta covers gross + tx_fee.
  // Skip it and sum positive deltas of every other account - equals gross,
  // except for the protocol's own stats PDAs, whose one-time rent deposit is
  // not volume.
  for (let i = 1; i < post.length; i++) {
    const accountKey = accountKeys[i];
    if (accountKey !== undefined && bookkeepingAddresses.has(accountKey)) {
      continue;
    }
    const preValue = pre[i] ?? 0n;
    const postValue = post[i] ?? 0n;
    const delta = BigInt(postValue) - BigInt(preValue);
    if (delta > 0n) {
      volumeByAsset[NATIVE_KEY] = (volumeByAsset[NATIVE_KEY] ?? 0n) + delta;
    }
  }
}

/**
 * Best-effort network stats read from the on-chain `NetworkStats` PDA
 * maintained by the elisym-config program. One `getAccountInfo` call - no
 * signature scans, no per-tx aggregation.
 *
 * The PDA is incremented by the client SDK alongside each payment and is not
 * yet bound to a verified transfer, so totals can be inflated cheaply by a
 * malicious caller. Authoritative tracking will land with the escrow rewrite.
 *
 * Returns `null` when the PDA has not been initialized yet (admin must call
 * `initialize_stats` once after program upgrade).
 */
/**
 * Best-effort network counters read from the on-chain PDA. These are NOT bound
 * to verified transfers and can be inflated by a malicious caller, so present
 * them as approximate/unverified, never as authoritative proof of activity. For
 * a transfer-derived figure use `aggregateNetworkStats`.
 */
export interface OnchainNetworkStats {
  jobCount: number;
  /** Total SOL volume: legacy `volume_native` slot + the sentinel `AssetStats` PDA. */
  volumeNative: bigint;
  /**
   * Total USDC volume for the queried network: the legacy `volume_usdc` slot
   * + the network's canonical USDC `AssetStats` PDA.
   */
  volumeUsdc: bigint;
  /**
   * Per-asset volumes for every `KNOWN_ASSETS` member, keyed by `assetKey`.
   * SOL and the network's USDC merge their legacy fixed slots (still written
   * by deployed old clients) with the per-mint PDAs (written by
   * `increment_stats_v2`); each payment carries exactly one of the two
   * instructions, so the sum never double-counts. Other assets read their
   * PDA alone.
   */
  volumeByAssetKey: Record<string, bigint>;
}

export async function getNetworkStats(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  network: Network,
): Promise<OnchainNetworkStats | null> {
  const statsPda = await deriveNetworkStatsAddress(programId);
  const account = await fetchMaybeNetworkStats(rpc, statsPda);
  if (!account.exists) {
    return null;
  }

  const targets = await Promise.all(
    KNOWN_ASSETS.map(async (asset) => ({
      key: assetKey(asset),
      pda: await deriveAssetStatsAddress(
        programId,
        asset.mint ? address(asset.mint) : NATIVE_ASSET_SENTINEL,
      ),
    })),
  );

  // Seeded up front so every known asset is present as 0n regardless of what
  // the batch read returns - a short response must not leave an asset key
  // absent from the record, which callers index by `assetKey`.
  const volumeByAssetKey: Record<string, bigint> = {};
  for (const target of targets) {
    volumeByAssetKey[target.key] = 0n;
  }
  // A PDA that does not exist yet reads back as `exists: false`, so a program
  // that predates `AssetStats` needs no special handling here. Anything that
  // throws is an RPC failure, and it propagates: swallowing it would return
  // zeros that are indistinguishable from "no volume", and on mainnet - where
  // the legacy slots are permanently 0 because the cluster shipped with v2 -
  // that renders a whole dashboard empty with no error. The `NetworkStats`
  // read above is unguarded for the same reason.
  const assetAccounts = await fetchAllMaybeAssetStats(
    rpc,
    targets.map((target) => target.pda),
  );
  for (const [index, assetAccount] of assetAccounts.entries()) {
    const target = targets[index];
    if (target) {
      volumeByAssetKey[target.key] = assetAccount.exists ? assetAccount.data.volume : 0n;
    }
  }

  // The legacy fixed slots keep accruing from deployed old clients. The
  // `volume_usdc` slot belongs to the QUERIED network's canonical USDC -
  // folding it into a hardcoded mint key would silently drop the other
  // network's v2 volume from the merged view.
  const solKey = assetKey(NATIVE_SOL);
  const usdcKey = assetKey(resolveUsdcAsset(network));
  volumeByAssetKey[solKey] = (volumeByAssetKey[solKey] ?? 0n) + account.data.volumeNative;
  volumeByAssetKey[usdcKey] = (volumeByAssetKey[usdcKey] ?? 0n) + account.data.volumeUsdc;

  return {
    jobCount: Number(account.data.jobCount),
    volumeNative: volumeByAssetKey[solKey] ?? 0n,
    volumeUsdc: volumeByAssetKey[usdcKey] ?? 0n,
    volumeByAssetKey,
  };
}
