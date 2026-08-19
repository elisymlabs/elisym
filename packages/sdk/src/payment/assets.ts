/**
 * Multi-asset / multi-chain payment model.
 *
 * `Asset` describes a currency a customer can spend: native coins (SOL, ETH, BTC)
 * or tokens (SPL, ERC-20). `assetKey` produces a stable string id for Map lookups.
 *
 * `KNOWN_ASSETS` holds native SOL plus the SPL assets (USDC per network, LSM
 * on mainnet). New assets and chains are extended by adding entries to
 * `KNOWN_ASSETS` and, always, to the MCP `DEFAULT_SESSION_LIMITS` catalogue -
 * an asset without a limits entry is spend-uncapped in MCP sessions.
 */

import Decimal from 'decimal.js-light';
import type { Network } from '../types';

export type Chain = 'solana';

/**
 * Token-2022 program address. Assets whose mint lives under this program set
 * `Asset.tokenProgram`; the payment path derives ATAs and targets
 * `transferChecked` at it instead of the classic SPL Token program.
 */
export const TOKEN_2022_PROGRAM_ADDRESS_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface Asset {
  chain: Chain;
  /** Lowercase token id: 'sol', 'usdc', 'lsm', 'btc', 'eth'. */
  token: string;
  /** SPL mint / ERC-20 contract. Undefined for a native coin. */
  mint?: string;
  /** Subunits per whole (9 SOL, 6 USDC, 8 BTC, 18 ETH). */
  decimals: number;
  /** Display symbol: 'SOL', 'USDC', 'LSM'. */
  symbol: string;
  /**
   * Owner program of `mint`. Absent = the classic SPL Token program. Never set
   * for native coins. Only extension-free-transfer Token-2022 mints are
   * supported (no transfer-fee/transfer-hook accounts are appended), which is
   * guaranteed by admitting token-2022 assets exclusively via `KNOWN_ASSETS`.
   */
  tokenProgram?: string;
}

export const NATIVE_SOL: Asset = {
  chain: 'solana',
  token: 'sol',
  decimals: 9,
  symbol: 'SOL',
};

export const USDC_SOLANA_DEVNET: Asset = {
  chain: 'solana',
  token: 'usdc',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  decimals: 6,
  symbol: 'USDC',
};

export const USDC_SOLANA_MAINNET: Asset = {
  chain: 'solana',
  token: 'usdc',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  symbol: 'USDC',
};

/**
 * The $LSM token - mainnet only. Mint facts verified on-chain 2026-07-31:
 * owner program Token-2022, decimals 6, supply ~999.99M, mint authority null,
 * freeze authority null, extension set exactly {metadataPointer, tokenMetadata}
 * and frozen forever (no authority exists to add extensions) - so plain
 * `transferChecked` with no extra accounts suffices permanently. There is no
 * devnet LSM: on devnet the skill loader falls back to native SOL (loudly).
 */
export const LSM_SOLANA_MAINNET: Asset = {
  chain: 'solana',
  token: 'lsm',
  mint: '86T4G3zJaBxQAuWAbfXggE5d5XEt4bns3Y41jgVLpump',
  decimals: 6,
  symbol: 'LSM',
  tokenProgram: TOKEN_2022_PROGRAM_ADDRESS_STR,
};

export const KNOWN_ASSETS: readonly Asset[] = [
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  LSM_SOLANA_MAINNET,
];

/**
 * The canonical USDC asset for a network. The mint differs per cluster, so
 * every USDC-touching path must resolve through the active network - a flat
 * `KNOWN_ASSETS` lookup cannot distinguish the two.
 */
export function resolveUsdcAsset(network: Network): Asset {
  return network === 'mainnet' ? USDC_SOLANA_MAINNET : USDC_SOLANA_DEVNET;
}

/**
 * The LSM asset for a network, or `undefined` where it does not exist (LSM is
 * mainnet-only). Callers decide what "not available" means for their surface:
 * the skill loader falls back to native SOL, MCP payment paths refuse, and UI
 * surfaces simply do not list it.
 */
export function resolveLsmAsset(network: Network): Asset | undefined {
  return network === 'mainnet' ? LSM_SOLANA_MAINNET : undefined;
}

/**
 * The SPL assets that exist on a network - the single source of truth for
 * balance listings, affordability checks, and per-network guards. Devnet:
 * USDC only. Mainnet: USDC + LSM.
 */
export function splAssetsForNetwork(network: Network): Asset[] {
  const lsm = resolveLsmAsset(network);
  return lsm ? [resolveUsdcAsset(network), lsm] : [resolveUsdcAsset(network)];
}

/** Stable Map key for `Asset`. Same shape regardless of Asset identity. */
export function assetKey(a: Pick<Asset, 'chain' | 'token' | 'mint'>): string {
  return a.mint ? `${a.chain}:${a.token}:${a.mint}` : `${a.chain}:${a.token}`;
}

