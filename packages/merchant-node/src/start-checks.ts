import {
  type QueryPool,
  type RelayView,
  offerProblems,
  profileCapabilities,
  profileMemoMarkerWarning,
  readRelayViews,
} from './checks';
import { type MerchantConfig, priceProblems, tempoRegistryNetwork } from './config';
import { OFFER_RELAYS } from './constants';
import { eip3009ChainsOf } from './eip3009';
import { type TreasuryRefresh, profileFeeWarning } from './fee';
import type { LedgerState } from './ledger';
import type { Product } from './products';
import { historyRefusal } from './setup-ledger';
import { standingTerms } from './terms';

/**
 * What the relays offer buyers that this node does not honour (see
 * `offerProblems`): a buyer could pay it and never get the order completed.
 * Judged twice: from the default relays, which every page reads, and with the
 * store's own inbox relays too, which a page reads when its naddr hints them.
 * `served`: whether any relay served a listing or the payout list; `views`:
 * what was read.
 */
export async function readOfferProblems(
  pool: QueryPool,
  config: MerchantConfig,
  pubkeys: { storePubkey: string; ownerPubkey: string },
  state: LedgerState,
  products: ReadonlyMap<string, unknown>,
): Promise<{ problems: string[]; served: boolean; views: RelayView[] }> {
  const relaySets = [OFFER_RELAYS, [...new Set([...OFFER_RELAYS, ...config.inboxRelays])]];
  const views = await readRelayViews(pool, relaySets, pubkeys, [...products.keys()]);
  const { problems, served } = offerProblems(
    views,
    config.inboxRelays,
    config.network,
    standingTerms(state.terms),
    config.tempo === undefined ? undefined : tempoRegistryNetwork(config.tempo.network),
    eip3009ChainsOf(config),
  );
  return { problems, served, views };
}

/** Why a ledger may not run with these products: one with a history has no product (see `historyRefusal`). */
export function lostHistoryProblem(
  state: LedgerState,
  products: ReadonlyMap<string, unknown>,
): string | undefined {
  return historyRefusal(state, products);
}

/** Why these products are not usable with the config's payouts (see `priceProblems`), every problem in one message. */
export function productPriceProblems<Priced extends Pick<Product, 'd' | 'priceUsd'>>(
  config: Pick<MerchantConfig, 'payouts'>,
  products: Iterable<Priced>,
): string | undefined {
  const problems = priceProblems(config, products);
  return problems.length > 0
    ? `the products are not usable:\n- ${problems.join('\n- ')}`
    : undefined;
}

/** Warnings (never refusals) when the store profile buyers read does not declare fee support or marked memos. */
export function profileWarnings(views: readonly RelayView[], refresh: TreasuryRefresh): string[] {
  const { found, feeSupport, memoMarker } = profileCapabilities(views);
  return [
    profileFeeWarning(found, feeSupport, refresh.kind === 'read' ? refresh.feeBps : undefined),
    profileMemoMarkerWarning(found, memoMarker),
  ].filter((warning): warning is string => warning !== undefined);
}
