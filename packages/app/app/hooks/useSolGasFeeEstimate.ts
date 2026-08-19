import {
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  assetByKey,
  assetKey,
  estimateAssetStatsRentLamports,
  estimatePriorityFeeMicroLamports,
  getProtocolProgramId,
  type CapabilityCard,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { useEffect, useState } from 'react';
import { resolvePaymentAsset } from '~/lib/cardAsset';
import { SDK_CLUSTER, SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';

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
 * Rent-exempt minimum for a 165-byte classic SPL Token account, in lamports.
 * Worst-case the SPL flow creates two ATAs (recipient + treasury), so a
 * classic-SPL preview (USDC) adds 2x this value when no on-chain probing is
 * done; a Token-2022 card (LSM) adds 2x `T22_ATA_RENT_LAMPORTS` instead.
 *
 * If you ever change this, double-check against
 * `rpc.getMinimumBalanceForRentExemption(165n).send()` on devnet.
 */
const ATA_RENT_LAMPORTS = 2_039_280;

/**
 * Rent-exempt minimum for a 170-byte Token-2022 ATA (165 base + 1
 * account-type byte + 4-byte `ImmutableOwner` TLV, mandatory on t22 ATAs).
 * Verify with `rpc.getMinimumBalanceForRentExemption(170n).send()`.
 */
const T22_ATA_RENT_LAMPORTS = 2_074_080;

const PRIORITY_FEE_PERCENTILE = 75;
const REFRESH_MS = 30_000;

// Shared across all consumers so we only hit RPC once per refresh window.
const rpc = createSolanaRpc(SOLANA_RPC_URL);
// Kept for a future extension that scopes priority-fee samples to the
// protocol program address. `estimatePriorityFeeMicroLamports` ignores it
// today but keeping the lookup here avoids re-importing from every caller.
void getProtocolProgramId(SDK_CLUSTER);

/**
 * Per-ATA rent for the card's payment asset: 0 for native SOL and for assets
 * this cluster cannot pay, classic or Token-2022 rent for its known SPL
 * assets. The token program comes from the asset registry, so an LSM card
 * prices t22-sized ATAs.
 */
function ataRentForCard(card: CapabilityCard | undefined): number {
  const asset = resolvePaymentAsset(card?.payment, SOLANA_CLUSTER);
  if (!asset?.mint) {
    return 0;
  }
  return asset.tokenProgram === TOKEN_2022_PROGRAM_ADDRESS_STR
    ? T22_ATA_RENT_LAMPORTS
    : ATA_RENT_LAMPORTS;
}

/**
 * Rough estimate of the lamports the wallet will spend in network fees for a
 * payment: base signature fee plus a 75th-percentile priority fee sized to
 * the payment tx's compute-unit limit. For SPL cards we additionally add
 * twice the asset's per-ATA rent as a worst-case allowance for recipient + treasury
 * ATA creation - the SDK builder issues idempotent-create instructions that
 * are no-ops when the ATA already exists, but the wallet preview can't tell
 * upfront, so we surface the rent rather than understate the gas line.
 *
 * Refreshes every 30s so the number follows live network conditions. Falls
 * back to the base fee if RPC is unreachable. The one-time `AssetStats` rent
 * the payment tx charges for a not-yet-created per-asset PDA is probed and
 * added on top - it applies to native SOL cards too, which have no ATA
 * allowance to hide it.
 */
export function useSolGasFeeEstimate(card?: CapabilityCard): number {
  const [priorityLamports, setPriorityLamports] = useState<number>(0);
  // Keyed by the asset it was probed for: switching cards must not carry the
  // previous asset's rent into the new quote while the next probe is in flight.
  const [statsRent, setStatsRent] = useState<{ assetKey: string; lamports: number } | null>(null);
  const cardAsset = resolvePaymentAsset(card?.payment, SOLANA_CLUSTER);
  const cardAssetKey = cardAsset ? assetKey(cardAsset) : null;

  // The payment tx also creates the per-asset `AssetStats` PDA when it does not
  // exist yet, and bills the payer for its rent - on native SOL cards too,
  // where there is no ATA allowance to absorb it. Probed rather than assumed:
  // once the PDA exists the charge is gone and the quote must not keep it.
  useEffect(() => {
    if (cardAssetKey === null) {
      return;
    }
    const asset = assetByKey(cardAssetKey);
    if (!asset) {
      return;
    }
    let cancelled = false;
    estimateAssetStatsRentLamports(rpc, SOLANA_CLUSTER, asset)
      .then((lamports) => {
        if (!cancelled) {
          setStatsRent({ assetKey: cardAssetKey, lamports: Number(lamports) });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cardAssetKey]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      estimatePriorityFeeMicroLamports(rpc, {
        network: SOLANA_CLUSTER,
        percentile: PRIORITY_FEE_PERCENTILE,
      })
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

  const ataAllowance = 2 * ataRentForCard(card);
  const statsRentLamports =
    statsRent !== null && statsRent.assetKey === cardAssetKey ? statsRent.lamports : 0;
  return BASE_FEE_LAMPORTS + priorityLamports + ataAllowance + statsRentLamports;
}
