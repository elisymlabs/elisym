/**
 * The protocol fee over `bigint` subunits - the twin of `calculateProtocolFee`,
 * which takes a `number` and stays what the Solana rail uses. Same rule:
 * `ceil(amount * feeBps / 10000)`, integer math only.
 */

const BPS_DENOMINATOR = 10_000n;

export function calculateProtocolFeeSubunits(amount: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error(`Invalid feeBps: ${feeBps}. Must be a non-negative integer.`);
  }
  if (amount < 0n) {
    throw new Error(`Invalid fee amount: ${amount}. Must be non-negative.`);
  }
  if (amount === 0n || feeBps === 0) {
    return 0n;
  }
  const numerator = amount * BigInt(feeBps);
  const quotient = numerator / BPS_DENOMINATOR;
  return numerator % BPS_DENOMINATOR === 0n ? quotient : quotient + 1n;
}
