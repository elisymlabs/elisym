import type { CapabilityCard } from '@elisym/sdk';
import { compactZeros, formatDecimal } from '~/lib/formatPrice';

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

export type BalanceCheckResult = { ok: true } | { ok: false; tooltip: string };

interface BalanceCheckArgs {
  card: CapabilityCard;
  solLamports: bigint | null;
  usdcRaw: bigint | null;
  gasLamports: number;
}

function isUsdcCard(card: CapabilityCard): boolean {
  const token = card.payment?.token;
  return typeof token === 'string' && token.toLowerCase() === 'usdc';
}

function formatSolDeficit(deficit: bigint): string {
  return compactZeros(formatDecimal(Number(deficit), SOL_DECIMALS));
}

function formatUsdcDeficit(deficit: bigint): string {
  return compactZeros(formatDecimal(Number(deficit), USDC_DECIMALS));
}

/**
 * Two-tier affordability check for the connected wallet:
 *
 *   Tier 1 - payment token covers the product price.
 *   Tier 2 - SOL covers the network fee (gas + worst-case ATA rent for USDC).
 *
 * Tiers are sequential: Tier 1 must pass before Tier 2 is shown. This keeps
 * the tooltip focused on the closest blocker.
 *
 * For SOL-priced cards, both tiers draw from the same balance, so Tier 2
 * effectively asserts `solLamports - price >= gas` (equivalently
 * `solLamports >= price + gas`).
 *
 * Returns `{ ok: true }` while balances are still loading so the button does
 * not flicker disabled on first render. Free cards and the no-wallet case are
 * handled by the caller's existing flow and should never reach this function.
 */
export function checkBuyAffordability({
  card,
  solLamports,
  usdcRaw,
  gasLamports,
}: BalanceCheckArgs): BalanceCheckResult {
  const price = BigInt(card.payment?.job_price ?? 0);
  const gas = BigInt(gasLamports);
  const usdc = isUsdcCard(card);

  if (solLamports === null) {
    return { ok: true };
  }
  if (usdc && usdcRaw === null) {
    return { ok: true };
  }

  // Tier 1: payment token covers the price.
  if (usdc) {
    if (usdcRaw !== null && usdcRaw < price) {
      const deficit = formatUsdcDeficit(price - usdcRaw);
      return {
        ok: false,
        tooltip: `Need ${deficit} USDC more to buy.`,
      };
    }
  } else {
    if (solLamports < price) {
      const deficit = formatSolDeficit(price - solLamports);
      return {
        ok: false,
        tooltip: `Need ${deficit} SOL more to buy.`,
      };
    }
  }

  // Tier 2: SOL covers the network fee. For SOL cards we check what's left
  // after the price would be deducted, so balance must satisfy
  // `(balance - price) >= gas` (i.e. `balance >= price + gas`).
  const solAfterPrice = usdc ? solLamports : solLamports - price;
  if (solAfterPrice < gas) {
    const deficit = formatSolDeficit(gas - solAfterPrice);
    return {
      ok: false,
      tooltip: `Need ${deficit} SOL more for the network fee.`,
    };
  }

  return { ok: true };
}

interface SelfPaymentCheckArgs {
  card: CapabilityCard;
  buyerWallet: string | null;
}

/**
 * Blocks paying yourself: connected Solana wallet equals the card's payment
 * address. Independent of the Nostr `isOwn` check (different identity, same
 * wallet is still a no-op transfer that burns gas + protocol fee).
 */
export function checkSelfPayment({ card, buyerWallet }: SelfPaymentCheckArgs): BalanceCheckResult {
  const price = card.payment?.job_price ?? 0;
  if (price === 0) {
    return { ok: true };
  }
  if (!buyerWallet) {
    return { ok: true };
  }
  if (card.payment?.chain !== 'solana') {
    return { ok: true };
  }
  const providerAddress = card.payment.address;
  if (!providerAddress || buyerWallet !== providerAddress) {
    return { ok: true };
  }
  return {
    ok: false,
    tooltip: "You can't buy from yourself - this capability pays the wallet you're connected with.",
  };
}
