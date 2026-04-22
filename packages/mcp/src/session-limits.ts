/**
 * Session spend limits for the MCP process.
 *
 * Hardcoded defaults apply unless overridden in `~/.elisym/config.yaml`. The
 * counter they gate lives in `AgentContext.sessionSpent` and is shared across
 * every agent running in this process.
 */

import {
  assetKey,
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  parseAssetAmount,
  resolveKnownAsset,
  type Asset,
} from '@elisym/sdk';
import { globalConfigPath } from '@elisym/sdk/agent-store';
import { loadGlobalConfig } from '@elisym/sdk/node';

export interface DefaultLimit {
  asset: Asset;
  /** Human-readable amount ("0.1", "10"). Parsed at startup with `parseAssetAmount`. */
  humanAmount: string;
}

/**
 * Default caps shipped with the binary. Edit this list (and rebuild) to change
 * out-of-the-box limits. Entries for tokens that are not yet in
 * `@elisym/sdk` KNOWN_ASSETS have no effect until both lists are updated
 * together.
 */
export const DEFAULT_SESSION_LIMITS: readonly DefaultLimit[] = [
  { asset: NATIVE_SOL, humanAmount: '0.5' },
  { asset: USDC_SOLANA_DEVNET, humanAmount: '50' },
];

/** Materialize DEFAULT_SESSION_LIMITS into a Map<AssetKey, rawBigint>. */
export function defaultSpendLimitsMap(): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const entry of DEFAULT_SESSION_LIMITS) {
    map.set(assetKey(entry.asset), parseAssetAmount(entry.asset, entry.humanAmount));
  }
  return map;
}

/**
 * Load `~/.elisym/config.yaml` overrides, merge on top of defaults, and return
 * the effective limit map. Fails fast on unknown asset, duplicates, or
 * malformed YAML — a misconfigured override should not silently fall back to
 * defaults.
 */
export async function buildEffectiveLimits(): Promise<Map<string, bigint>> {
  const map = defaultSpendLimitsMap();
  const cfg = await loadGlobalConfig(globalConfigPath());
  const overrides = cfg.session_spend_limits ?? [];
  const seen = new Set<string>();
  for (const entry of overrides) {
    const asset = resolveKnownAsset(entry.chain, entry.token, entry.mint);
    const key = asset ? assetKey(asset) : null;
    if (!asset || !key) {
      const display = entry.mint
        ? `${entry.chain}:${entry.token}:${entry.mint}`
        : `${entry.chain}:${entry.token}`;
      throw new Error(
        `Unknown asset in ${globalConfigPath()}: ${display}. ` +
          'Update the SDK KNOWN_ASSETS list or remove the override.',
      );
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate session_spend_limit entry in ${globalConfigPath()}: ${key}`);
    }
    seen.add(key);
    map.set(key, parseAssetAmount(asset, entry.amount.toString()));
  }
  return map;
}
