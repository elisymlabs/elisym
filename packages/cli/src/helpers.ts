/**
 * Shared CLI helpers - RPC URLs, SOL formatting, price validation.
 */
import {
  type Asset,
  type Network,
  calculateProtocolFee,
  formatAssetAmount,
  resolveUsdcAsset,
} from '@elisym/sdk';
import { type Rpc, type SolanaRpcApi, address } from '@solana/kit';

// --- Constants ---

export const RENT_EXEMPT_MINIMUM = 890_880; // lamports
export const MAX_CONCURRENT_JOBS = 10;
export const RECOVERY_MAX_RETRIES = 5;
export const RECOVERY_INTERVAL_SECS = 60;
export const WATCHDOG_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const WATCHDOG_PROBE_TIMEOUT_MS = 10_000;
export const WATCHDOG_SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const WATCHDOG_SELF_PING_TIMEOUT_MS = 15_000;
/**
 * If a watchdog tick fires after a wall-clock gap larger than the smaller of
 * its two intervals multiplied by this factor, the gap is treated as host
 * suspension (macOS sleep, hibernation, container pause) rather than normal
 * scheduling jitter. Both `setInterval` callbacks freeze during OS sleep and
 * fire late on resume; the tick that detects the gap forces an immediate pool
 * reset instead of running the regular probe/self-ping (which would race
 * against still-half-dead WebSocket state).
 */
export const WATCHDOG_SLEEP_DETECT_MULTIPLIER = 2;

// --- Solana RPC ---

export function getRpcUrl(network: Network): string {
  // CLI-only override (D9): `start <agent>` is one agent, one network per
  // process, so a process-wide env override is unambiguous here.
  const envUrl = process.env.SOLANA_RPC_URL;
  if (envUrl) {
    return envUrl;
  }
  return network === 'mainnet'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com';
}

// --- SPL balances ---

/**
 * Sum the agent's token-account balances for an SPL asset (raw subunits) on
 * the connected Solana RPC. Uses a mint-filtered `getTokenAccountsByOwner`,
 * which is token-program-agnostic (covers Token-2022 mints like LSM) and sums
 * non-ATA accounts too. An asset with no mint, or an owner with no token
 * account, is 0n; `null` means the balance could not be read. Callers render
 * that as unknown rather than failing the banner - printing "0 LSM" for a
 * wallet that holds a fortune is worse than saying the read failed.
 */
export async function fetchSplBalance(
  rpc: Rpc<SolanaRpcApi>,
  owner: ReturnType<typeof address>,
  asset: Asset,
): Promise<bigint | null> {
  const mint = asset.mint;
  if (!mint) {
    return 0n;
  }
  try {
    const response = await rpc
      .getTokenAccountsByOwner(
        owner,
        { mint: address(mint) },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      )
      .send();
    let total = 0n;
    for (const entry of response.value) {
      const parsed = entry.account.data as
        | { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
        | undefined;
      const raw = parsed?.parsed?.info?.tokenAmount?.amount;
      if (typeof raw === 'string') {
        total += BigInt(raw);
      }
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Balance value for a banner - the bare amount, no symbol prefix (callers
 * supply their own label). An unreadable balance never renders as zero.
 */
export function formatSplBalanceValue(asset: Asset, balance: bigint | null | undefined): string {
  return balance === undefined || balance === null
    ? 'unavailable (balance read failed)'
    : formatAssetAmount(asset, balance);
}

/**
 * The network's canonical-USDC balance via `fetchSplBalance` - kept for the
 * x402 surfaces (driver float check, `x402 add` preflight, settle-check).
 * `null` when the balance could not be read: the float checks refuse on an
 * unknown balance rather than treating it as empty or as sufficient.
 */
export async function fetchUsdcBalance(
  rpc: Rpc<SolanaRpcApi>,
  owner: ReturnType<typeof address>,
  network: Network,
): Promise<bigint | null> {
  return fetchSplBalance(rpc, owner, resolveUsdcAsset(network));
}

// --- Price validation ---

export function validateJobPrice(
  lamports: number,
  accountFunded: boolean,
  feeBps: number,
): string | null {
  if (lamports === 0) {
    return null;
  }
  const fee = calculateProtocolFee(lamports, feeBps);
  const providerNet = lamports - fee;
  if (!accountFunded && providerNet < RENT_EXEMPT_MINIMUM) {
    const pct = (feeBps / 100).toFixed(2);
    return (
      `Price too low. After ${pct}% fee, provider receives ${providerNet} lamports, ` +
      `which is below rent-exempt minimum (${RENT_EXEMPT_MINIMUM}). Increase price or fund wallet first.`
    );
  }
  return null;
}
