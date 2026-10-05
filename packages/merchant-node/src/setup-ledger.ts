import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { TERMS_CLOCK_MARGIN_SECS } from './constants';
import type { LedgerState, PublishedListing } from './ledger';
import {
  type ListedProduct,
  type StoreConfig,
  buildListingEvent,
  listingHash,
  listingTerms,
  payoutTerms,
} from './store-events';
import {
  type ListingTerms,
  type PayoutTerms,
  publishTerms,
  retireTerms,
  standingTerms,
  visibleTerms,
} from './terms';

/**
 * The date to sign the payout list with: an unchanged list keeps the date it
 * was first signed (a new one would restart every buyer's "payout recently
 * changed" cool-down), but only while the relays' newest list is that very
 * one. Otherwise it is dated after the last one signed, never in the same
 * second: on a tie relays keep the lowest id, which may be the old list.
 */
export function payoutListDate(
  state: LedgerState,
  payouts: string,
  newestOnRelays: number | undefined,
  startedAt: number,
): number {
  const signed = state.payto;
  if (signed !== undefined && signed.payouts === payouts && newestOnRelays === signed.createdAt) {
    return signed.createdAt;
  }
  return Math.max(startedAt, (signed?.createdAt ?? 0) + 1);
}

/**
 * The date of product `d`'s next listing: strictly after its last one, so a
 * stop published in the same second as the on-sale version (a quick rerun, a
 * clock stepped back) can never lose the tie on relays.
 */
export function listingDate(state: LedgerState, d: string, startedAt: number): number {
  return Math.max(startedAt, (state.listings[d]?.createdAt ?? 0) + 1);
}

/**
 * Why an event dated `date` may not be published now: buyers ignore an event
 * dated too far ahead, so a clock stepped back that far must be fixed (or waited out).
 */
export function clockProblem(what: string, date: number, startedAt: number): string | undefined {
  return date - startedAt > MAX_FUTURE_SKEW_SECS - TERMS_CLOCK_MARGIN_SECS
    ? `the clock is behind the last publish of ${what}: fix the clock or wait`
    : undefined;
}

/**
 * Why the node may not use this home with these products: a product the
 * ledger has a history for - a listing that went out, or any terms - has no
 * directory. Its orders could be paid and never delivered, and its listing would
 * stay on sale. Membership is by the exact directory names read.
 */
export function historyRefusal(
  state: LedgerState,
  products: ReadonlyMap<string, unknown>,
): string | undefined {
  const known = new Set([
    ...Object.keys(state.listings),
    ...state.terms.map((period) => period.terms.d),
  ]);
  for (const d of known) {
    if (!products.has(d)) {
      return `product ${d} has a history in this store: restore products/${d}/PRODUCT.md (set "onSale: false" to stop selling it)`;
    }
  }
  return undefined;
}

