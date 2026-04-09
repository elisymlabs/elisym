import Decimal from 'decimal.js-light';
import { PROTOCOL_FEE_BPS } from '../constants';

/** Assert that a value is a non-negative integer (lamports). */
export function assertLamports(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${field}: ${value}. Must be a non-negative integer.`);
  }
}

/**
 * Calculate protocol fee using Decimal basis-point math (no floats).
 * Returns ceil(amount * PROTOCOL_FEE_BPS / 10000).
 * Safe for amounts up to Number.MAX_SAFE_INTEGER - Decimal handles intermediate values.
 */
export function calculateProtocolFee(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Invalid fee amount: ${amount}. Must be a non-negative integer.`);
  }
  if (amount === 0) {
    return 0;
  }
  return new Decimal(amount)
    .mul(PROTOCOL_FEE_BPS)
    .div(10000)
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
