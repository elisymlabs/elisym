import {
  assetKey,
  resolveUsdcAsset,
  type CapabilityCard,
  type DelegationStatus,
} from '@elisym/sdk';
import { resolvePaymentAsset } from './cardAsset';
import { SOLANA_CLUSTER } from './cluster';

type DelegationCard = Pick<CapabilityCard, 'payment' | 'delegation'>;

/**
 * Which action a send surface offers for a card:
 *
 * - `'use'` - the connected wallet holds an active allowance to the card's
 *   delegate key covering the price: the send spends it.
 * - `'delegate'` - no covering allowance (none yet, revoked, delegated to a
 *   different key, or cap/balance below the price): the action routes to the
 *   Delegation tab instead of sending.
 * - `'loading'` - the allowance read has not resolved yet.
 * - `'wallet-unsupported'` - the wallet lacks `signMessage`, so it cannot
 *   authorize a delegated job.
 * - `'check-failed'` - the latest allowance read failed after retries, even
 *   when an earlier read succeeded.
 * - `'per-job'` - the card is not on the delegated rail, or no wallet is
 *   connected (the surface shows Connect): the regular per-job flow.
 *
 * With a wallet connected, a delegated-rail card never resolves to
 * `'per-job'` - the held modes block the send instead. Presentation-layer
 * only: `buy()` re-verifies the allowance on-chain at click time and enforces
 * the same rule.
 */
export type DelegatedBuyMode =
  | 'per-job'
  | 'loading'
  | 'use'
  | 'delegate'
  | 'wallet-unsupported'
  | 'check-failed';

export const DELEGATED_WALLET_UNSUPPORTED_MESSAGE =
  "Your wallet can't sign the delegated-payment authorization - connect a wallet that supports message signing.";

/**
 * Whether a card settles through the delegated rail: paid, advertising a
 * delegation, and priced in canonical USDC on this cluster. The web app never
 * settles such a card per job - a missing, lapsed or unreadable allowance
 * blocks the send instead of charging the full price.
 *
 * Asset IDENTITY, not the card's `token` string: the pull targets the
 * canonical USDC ATA whatever the card claims, and `job_price` on any other
 * asset is in different subunits, so a card that merely calls itself usdc
 * while naming another mint must not qualify (`resolvePaymentAsset` returns
 * null for any non-canonical mint). USDC-only mirrors the provider-side load
 * guard and the MCP gate in `submit_delegated_job`.
 */
export function usesDelegatedRail(card: DelegationCard): boolean {
  const price = card.payment?.job_price ?? 0;
  if (price <= 0 || card.delegation === undefined) {
    return false;
  }
  const cardAsset = resolvePaymentAsset(card.payment, SOLANA_CLUSTER);
  return cardAsset !== null && assetKey(cardAsset) === assetKey(resolveUsdcAsset(SOLANA_CLUSTER));
}

interface ModeArgs {
  card: DelegationCard;
  walletAddress: string | undefined;
  canSignMessage: boolean;
  /** The allowance read has settled at least once, with data or an error. */
  isFetched: boolean;
  /**
   * The latest allowance read failed. A failed refetch keeps the data of an
   * earlier success, so this - not a missing `status` alone - marks the read
   * as unusable.
   */
  isError: boolean;
  /** The read's data: `null` = the account has no delegation. */
  status: DelegationStatus | null | undefined;
}

export function resolveDelegatedBuyMode({
  card,
  walletAddress,
  canSignMessage,
  isFetched,
  isError,
  status,
}: ModeArgs): DelegatedBuyMode {
  const descriptor = card.delegation;
  if (!usesDelegatedRail(card) || descriptor === undefined || walletAddress === undefined) {
    return 'per-job';
  }
  if (!canSignMessage) {
    return 'wallet-unsupported';
  }
  if (!isFetched) {
    return 'loading';
  }
  if (isError || status === undefined) {
    return 'check-failed';
  }
  const price = BigInt(card.payment?.job_price ?? 0);
  const covering =
    status !== null &&
    status.delegate === descriptor.delegate_pubkey &&
    status.remainingCap >= price &&
    status.balance >= price;
  return covering ? 'use' : 'delegate';
}

/**
 * Why a mode holds the send, or `null` when the surface may act on it
 * ('delegate' navigates, 'use' and 'per-job' send).
 */
export function delegatedBuyHoldReason(mode: DelegatedBuyMode): string | null {
  if (mode === 'loading') {
    return 'Checking the delegated allowance…';
  }
  if (mode === 'wallet-unsupported') {
    return DELEGATED_WALLET_UNSUPPORTED_MESSAGE;
  }
  if (mode === 'check-failed') {
    return "Couldn't check your delegated allowance (network error) - checking again shortly.";
  }
  return null;
}
