/**
 * Multi-asset / multi-chain payment model.
 *
 * `Asset` describes a currency a customer can spend: native coins (SOL, ETH, BTC)
 * or tokens (SPL, ERC-20). `assetKey` produces a stable string id for Map lookups.
 *
 * `KNOWN_ASSETS` holds native SOL plus the SPL assets (USDC per network, LSM
 * on mainnet) and stays Solana-only: it is public, and consumers iterate it
 * with Solana tooling (`getNetworkStats` runs every mint through a base58
 * address parser). EVM coins live in `EVM_ASSETS`; `ALL_ASSETS` is both, and
 * is what the lookups search. A new asset goes into one of the two lists and,
 * always, into the MCP `DEFAULT_SESSION_LIMITS` catalogue - an asset without a
 * limits entry is spend-uncapped in MCP sessions.
 */

import Decimal from 'decimal.js-light';
import type { Network } from '../types';
import type { ChainSlug } from './chains';

export type Chain = ChainSlug;

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
  /** SPL mint, or the token contract (lowercase `0x` hex) on an EVM chain. Undefined for a native coin. */
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
  /**
   * EIP-3009 coins only: the EIP-712 domain `name` and `version` the token
   * signs under. The name differs per chain (`USDC` on Sepolia and Base
   * Sepolia, `USD Coin` elsewhere): never assume one.
   */
  eip712?: { name: string; version: string };
  /**
   * EIP-3009 coins only: the FiatToken implementation pinned behind the proxy
   * (lowercase). A proxy that points elsewhere was upgraded, and stops payments
   * on that chain until the registry is checked again.
   */
  implementation?: string;
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
 * Bridged USDC on Tempo - mainnet only. The token id is dot-free (`usdce`)
 * because asset ids are `[a-z0-9-]`; the symbol keeps the dot.
 */
export const USDCE_TEMPO_MAINNET: Asset = {
  chain: 'tempo',
  token: 'usdce',
  mint: '0x20c000000000000000000000b9537d11c60e8b50',
  decimals: 6,
  symbol: 'USDC.e',
};

/** pathUSD lives at the same address on Tempo mainnet and on Moderato, so one key names both. */
export const PATHUSD_TEMPO: Asset = {
  chain: 'tempo',
  token: 'pathusd',
  mint: '0x20c0000000000000000000000000000000000000',
  decimals: 6,
  symbol: 'pathUSD',
};

/**
 * Circle USDC (FiatToken v2.2) on the `eip3009` chains. Every value was read on
 * chain (facts file beside the plan); the domain each one reproduces was checked
 * against the contract's own `DOMAIN_SEPARATOR()`.
 */
export const USDC_ETHEREUM_MAINNET: Asset = {
  chain: 'ethereum',
  token: 'usdc',
  mint: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  decimals: 6,
  symbol: 'USDC',
  eip712: { name: 'USD Coin', version: '2' },
  implementation: '0x43506849d7c04f9138d1a2050bbf3a0c054402dd',
};

/** Sepolia. */
export const USDC_ETHEREUM_DEVNET: Asset = {
  chain: 'ethereum',
  token: 'usdc',
  mint: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  decimals: 6,
  symbol: 'USDC',
  eip712: { name: 'USDC', version: '2' },
  implementation: '0xda317c1d3e835dd5f1be459006471acaa1289068',
};

export const USDC_ARBITRUM_MAINNET: Asset = {
  chain: 'arbitrum',
  token: 'usdc',
  mint: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  decimals: 6,
  symbol: 'USDC',
  eip712: { name: 'USD Coin', version: '2' },
  implementation: '0x86e721b43d4ecfa71119dd38c0f938a75fdb57b3',
};

/** Arbitrum Sepolia. */
export const USDC_ARBITRUM_DEVNET: Asset = {
  chain: 'arbitrum',
  token: 'usdc',
  mint: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  decimals: 6,
  symbol: 'USDC',
  eip712: { name: 'USD Coin', version: '2' },
  implementation: '0xfbb8ee011af0f15ee171e79c0688d05a58f7f566',
};

export const USDC_BASE_MAINNET: Asset = {
  chain: 'base',
  token: 'usdc',
  mint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6,
  symbol: 'USDC',
  eip712: { name: 'USD Coin', version: '2' },
  implementation: '0x2ce6311ddae708829bc0784c967b7d77d19fd779',
};

/** Base Sepolia. */
export const USDC_BASE_DEVNET: Asset = {
  chain: 'base',
  token: 'usdc',
  mint: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  decimals: 6,
  symbol: 'USDC',
  eip712: { name: 'USDC', version: '2' },
  implementation: '0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5',
};

