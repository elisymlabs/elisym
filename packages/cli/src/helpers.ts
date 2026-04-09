/**
 * Shared CLI helpers - RPC URLs, SOL formatting, price validation.
 */
import { calculateProtocolFee } from '@elisym/sdk';

// --- Constants ---

export const RENT_EXEMPT_MINIMUM = 890_880; // lamports
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_CONCURRENT_JOBS = 10;
export const RECOVERY_MAX_RETRIES = 5;
export const RECOVERY_INTERVAL_SECS = 60;

// --- Solana RPC ---

export function getRpcUrl(network: string): string {
  const envUrl = process.env.SOLANA_RPC_URL;
  if (envUrl) {
    return envUrl;
  }
  switch (network) {
    case 'mainnet':
      return 'https://api.mainnet-beta.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    default:
      return 'https://api.devnet.solana.com';
  }
}

// --- SOL formatting (number only, no " SOL" suffix - use SDK's formatSol for display) ---

export function formatLamports(lamports: number): string {
  const whole = Math.floor(lamports / 1_000_000_000);
  const frac = lamports % 1_000_000_000;
  return `${whole}.${String(frac).padStart(9, '0')}`;
}

// --- SOL parsing ---

export function parseSolToLamports(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) {
    return null;
  }

  const dotPos = trimmed.indexOf('.');
  if (dotPos === -1) {
    const whole = parseInt(trimmed, 10);
    if (isNaN(whole) || whole < 0) {
      return null;
    }
    return whole * 1_000_000_000;
  }

  const wholePart = dotPos === 0 ? 0 : parseInt(trimmed.slice(0, dotPos), 10);
  if (isNaN(wholePart)) {
    return null;
  }

  const fracStr = trimmed.slice(dotPos + 1);
  if (fracStr.length === 0 || fracStr.length > 9) {
    return null;
  }

  const padded = fracStr.padEnd(9, '0');
  const frac = parseInt(padded, 10);
  if (isNaN(frac)) {
    return null;
  }

  return wholePart * 1_000_000_000 + frac;
}

// --- Price validation ---

export function validateJobPrice(lamports: number, accountFunded: boolean): string | null {
  if (lamports === 0) {
    return null;
  }
  const fee = calculateProtocolFee(lamports);
  const providerNet = lamports - fee;
  if (!accountFunded && providerNet < RENT_EXEMPT_MINIMUM) {
    return (
      `Price too low. After 3% fee, provider receives ${providerNet} lamports, ` +
      `which is below rent-exempt minimum (${RENT_EXEMPT_MINIMUM}). Increase price or fund wallet first.`
    );
  }
  return null;
}
