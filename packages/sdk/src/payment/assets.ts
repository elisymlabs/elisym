/**
 * Multi-asset / multi-chain payment model.
 *
 * `Asset` describes a currency a customer can spend: native coins (SOL, ETH, BTC)
 * or tokens (SPL, ERC-20). `assetKey` produces a stable string id for Map lookups.
 *
 * Today only `NATIVE_SOL` is in `KNOWN_ASSETS`. SPL (USDC) and other chains are
 * extended by adding entries to `KNOWN_ASSETS` and, where relevant, to the
 * MCP `DEFAULT_SESSION_LIMITS` catalogue.
 */

export type Chain = 'solana';

export interface Asset {
  chain: Chain;
  /** Lowercase token id: 'sol', 'usdc', 'btc', 'eth'. */
  token: string;
  /** SPL mint / ERC-20 contract. Undefined for a native coin. */
  mint?: string;
  /** Subunits per whole (9 SOL, 6 USDC, 8 BTC, 18 ETH). */
  decimals: number;
  /** Display symbol: 'SOL', 'USDC'. */
  symbol: string;
}

export const NATIVE_SOL: Asset = {
  chain: 'solana',
  token: 'sol',
  decimals: 9,
  symbol: 'SOL',
};

// When SPL-token support lands in the payment strategy, uncomment and add to KNOWN_ASSETS.
// export const USDC_SOLANA_DEVNET: Asset = {
//   chain: 'solana',
//   token: 'usdc',
//   mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
//   decimals: 6,
//   symbol: 'USDC',
// };

export const KNOWN_ASSETS: readonly Asset[] = [NATIVE_SOL];

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

/** Format raw subunits back to `"<whole>.<frac> <SYMBOL>"`. Keeps all `decimals` digits. */
export function formatAssetAmount(asset: Asset, raw: bigint): string {
  const sign = raw < 0n ? '-' : '';
  const abs = raw < 0n ? -raw : raw;
  const unit = 10n ** BigInt(asset.decimals);
  const whole = abs / unit;
  const frac = abs % unit;
  if (asset.decimals === 0) {
    return `${sign}${whole} ${asset.symbol}`;
  }
  return `${sign}${whole}.${frac.toString().padStart(asset.decimals, '0')} ${asset.symbol}`;
}
