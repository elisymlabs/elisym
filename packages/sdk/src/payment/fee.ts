import Decimal from 'decimal.js-light';

const BPS_DENOMINATOR = 10_000;

/** Assert that a value is a non-negative integer (lamports). */
export function assertLamports(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${field}: ${value}. Must be a non-negative integer.`);
  }
}

/**
 * Calculate the protocol fee using basis-point math (no floats).
 * Returns ceil(amount * feeBps / 10000).
 *
 * The caller passes the current fee (in basis points). Phase 2 of the
 * Solana Kit migration removes the implicit dependency on PROTOCOL_FEE_BPS
 * so callers can supply on-chain or test values.
 */
export function calculateProtocolFee(amount: number, feeBps: number): number {
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error(`Invalid feeBps: ${feeBps}. Must be a non-negative integer.`);
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Invalid fee amount: ${amount}. Must be a non-negative integer.`);
  }
  if (amount === 0 || feeBps === 0) {
    return 0;
  }
  return new Decimal(amount)
    .mul(feeBps)
    .div(BPS_DENOMINATOR)
    .toDecimalPlaces(0, Decimal.ROUND_CEIL)
    .toNumber();
}

/** Validate payment request timestamps. Returns error message or null if valid. */
export function validateExpiry(createdAt: number, expirySecs: number): string | null {
  if (!Number.isInteger(createdAt) || createdAt <= 0) {
    return 'Invalid or missing created_at in payment request.';
  }
  if (!Number.isInteger(expirySecs) || expirySecs <= 0) {
    return 'Invalid or missing expiry_secs in payment request.';
  }
  const now = Math.floor(Date.now() / 1000);
  if (createdAt > now + 120) {
    return `Payment request created_at is in the future (${createdAt} vs now ${now}). Possible manipulation.`;
  }
  if (now - createdAt > expirySecs) {
    return `Payment request expired (created ${createdAt}, expiry ${expirySecs}s).`;
  }
  return null;
}

/** Assert that payment request timestamps are valid and not expired. Throws on failure. */
export function assertExpiry(createdAt: number, expirySecs: number): void {
  const error = validateExpiry(createdAt, expirySecs);
  if (error) {
    throw new Error(error);
  }
}
