import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { TERMS_WINDOW_SECS } from '../src/constants';
import { type LedgerState, emptyLedger } from '../src/ledger';
import {
  type ListingOutcome,
  clockProblem,
  historyRefusal,
  listingDate,
  nothingWentOut,
  payoutListDate,
  planListings,
  publishAndRecord,
  publishStore,
  recordPublished,
  setupClockProblems,
} from '../src/setup-ledger';
import { type OfferTerms, publishTerms, standingTerms, termsAt } from '../src/terms';

const USDC =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const T = 1_790_000_000;
const MAINNET =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const X = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const Y = '9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz';
const listX = JSON.stringify([{ caip19: USDC, address: X }]);
const listY = JSON.stringify([{ caip19: USDC, address: Y }]);
const A_OLD: OfferTerms = { d: 'a', caip19: USDC, payout: X, amount: '1000000' };
const B_OLD: OfferTerms = { d: 'b', caip19: USDC, payout: X, amount: '1000000' };
const FROM = T - 60;
const UNTIL = T + 600 - 60;

/** A store selling `a` and `b` at 1 USDC to X since long ago. */
function published(): LedgerState {
  const state = emptyLedger();
  state.terms = publishTerms([], A_OLD, T - 10_000, T - 10_000);
  state.terms = publishTerms(state.terms, B_OLD, T - 10_000, T - 10_000);
  state.payto = { createdAt: T - 10_000, payouts: listX };
  return state;
}

function outcome(
  d: string,
  listing: ListingOutcome['listing'],
  amount = '1000000',
  onSale = true,
): ListingOutcome {
  return {
    d,
    onSale,
    next: [{ caip19: USDC, amount }],
    listing,
    ...(listing === 'out'
      ? { record: { hash: `h-${d}-${amount}`, eventId: `e-${d}`, createdAt: T } }
      : {}),
  };
}

function standingOf(state: LedgerState, d: string): OfferTerms[] {
  return standingTerms(state.terms).filter((terms) => terms.d === d);
}

