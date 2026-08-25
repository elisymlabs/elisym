/**
 * Single source of truth for "is this upstream payment requirement one we
 * are willing to pay". Used from BOTH enforcement points - the pre-payment
 * preflight probe and the `PaymentPolicy` applied inside the x402 client at
 * signing time - so the two can never drift apart.
 */
import { resolveUsdcAsset } from '@elisym/sdk';
import type { Network } from '@elisym/sdk';
import type { PaymentPolicy, PaymentRequirements } from '@x402/fetch';
import { x402SolanaNetworkIds } from './constants.js';

export interface RequirementRule {
  /** Ceiling on the upstream quote in USDC subunits (from `x402_max_upstream`). */
  maxUpstreamSubunits: bigint;
  /**
   * The agent's Solana network - drives both the accepted x402 network-id set
   * and the USDC mint comparison. A cross-network requirement is never
   * acceptable, whatever its price.
   */
  network: Network;
}

/**
 * Amount of a requirement across protocol versions: v2 uses `amount`, v1
 * uses `maxAmountRequired`. Returns null for anything that is not a plain
 * non-negative integer string - fail closed, never sign what we can't parse.
 */
export function requirementAmount(requirement: PaymentRequirements): bigint | null {
  const v1Amount = (requirement as { maxAmountRequired?: unknown }).maxAmountRequired;
  const raw = requirement.amount ?? v1Amount;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    return null;
  }
  return BigInt(raw);
}

export function isAcceptableRequirement(
  requirement: PaymentRequirements,
  rule: RequirementRule,
): boolean {
  if (requirement.scheme !== 'exact') {
    return false;
  }
  const network = requirement.network as string;
  const acceptedIds = x402SolanaNetworkIds(rule.network);
  if (network !== acceptedIds.caip2 && network !== acceptedIds.v1) {
    return false;
  }
  const usdcMint = resolveUsdcAsset(rule.network).mint;
  if (usdcMint === undefined || requirement.asset !== usdcMint) {
    return false;
  }
  const amount = requirementAmount(requirement);
  if (amount === null) {
    return false;
  }
  return amount <= rule.maxUpstreamSubunits;
}

export function selectAcceptableRequirement(
  accepts: PaymentRequirements[],
  rule: RequirementRule,
): PaymentRequirements | undefined {
  return accepts.find((requirement) => isAcceptableRequirement(requirement, rule));
}

/**
 * The MAXIMUM amount among acceptable requirements (null if none). The client's
 * policy/selector at signing time may pick any acceptable requirement, not the
 * first one preflight looked at; checking margin and balance against the worst
 * acceptable quote guarantees the gate holds whichever one signing chooses.
 */
export function maxAcceptableQuote(
  accepts: PaymentRequirements[],
  rule: RequirementRule,
): bigint | null {
  let worst: bigint | null = null;
  for (const requirement of accepts) {
    if (!isAcceptableRequirement(requirement, rule)) {
      continue;
    }
    const amount = requirementAmount(requirement);
    if (amount === null) {
      continue;
    }
    if (worst === null || amount > worst) {
      worst = amount;
    }
  }
  return worst;
}

/**
 * Payment policy enforced at signing time inside the x402 client. Filtering
 * everything out makes the client throw ("All payment requirements were
 * filtered out...") BEFORE any `PAYMENT-SIGNATURE` is created - this is what
 * closes the TOCTOU window between the preflight quote and the live call.
 */
export function buildRequirementsPolicy(rule: RequirementRule): PaymentPolicy {
  return function filterAcceptableRequirements(_x402Version, paymentRequirements) {
    return paymentRequirements.filter((requirement) => isAcceptableRequirement(requirement, rule));
  };
}
