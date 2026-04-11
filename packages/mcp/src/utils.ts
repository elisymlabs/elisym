/**
 * Shared utility functions for the MCP server.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SolanaPaymentStrategy, LIMITS } from '@elisym/sdk';

/** Mirrors `@solana/web3.js`'s LAMPORTS_PER_SOL as a BigInt for integer math. */
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Minimum reserve left in the wallet when withdrawing "all" to cover the tx fee. */
const TX_FEE_RESERVE = 5_000n;

/**
 * single source of truth for the package version. The dispatcher and the CLI
 * both surface this string, so we read it from `package.json` at module load instead of
 * hardcoding a literal in two places that can drift apart.
 */
function readPackageVersion(): string {
  try {
    // dist/index.js -> ../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export const PACKAGE_VERSION: string = readPackageVersion();

/** Format lamports as "X.XXXXXXXXX SOL" using integer math only. */
export function formatSol(lamports: bigint): string {
  return `${formatSolNumeric(lamports)} SOL`;
}

/** Format lamports as "X.XXXXXXXXX" string (no suffix). */
export function formatSolNumeric(lamports: bigint): string {
  const sign = lamports < 0n ? '-' : '';
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = abs % LAMPORTS_PER_SOL;
  return `${sign}${whole}.${frac.toString().padStart(9, '0')}`;
}

/** Format lamports as "X.XXXX SOL" (4 decimal places, truncated). */
export function formatSolShort(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL) / 100_000n;
  return `${whole}.${frac.toString().padStart(4, '0')} SOL`;
}

/**
 * Parse a SOL amount string (e.g. "0.5", "1.0") to lamports. Integer math only.
 *
 * reject non-decimal inputs (scientific notation, hex, `+`, commas) with a clean
 * message instead of letting BigInt throw a cryptic error.
 */
export function parseSolToLamports(s: string): bigint {
  const trimmed = s.trim();
  if (!trimmed) {
    throw new Error('amount is empty');
  }
  if (trimmed.startsWith('-')) {
    throw new Error('amount cannot be negative');
  }
  // Accept "1", "0.5", ".5", "1." - reject "", ".", "+5", "1e9", "0x5", "1,000".
  if (!/^(\d+\.\d*|\d*\.\d+|\d+)$/.test(trimmed)) {
    throw new Error(
      'amount must be a non-negative decimal number (e.g. "0.5", "1", "0.000000001")',
    );
  }

  const dotPos = trimmed.indexOf('.');
  if (dotPos === -1) {
    const whole = BigInt(trimmed);
    return whole * LAMPORTS_PER_SOL;
  }

  const wholePart = dotPos === 0 ? 0n : BigInt(trimmed.slice(0, dotPos));
  const fracStr = trimmed.slice(dotPos + 1);
  if (fracStr.length > 9) {
    throw new Error('too many decimal places (max 9)');
  }

  const padded = fracStr.padEnd(9, '0');
  const frac = BigInt(padded);

  return wholePart * LAMPORTS_PER_SOL + frac;
}

/** Validate and resolve a withdrawal amount. "all" withdraws full balance minus tx fee. */
export function validateWithdrawAmount(amountSol: string, balance: bigint): bigint {
  let lamports: bigint;
  if (amountSol.trim().toLowerCase() === 'all') {
    lamports = balance > TX_FEE_RESERVE ? balance - TX_FEE_RESERVE : 0n;
  } else {
    lamports = parseSolToLamports(amountSol);
  }

  if (lamports === 0n) {
    throw new Error('Nothing to withdraw (balance too low or zero amount).');
  }

  if (lamports + TX_FEE_RESERVE > balance) {
    throw new Error(
      `Insufficient balance. Have: ${formatSol(balance)}, need: ${formatSol(lamports)} + fee`,
    );
  }

  return lamports;
}

/** UTF-8 safe string truncation. */
export function truncateStr(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max) + '...';
}

/** Validate that a string field doesn't exceed max bytes. */
export function checkLen(field: string, value: string, max: number): void {
  if (new TextEncoder().encode(value).length > max) {
    throw new Error(`${field} too long (max ${max} bytes)`);
  }
}

// Input length limits.
//
// limits shared with the SDK are re-exported from `@elisym/sdk`'s `LIMITS` so a
// future bump in one place updates both layers. Previously MCP had its own literals
// (e.g. `MAX_CAPABILITIES = 50`) which were larger than the SDK's (`20`); inputs in
// the gap passed MCP validation and then failed inside the SDK with a confusing
// low-level error.

export const MAX_INPUT_LEN = LIMITS.MAX_INPUT_LENGTH;
export const MAX_CAPABILITIES = LIMITS.MAX_CAPABILITIES;
export const MAX_TIMEOUT_SECS = LIMITS.MAX_TIMEOUT_SECS;

// MCP-specific limits that have no SDK counterpart.
export const MAX_NPUB_LEN = 128;
export const MAX_EVENT_ID_LEN = 128;
export const MAX_PAYMENT_REQ_LEN = 10_000;
/** Solana base58 addresses are 32-44 chars; cap comfortably. */
export const MAX_SOLANA_ADDR_LEN = 64;

/**
 * lazy singleton so importing a tool module doesn't construct a payment strategy
 * until a tool actually needs one (test imports, etc.). Shared across wallet and customer
 * tools so there is only one instance.
 */
let _paymentStrategy: SolanaPaymentStrategy | null = null;
export function payment(): SolanaPaymentStrategy {
  _paymentStrategy ??= new SolanaPaymentStrategy();
  return _paymentStrategy;
}