describe('recording a publish, per product', () => {
  it('records the new price of a product whose listing went out, and leaves the other', () => {
    const state = published();
    recordPublished(
      state,
      [outcome('a', 'out', '2000000'), outcome('b', 'unchanged')],
      true,
      { createdAt: T, payouts: listX },
      [{ caip19: USDC, payout: X }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([{ ...A_OLD, amount: '2000000' }]);
    expect(standingOf(state, 'b')).toEqual([B_OLD]);
    expect(state.listings.a?.eventId).toBe('e-a');
    expect(state.listings.b).toBeUndefined();
  });

  it('M10: keeps the standing price of a product whose listing failed, while another went out', () => {
    const state = published();
    // b sells at another price: a's standing terms are a's alone.
    state.terms = publishTerms(state.terms, { ...B_OLD, amount: '3000000' }, T - 5_000, T - 5_000);
    recordPublished(
      state,
      [outcome('a', 'failed', '2000000'), outcome('b', 'out')],
      true,
      { createdAt: T, payouts: listX },
      [{ caip19: USDC, payout: X }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([A_OLD]);
    expect(state.listings.a).toBeUndefined();
  });

  it('records an unchanged product the relays serve as gone out: its terms follow the new payout list', () => {
    const state = emptyLedger();
    state.listings.a = { hash: 'h', eventId: 'e-a', createdAt: T - 100 };
    recordPublished(
      state,
      [outcome('a', 'unchanged')],
      true,
      { createdAt: T, payouts: listY },
      [{ caip19: USDC, payout: Y }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([{ ...A_OLD, payout: Y }]);
  });

  it('M15: keeps a stopped product whose sold-out listing failed (buyers still see it on sale)', () => {
    const state = published();
    recordPublished(
      state,
      [outcome('a', 'failed', '1000000', false)],
      true,
      { createdAt: T, payouts: listX },
      [{ caip19: USDC, payout: X }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([A_OLD]);
  });

  it('retires a stopped product once its sold-out listing went out, and only that product', () => {
    const state = published();
    recordPublished(
      state,
      [outcome('a', 'out', '1000000', false), outcome('b', 'unchanged')],
      true,
      { createdAt: T, payouts: listX },
      [{ caip19: USDC, payout: X }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([]);
    expect(standingOf(state, 'b')).toEqual([B_OLD]);
    // A payment in the window after the stop still pays; after it, nothing.
    expect(termsAt(state.terms, 'a', UNTIL + TERMS_WINDOW_SECS - 1)).toEqual([A_OLD]);
    expect(termsAt(state.terms, 'a', UNTIL + TERMS_WINDOW_SECS + 1)).toEqual([]);
  });

  it('M25: a stopped product whose sold-out listing failed takes the new payout address', () => {
    const state = published();
    recordPublished(
      state,
      [outcome('a', 'failed', '1000000', false)],
      true,
      { createdAt: T, payouts: listY },
      [{ caip19: USDC, payout: Y }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([{ ...A_OLD, payout: Y }]);
  });

  it('M21: a new product whose listing went out gets terms at the recorded payout list when the new one failed', () => {
    const state = published();
    recordPublished(
      state,
      [outcome('c', 'out', '3000000')],
      false,
      { createdAt: T, payouts: listY },
      [{ caip19: USDC, payout: Y }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'c')).toEqual([
      { d: 'c', caip19: USDC, payout: X, amount: '3000000' },
    ]);
    expect(state.payto?.payouts).toBe(listX);
  });

  it('M26: a product re-enabled after every product was stopped takes the recorded payout list, not standing terms', () => {
    const state = published();
    state.terms = state.terms.map((period) => ({ ...period, until: T - 5_000 }));
    recordPublished(
      state,
      [outcome('a', 'out', '1000000')],
      false,
      { createdAt: T, payouts: listY },
      [{ caip19: USDC, payout: Y }],
      FROM,
      UNTIL,
    );
    expect(standingOf(state, 'a')).toEqual([A_OLD]);
  });

  it('gives a fresh store no terms when its payout list failed: nothing is payable without one', () => {
    const state = emptyLedger();
    recordPublished(
      state,
      [outcome('a', 'out')],
      false,
      { createdAt: T, payouts: listX },
      [{ caip19: USDC, payout: X }],
      FROM,
      UNTIL,
    );
    expect(state.terms).toEqual([]);
    expect(state.listings.a?.eventId).toBe('e-a');
  });

  it('M27 and M28: new terms start at `from`, replaced ones end at `until`', () => {
    const state = published();
    recordPublished(
      state,
      [outcome('a', 'out', '2000000'), outcome('b', 'unchanged')],
      true,
      { createdAt: T, payouts: listY },
      [{ caip19: USDC, payout: Y }],
      FROM,
      UNTIL,
    );
    const a = state.terms.filter((period) => period.terms.d === 'a');
    expect(a).toEqual([
      { terms: A_OLD, from: T - 10_000, until: UNTIL },
      { terms: { ...A_OLD, payout: Y, amount: '2000000' }, from: FROM },
    ]);
    // A buyer who read the new address as soon as it landed is paid in the overlap.
    expect(termsAt(state.terms, 'a', T + 300)).toContainEqual({
      ...A_OLD,
      payout: Y,
      amount: '2000000',
    });
    // The overlap is per product: b's new address never pays for a.
    expect(termsAt(state.terms, 'b', T + 300)).toEqual([B_OLD, { ...B_OLD, payout: Y }]);
  });
});

describe('dating events', () => {
  it('keeps the payout list date only while the relays serve that very list, else dates after it', () => {
    const state = published();
    expect(payoutListDate(state, listX, T - 10_000, T)).toBe(T - 10_000);
    expect(payoutListDate(state, listX, T - 10, T)).toBe(T);
    expect(payoutListDate(state, listX, undefined, T)).toBe(T);
    expect(payoutListDate(state, listY, T - 10_000, T)).toBe(T);
    expect(payoutListDate(emptyLedger(), listX, T - 10_000, T)).toBe(T);
    state.payto = { createdAt: T + 5, payouts: listX };
    expect(payoutListDate(state, listY, undefined, T)).toBe(T + 6);
  });

  it('M44: dates a listing strictly after its last one, even within the same second', () => {
    const state = emptyLedger();
    expect(listingDate(state, 'a', T)).toBe(T);
    state.listings.a = { hash: 'h', eventId: 'e', createdAt: T };
    expect(listingDate(state, 'a', T)).toBe(T + 1);
    expect(listingDate(state, 'a', T + 100)).toBe(T + 100);
  });

  it('refuses a date too far ahead of the clock', () => {
    expect(clockProblem('x', T + 10, T)).toBeUndefined();
    expect(clockProblem('x', T + MAX_FUTURE_SKEW_SECS, T)).toContain('the clock is behind');
  });
});

describe('a product with a history in the store', () => {
  it('M23: is refused when its listing went out and its directory is gone', () => {
    const state = emptyLedger();
    state.listings.gone = { hash: 'h', eventId: 'e', createdAt: T };
    expect(historyRefusal(state, new Map([['other', {}]]))).toContain('restore products/gone');
    expect(historyRefusal(state, new Map([['gone', {}]]))).toBeUndefined();
  });

  it('M9: is refused when it has only ended terms', () => {
    const state = emptyLedger();
    state.terms = [{ terms: { ...A_OLD, d: 'old' }, from: T - 100, until: T - 50 }];
    expect(historyRefusal(state, new Map())).toContain('product old has a history');
  });

  it('M35: is looked up by its exact name, never case-insensitively', () => {
    const state = emptyLedger();
    state.listings.Deposit = { hash: 'h', eventId: 'e', createdAt: T };
    expect(historyRefusal(state, new Map([['deposit', {}]]))).toContain('Deposit');
  });

  it('is never refused for a fresh store', () => {
    expect(historyRefusal(emptyLedger(), new Map())).toBeUndefined();
  });
});

describe('planning the listings of a setup (T10)', () => {
  const payouts = [{ caip19: USDC, address: X }];
  const product = (d: string, overrides: Partial<{ priceUsd: string; onSale: boolean }> = {}) => ({
    d,
    title: d,
    description: '',
    priceUsd: '1',
    onSale: true,
    ...overrides,
  });

  /** A ledger whose recorded listings of `ds` the relays serve as newest. */
  function recorded(ds: string[]) {
    const state = emptyLedger();
    const served = new Map<string, { id: string }>();
    for (const d of ds) {
      const [plan] = planListings(state, [product(d)], payouts, new Map(), T);
      state.listings[d] = {
        hash: plan?.hash ?? '',
        eventId: `e-${d}`,
        createdAt: T - 100,
      };
      served.set(d, { id: `e-${d}` });
    }
    return { state, served };
  }

  const changed = (plans: { product: { d: string }; changed: boolean }[]) =>
    plans.filter((plan) => plan.changed).map((plan) => plan.product.d);

  it('M30: does not republish an unchanged product the relays serve; publishes a new one', () => {
    const { state, served } = recorded(['a', 'b']);
    expect(
      changed(planListings(state, [product('a'), product('b'), product('c')], payouts, served, T)),
    ).toEqual(['c']);
  });

  it('republishes only the product whose price changed', () => {
    const { state, served } = recorded(['a', 'b']);
    expect(
      changed(
        planListings(state, [product('a', { priceUsd: '2' }), product('b')], payouts, served, T),
      ),
    ).toEqual(['a']);
  });

  it('M31: republishes a listing the relays lost, or one they serve a newer version of', () => {
    const { state, served } = recorded(['a', 'b']);
    served.delete('a');
    served.set('b', { id: 'someone-else' });
    expect(changed(planListings(state, [product('a'), product('b')], payouts, served, T))).toEqual([
      'a',
      'b',
    ]);
  });

  it('a stop republishes once; the next setup leaves it', () => {
    const { state, served } = recorded(['a']);
    const [stop] = planListings(state, [product('a', { onSale: false })], payouts, served, T);
    expect(stop?.changed).toBe(true);
    state.listings.a = { hash: stop?.hash ?? '', eventId: 'e-stop', createdAt: T };
    served.set('a', { id: 'e-stop' });
    expect(
      changed(planListings(state, [product('a', { onSale: false })], payouts, served, T)),
    ).toEqual([]);
  });

  it('M38: a coin change republishes every product on sale, and no sold-out one', () => {
    const { state, served } = recorded(['a']);
    const [stop] = planListings(state, [product('s', { onSale: false })], payouts, new Map(), T);
    state.listings.s = {
      hash: stop?.hash ?? '',
      eventId: 'e-s',
      createdAt: T - 100,
    };
    served.set('s', { id: 'e-s' });
    const more = [...payouts, { caip19: MAINNET, address: X }];
    expect(
      changed(
        planListings(state, [product('a'), product('s', { onSale: false })], more, served, T),
      ),
    ).toEqual(['a']);
  });

  it('dates a republished listing after its last, and refuses a clock that stepped back', () => {
    const { state, served } = recorded(['a']);
    state.listings.a = {
      ...state.listings.a,
      hash: 'other',
      eventId: 'e-a',
      createdAt: T + 3600,
    };
    const plans = planListings(state, [product('a')], payouts, served, T);
    expect(plans[0]?.createdAt).toBe(T + 3601);
    expect(setupClockProblems(state, plans, T, T)).toEqual([
      'the clock is behind the last publish of products/a: fix the clock or wait',
    ]);
    // An unchanged product is not published, so its date never refuses.
    expect(
      setupClockProblems(
        state,
        plans.map((plan) => ({ ...plan, changed: false })),
        T,
        T,
      ),
    ).toEqual([]);
  });

  it('throws on a setup where nothing went out, and not when the payout list or a listing did', () => {
    expect(nothingWentOut(false, [outcome('a', 'unchanged'), outcome('b', 'failed')])).toBe(true);
    expect(nothingWentOut(true, [outcome('a', 'failed')])).toBe(false);
    expect(nothingWentOut(false, [outcome('a', 'out', '1', false)])).toBe(false);
  });
});

describe('publishing a setup', () => {
  const payouts = [{ caip19: USDC, address: X }];
  const store = generateSecretKey();
  const wide = { payoutList: { kind: 10133 } as never, others: [] };

  it('builds every changed listing before anything is published: a refused input publishes nothing', async () => {
    const good = { d: 'a', title: 'a', description: '', priceUsd: '1', onSale: true };
    // A price the listing builder refuses (a leading zero).
    const bad = { ...good, d: 'b', priceUsd: '010' };
    const plans = planListings(emptyLedger(), [good, bad], payouts, new Map(), T);
    const published: string[] = [];
    await expect(
      publishStore(plans, payouts, store, wide, async (_event, name) => {
        published.push(name);
        return true;
      }),
    ).rejects.toThrow();
    expect(published).toEqual([]);
  });

  const productOf = (d: string) => ({ d, title: d, description: '', priceUsd: '1', onSale: true });
  const profile = { kind: 30019 } as never;

  it('publishes the payout list, then the changed listings, then the rest; an unchanged one not at all', async () => {
    const state = emptyLedger();
    const [kept] = planListings(state, [productOf('kept')], payouts, new Map(), T);
    state.listings.kept = { hash: kept?.hash ?? '', eventId: 'e-kept', createdAt: T - 10 };
    const plans = planListings(
      state,
      [productOf('a'), productOf('b'), productOf('kept')],
      payouts,
      new Map([['kept', { id: 'e-kept' }]]),
      T,
    );
    const published: { name: string; createdAt: number }[] = [];
    const result = await publishStore(
      plans,
      payouts,
      store,
      { payoutList: wide.payoutList, others: [profile] },
      async (event, name) => {
        published.push({ name, createdAt: event.created_at });
        return name !== 'products/b';
      },
    );
    expect(published.map((entry) => entry.name)).toEqual([
      'the payout list',
      'products/a',
      'products/b',
      'kind 30019',
    ]);
    expect(result.payoutListOut).toBe(true);
    expect(result.outcomes).toMatchObject([
      { d: 'a', listing: 'out' },
      { d: 'b', listing: 'failed' },
      { d: 'kept', listing: 'unchanged' },
    ]);
    expect(result.outcomes[0]?.record?.createdAt).toBe(
      published.find((entry) => entry.name === 'products/a')?.createdAt,
    );
    expect(result.outcomes[1]?.record).toBeUndefined();
  });

  it('M27 M28: new terms start before setup started, replaced ones end after its last publish', async () => {
    const state = published();
    let clock = T;
    const plans = planListings(
      state,
      [{ ...productOf('a'), priceUsd: '2' }],
      payouts,
      new Map(),
      T,
    );
    await publishAndRecord(state, {
      plans,
      payouts,
      storeSecretKey: store,
      wide: { payoutList: wide.payoutList, others: [profile] },
      publish: async () => {
        clock += 300;
        return true;
      },
      payoutList: { createdAt: T, payouts: listX },
      startedAt: T,
      now: () => clock,
    });
    const a = state.terms.filter((period) => period.terms.d === 'a');
    expect(a).toEqual([
      { terms: A_OLD, from: T - 10_000, until: T + 900 - 60 },
      { terms: { ...A_OLD, amount: '2000000' }, from: T - 60 },
    ]);
  });

  it('records nothing when nothing went out', async () => {
    const state = published();
    const before = JSON.stringify(state);
    const plans = planListings(state, [productOf('a')], payouts, new Map(), T);
    await expect(
      publishAndRecord(state, {
        plans,
        payouts,
        storeSecretKey: store,
        wide,
        publish: async () => false,
        payoutList: { createdAt: T, payouts: listX },
        startedAt: T,
        now: () => T,
      }),
    ).rejects.toThrow('nothing reached a relay');
    expect(JSON.stringify(state)).toBe(before);
  });
});