/** Find a known asset by (chain, token, mint). Returns undefined if unknown. */
export function resolveKnownAsset(chain: string, token: string, mint?: string): Asset | undefined {
  const key = mint ? `${chain}:${token}:${mint}` : `${chain}:${token}`;
  return KNOWN_ASSETS.find((asset) => assetKey(asset) === key);
}

/** Reverse lookup: given an assetKey string, return the known asset or undefined. */
export function assetByKey(key: string): Asset | undefined {
  return KNOWN_ASSETS.find((asset) => assetKey(asset) === key);
}

/**
 * Resolve the asset a payment request targets. Returns `NATIVE_SOL` when the
 * request has no `asset` field (back-compat with payment requests published
 * before multi-asset support). Throws when `asset` is present but refers to an
 * asset that isn't in `KNOWN_ASSETS` - callers that want to tolerate unknown
 * assets should check `resolveKnownAsset` directly instead.
 */
/**
 * Strip a provider-supplied asset id to safe chars before embedding it in an error
 * message. `asset.chain`/`token`/`mint` are raw provider input here (this runs
 * before any Zod schema), so an un-stripped value could smuggle prompt-injection
 * text (newlines, fake markers) into an error that surfaces to a customer LLM.
 */
function displayAssetId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 64);
}

export function resolveAssetFromPaymentRequest(request: {
  asset?: { chain: string; token: string; mint?: string };
}): Asset {
  if (!request.asset) {
    return NATIVE_SOL;
  }
  const found = resolveKnownAsset(request.asset.chain, request.asset.token, request.asset.mint);
  if (!found) {
    const display = request.asset.mint
      ? `${displayAssetId(request.asset.chain)}:${displayAssetId(request.asset.token)}:${displayAssetId(request.asset.mint)}`
      : `${displayAssetId(request.asset.chain)}:${displayAssetId(request.asset.token)}`;
    throw new Error(
      `Unknown asset in payment request: ${display}. ` +
        `Known assets: ${KNOWN_ASSETS.map(assetKey).join(', ')}`,
    );
  }
  return found;
}

const DECIMAL_RE = /^(\d+\.\d*|\d*\.\d+|\d+)$/;

/**
 * Parse a human amount string ("0.5", "1", "0.000001") into raw subunits (BigInt).
 * Uses integer math to avoid float precision issues.
 *
 * Throws on: empty, negative, zero, malformed, too many fractional digits, or
 * a value exceeding `Number.MAX_SAFE_INTEGER` (to keep downstream `Number(...)`
 * call-sites safe).
 */
export function parseAssetAmount(asset: Asset, human: string): bigint {
  const trimmed = human.trim();
  if (!trimmed) {
    throw new Error(`${asset.symbol} amount is empty`);
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`${asset.symbol} amount cannot be negative`);
  }
  if (!DECIMAL_RE.test(trimmed)) {
    throw new Error(
      `${asset.symbol} amount must be a non-negative decimal (e.g. "0.5", "1"); got "${human}"`,
    );
  }

  const dotPos = trimmed.indexOf('.');
  let wholePart: string;
  if (dotPos === -1) {
    wholePart = trimmed;
  } else if (dotPos === 0) {
    wholePart = '0';
  } else {
    wholePart = trimmed.slice(0, dotPos);
  }
  const fracPart = dotPos === -1 ? '' : trimmed.slice(dotPos + 1);

  if (fracPart.length > asset.decimals) {
    throw new Error(
      `${asset.symbol} amount has too many decimals (max ${asset.decimals}); got "${human}"`,
    );
  }

  const unit = 10n ** BigInt(asset.decimals);
  const whole = BigInt(wholePart);
  const frac = fracPart ? BigInt(fracPart.padEnd(asset.decimals, '0')) : 0n;
  const raw = whole * unit + frac;

  if (raw === 0n) {
    throw new Error(`${asset.symbol} amount must be positive; got "${human}"`);
  }
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${asset.symbol} amount exceeds safe range (max ${Number.MAX_SAFE_INTEGER} subunits)`,
    );
  }
  return raw;
}

// Cloned config keeps `Decimal.toString()` from switching to exponential notation
// for small fractional amounts (e.g. 1 lamport = 1e-9 SOL).
const FormatDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 50 });

/**
 * Format raw subunits back to `"<value> <SYMBOL>"`. Trailing zeros and a bare
 * trailing dot are stripped, so 0.01 USDC renders as `"0.01 USDC"` rather than
 * `"0.010000 USDC"`.
 */
export function formatAssetAmount(asset: Asset, raw: bigint): string {
  const value = new FormatDecimal(raw.toString()).div(new FormatDecimal(10).pow(asset.decimals));
  return `${value.toString()} ${asset.symbol}`;
}