export const EVM_ASSETS: readonly Asset[] = [
  USDCE_TEMPO_MAINNET,
  PATHUSD_TEMPO,
  USDC_ETHEREUM_MAINNET,
  USDC_ETHEREUM_DEVNET,
  USDC_ARBITRUM_MAINNET,
  USDC_ARBITRUM_DEVNET,
  USDC_BASE_MAINNET,
  USDC_BASE_DEVNET,
];

export const ALL_ASSETS: readonly Asset[] = [...KNOWN_ASSETS, ...EVM_ASSETS];

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

/**
 * The assets that exist on a chain in an environment, the default stablecoin
 * first among the stablecoins. Tempo has no native coin: gas is paid in a
 * stablecoin too.
 */
export function assetsFor(chain: Chain, network: Network): Asset[] {
  switch (chain) {
    case 'solana':
      return [NATIVE_SOL, ...splAssetsForNetwork(network)];
    case 'tempo':
      return network === 'mainnet' ? [USDCE_TEMPO_MAINNET, PATHUSD_TEMPO] : [PATHUSD_TEMPO];
    case 'ethereum':
    case 'arbitrum':
    case 'base':
      return [defaultStablecoin(chain, network)];
    default:
      return assertNever(chain);
  }
}

/** The stablecoin a price is quoted in when a skill names a chain and no token. */
export function defaultStablecoin(chain: Chain, network: Network): Asset {
  switch (chain) {
    case 'solana':
      return resolveUsdcAsset(network);
    case 'tempo':
      return network === 'mainnet' ? USDCE_TEMPO_MAINNET : PATHUSD_TEMPO;
    case 'ethereum':
      return network === 'mainnet' ? USDC_ETHEREUM_MAINNET : USDC_ETHEREUM_DEVNET;
    case 'arbitrum':
      return network === 'mainnet' ? USDC_ARBITRUM_MAINNET : USDC_ARBITRUM_DEVNET;
    case 'base':
      return network === 'mainnet' ? USDC_BASE_MAINNET : USDC_BASE_DEVNET;
    default:
      return assertNever(chain);
  }
}

/** A chain added to `ChainSlug` without its coins fails to COMPILE here, not at run time. */
function assertNever(chain: never): never {
  throw new Error(`No assets are registered for chain ${String(chain)}`);
}

/** Stable Map key for `Asset`. Same shape regardless of Asset identity. */
export function assetKey(a: Pick<Asset, 'chain' | 'token' | 'mint'>): string {
  return a.mint ? `${a.chain}:${a.token}:${a.mint}` : `${a.chain}:${a.token}`;
}

/** Find a known asset by (chain, token, mint). Returns undefined if unknown. */
export function resolveKnownAsset(chain: string, token: string, mint?: string): Asset | undefined {
  const key = mint ? `${chain}:${token}:${mint}` : `${chain}:${token}`;
  return ALL_ASSETS.find((asset) => assetKey(asset) === key);
}

/** Reverse lookup: given an assetKey string, return the known asset or undefined. */
export function assetByKey(key: string): Asset | undefined {
  return ALL_ASSETS.find((asset) => assetKey(asset) === key);
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
function displayAssetId(value: unknown): string {
  return String(value)
    .replace(/[^a-zA-Z0-9:_-]/g, '')
    .slice(0, 64);
}

export function resolveAssetFromPaymentRequest(request: {
  asset?: { chain: string; token: string; mint?: string };
}): Asset {
  if (!request.asset) {
    return NATIVE_SOL;
  }
  // A v1 request settles on Solana, whatever it names: it is looked up in
  // `KNOWN_ASSETS` and not in `ALL_ASSETS`, so one naming an EVM coin stays
  // "unknown" instead of handing an `0x` contract to the Solana payment code.
  // This runs BEFORE any schema, on a provider's raw JSON. A v2 request carries
  // `asset` as a CAIP-19 STRING; read as the v1 object it has no `chain` at all,
  // and the released builds answer that with a TypeError out of `displayAssetId`.
  // It failed closed, but by accident: refuse it by name instead.
  // The KEY is built exactly as it always was - a template string over whatever
  // the provider sent - so the set of requests this accepts is unchanged. Only the
  // error text is made safe for a value that is not a string.
  const { chain, token, mint } = request.asset;
  const requestedKey = mint ? `${chain}:${token}:${mint}` : `${chain}:${token}`;
  const found = KNOWN_ASSETS.find((asset) => assetKey(asset) === requestedKey);
  if (!found) {
    const display = mint
      ? `${displayAssetId(chain)}:${displayAssetId(token)}:${displayAssetId(mint)}`
      : `${displayAssetId(chain)}:${displayAssetId(token)}`;
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
