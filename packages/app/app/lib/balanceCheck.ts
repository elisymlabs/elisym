import { assetKey, type Asset, type CapabilityCard, type Network } from '@elisym/sdk';
import { resolvePaymentAsset } from './cardAsset';
import { compactZeros, formatDecimal } from './formatPrice';

const SOL_DECIMALS = 9;

export type BalanceCheckResult = { ok: true } | { ok: false; tooltip: string };

interface BalanceCheckArgs {
  card: CapabilityCard;
  solLamports: bigint | null;
  /** Raw SPL balances keyed by `assetKey`, as returned by `useWalletBalances`. */
  splRaw: Record<string, bigint | null>;
  gasLamports: number;
  /** The page's cluster - `splRaw` only carries assets that exist on it. */
  network: Network;
}

function formatSolDeficit(deficit: bigint): string {
  return compactZeros(formatDecimal(Number(deficit), SOL_DECIMALS));
}

function formatAssetDeficit(deficit: bigint, asset: Asset): string {
  return compactZeros(formatDecimal(Number(deficit), asset.decimals));
}

/**
 * Two-tier affordability check for the connected wallet:
 *
 *   Tier 1 - payment token covers the product price.
 *   Tier 2 - SOL covers the network fee (gas + worst-case ATA rent for SPL).
 *
 * Tiers are ordered: Tier 1 must not block before Tier 2 is considered, so the
 * tooltip names the closest blocker.
 *
 * For SOL-priced cards, both tiers draw from the same balance, so Tier 2
 * effectively asserts `solLamports - price >= gas` (equivalently
 * `solLamports >= price + gas`).
 *
 * A balance of `null` is unknown, never zero - so the button does not flicker
 * disabled on first render, and a read that failed can never be mistaken for
 * an empty wallet. An unknown PAYMENT balance abstains from the whole check;
 * an unknown SOL balance abstains only from the fee tier, leaving a decisive
 * token verdict intact. Free cards and the no-wallet case are handled by the
 * caller's existing flow and should never reach this function.
 */
export function checkBuyAffordability({
  card,
  solLamports,
  splRaw,
  gasLamports,
  network,
}: BalanceCheckArgs): BalanceCheckResult {
  const price = BigInt(card.payment?.job_price ?? 0);
  const gas = BigInt(gasLamports);
  const asset = resolvePaymentAsset(card.payment, network);
  if (asset === null) {
    // Asset this cluster cannot pay: abstain rather than block on
    // uninterpretable math. This includes a hostile devnet-tagged card
    // claiming a mainnet-only asset - no autonomous spend happens here, and
    // the wallet simulation is the final arbiter of what actually gets signed.
    return { ok: true };
  }
  const splAsset = asset.mint !== undefined;
  const splBalance = splAsset ? (splRaw[assetKey(asset)] ?? null) : null;

  // An unknown PAYMENT balance abstains from the whole check, not just Tier 1.
  // Tier 2 alone would decide on `gasLamports`, which `useSolGasFeeEstimate`
  // deliberately inflates to a worst case of two ATA creations - usually
  // no-ops - so a wallet holding the token and enough real SOL would be
  // refused on a fee it will never pay. A missed block costs a wallet
  // rejection; a false one costs a sale.
  if (splAsset && splBalance === null) {
    return { ok: true };
  }

  // Beyond that each tier abstains on its OWN missing input and the other
  // still runs: an unreadable SOL balance must not throw away a decisive token
  // reading, which is routine now that the click-time read times out per
  // asset.
  if (splAsset) {
    if (splBalance !== null && splBalance < price) {
      const deficit = formatAssetDeficit(price - splBalance, asset);
      return {
        ok: false,
        tooltip: `Need ${deficit} ${asset.symbol} more to buy.`,
      };
    }
  } else {
    if (solLamports === null) {
      return { ok: true };
    }
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
  if (solLamports === null) {
    return { ok: true };
  }
  const solAfterPrice = splAsset ? solLamports : solLamports - price;
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