/** The payouts the recorded payout list held (what buyers read when a new one did not go out). */
function recordedPayouts(state: LedgerState): PayoutTerms[] {
  if (state.payto === undefined) {
    return [];
  }
  const parsed: unknown = JSON.parse(state.payto.payouts);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return payoutTerms(
    parsed.flatMap((entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'caip19' in entry &&
      'address' in entry &&
      typeof entry.caip19 === 'string' &&
      typeof entry.address === 'string'
        ? [{ caip19: entry.caip19, address: entry.address }]
        : [],
    ),
  );
}

/** What setup does with one product's listing. */
export interface ListingPlan {
  product: ListedProduct;
  hash: string;
  /** Republished: new, changed, or not what the default relays serve as newest. */
  changed: boolean;
  /** The date it is signed with when republished (see `listingDate`). */
  createdAt: number;
}

/**
 * Plan each product's listing against what the ledger recorded and what the
 * default relays serve (`served`: the newest listing of each `d` there).
 * Only what changed is republished, so a catalogue of stopped products costs
 * nothing once their sold-out listings are out; a listing the relays lost or
 * replaced is republished too.
 */
export function planListings(
  state: LedgerState,
  products: Iterable<ListedProduct>,
  payouts: StoreConfig['payouts'],
  served: ReadonlyMap<string, { id: string }>,
  startedAt: number,
): ListingPlan[] {
  return [...products].map((product) => {
    const hash = listingHash(product, payouts);
    const recorded = state.listings[product.d];
    const changed =
      recorded === undefined ||
      recorded.hash !== hash ||
      served.get(product.d)?.id !== recorded.eventId;
    return { product, hash, changed, createdAt: listingDate(state, product.d, startedAt) };
  });
}

/** Every event setup would date too far ahead of the clock (see `clockProblem`). */
export function setupClockProblems(
  state: LedgerState,
  plans: readonly ListingPlan[],
  paytoCreatedAt: number,
  startedAt: number,
): string[] {
  return [
    ...(paytoCreatedAt === state.payto?.createdAt
      ? []
      : [clockProblem('the payout list', paytoCreatedAt, startedAt)]),
    ...plans
      .filter((plan) => plan.changed)
      .map((plan) => clockProblem(`products/${plan.product.d}`, plan.createdAt, startedAt)),
  ].filter((problem): problem is string => problem !== undefined);
}

/** Whether nothing setup published went out: no changed listing (sold-out ones included) and not the payout list. */
export function nothingWentOut(
  payoutListOut: boolean,
  outcomes: readonly ListingOutcome[],
): boolean {
  return !payoutListOut && !outcomes.some((outcome) => outcome.listing === 'out');
}

/** How one product's listing came out of a setup. */
export interface ListingOutcome {
  d: string;
  onSale: boolean;
  /** Its coins at its configured price. */
  next: readonly ListingTerms[];
  /**
   * `out`: published and taken by a relay; `unchanged`: not republished, the
   * relays serve the recorded one; `failed`: changed, and no relay took it.
   */
  listing: 'out' | 'unchanged' | 'failed';
  /** What to record when it went out. */
  record?: PublishedListing;
}

/**
 * Record in the ledger what buyers can read after a publish, per product: the
 * listing side is the product's own (its new coins and price if its listing
 * went out or stands unchanged, else its standing ones); the payout side is
 * store-wide (the configured payouts if the payout list went out, else the
 * recorded list, else none). A stopped product is retired only once its
 * sold-out listing went out: until then buyers still see it on sale. New terms
 * start at `from`, replaced and retired ones end at `until`.
 */
export function recordPublished(
  state: LedgerState,
  outcomes: readonly ListingOutcome[],
  payoutListOut: boolean,
  payoutList: { createdAt: number; payouts: string },
  configuredPayouts: readonly PayoutTerms[],
  from: number,
  until: number,
): void {
  const payoutSide = payoutListOut ? configuredPayouts : recordedPayouts(state);
  for (const outcome of outcomes) {
    const { d } = outcome;
    const went = outcome.listing !== 'failed';
    if (!outcome.onSale && went) {
      state.terms = retireTerms(state.terms, d, [], until);
    } else {
      const listingSide: readonly ListingTerms[] =
        outcome.onSale && went
          ? outcome.next
          : standingTerms(state.terms)
              .filter((terms) => terms.d === d)
              .map(({ caip19, amount }) => ({ caip19, amount }));
      const visible = visibleTerms(d, listingSide, payoutSide);
      state.terms = retireTerms(
        state.terms,
        d,
        visible.map((terms) => terms.caip19),
        until,
      );
      for (const terms of visible) {
        state.terms = publishTerms(state.terms, terms, from, until);
      }
    }
    if (outcome.listing === 'out' && outcome.record !== undefined) {
      state.listings[d] = outcome.record;
    }
  }
  if (payoutListOut) {
    state.payto = payoutList;
  }
}

/**
 * Publish a setup: every changed listing (and every product's terms) is built
 * first, so no input a commerce check refuses can surface after something went
 * out; then the payout list, the changed listings, and the other store-wide
 * events, in that order. `publish` says whether any relay took an event.
 */
export async function publishStore(
  plans: readonly ListingPlan[],
  payouts: StoreConfig['payouts'],
  storeSecretKey: Uint8Array,
  wide: { payoutList: NostrEvent; others: readonly NostrEvent[] },
  publish: (event: NostrEvent, name: string) => Promise<boolean>,
): Promise<{ payoutListOut: boolean; outcomes: ListingOutcome[] }> {
  const built = plans.map((plan) => ({
    plan,
    next: listingTerms(plan.product, payouts),
    event: plan.changed
      ? buildListingEvent(plan.product, payouts, storeSecretKey, plan.createdAt)
      : undefined,
  }));
  // The payout list first: a listing is payable only with it.
  const payoutListOut = await publish(wide.payoutList, 'the payout list');
  const outcomes: ListingOutcome[] = [];
  for (const { plan, next, event } of built) {
    const { d, onSale } = plan.product;
    if (event === undefined) {
      outcomes.push({ d, onSale, next, listing: 'unchanged' });
      continue;
    }
    const out = await publish(event, `products/${d}`);
    outcomes.push({
      d,
      onSale,
      next,
      listing: out ? 'out' : 'failed',
      ...(out
        ? { record: { hash: plan.hash, eventId: event.id, createdAt: event.created_at } }
        : {}),
    });
  }
  for (const event of wide.others) {
    await publish(event, `kind ${event.kind}`);
  }
  return { payoutListOut, outcomes };
}

/**
 * Publish a setup (`publishStore`) and record it: new terms start just before
 * `startedAt` (a buyer may read them at once), replaced and retired ones end
 * just before the clock read after the last publish (a buyer may have read them
 * until then). Throws, leaving the ledger as it was, when nothing went out.
 */
export async function publishAndRecord(
  state: LedgerState,
  setup: {
    plans: readonly ListingPlan[];
    payouts: StoreConfig['payouts'];
    storeSecretKey: Uint8Array;
    wide: { payoutList: NostrEvent; others: readonly NostrEvent[] };
    publish: (event: NostrEvent, name: string) => Promise<boolean>;
    payoutList: { createdAt: number; payouts: string };
    startedAt: number;
    now: () => number;
  },
): Promise<ListingOutcome[]> {
  const { payoutListOut, outcomes } = await publishStore(
    setup.plans,
    setup.payouts,
    setup.storeSecretKey,
    setup.wide,
    setup.publish,
  );
  if (nothingWentOut(payoutListOut, outcomes)) {
    throw new Error(
      'nothing reached a relay (no changed listing, not the payout list): the ledger is left as it was',
    );
  }
  const finishedAt = setup.now();
  // A little before the clock: a local clock running ahead of chain time must
  // not refuse a payment made right after the change.
  recordPublished(
    state,
    outcomes,
    payoutListOut,
    setup.payoutList,
    payoutTerms(setup.payouts),
    setup.startedAt - TERMS_CLOCK_MARGIN_SECS,
    finishedAt - TERMS_CLOCK_MARGIN_SECS,
  );
  return outcomes;
}
