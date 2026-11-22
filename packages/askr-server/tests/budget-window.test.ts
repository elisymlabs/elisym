import { PGlite } from '@electric-sql/pglite';
import Decimal from 'decimal.js-light';
import { describe, expect, it } from 'vitest';
import { type SubscriptionLike, snapshotOf } from '../src/billing/stripe';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { saveSubscription } from '../src/state/billing';
import {
  addMonths,
  anchoredWindow,
  budgetWindow,
  calendarWindow,
  utcDay,
  windowOf,
} from '../src/state/budget-window';
import { newOwner, setup, tier } from './billing-fixtures';
import { pgliteDb } from './pglite-db';

const MS_PER_DAY = 86_400_000;

/** Unix seconds of a UTC date and time (`month` 1-based, as written). */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) / 1000;
}

/** The UTC day number of a date (`month` 1-based). */
function dayOf(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

describe('addMonths: calendar months from an anchor, the day clamped as Stripe bills', () => {
  it('keeps the time of day and clamps the 31st to a short month', () => {
    const anchor = at(2027, 1, 31, 10, 30);
    expect(addMonths(anchor, 0)).toBe(anchor);
    expect(addMonths(anchor, 1)).toBe(at(2027, 2, 28, 10, 30));
    expect(addMonths(anchor, 2)).toBe(at(2027, 3, 31, 10, 30));
    expect(addMonths(anchor, 3)).toBe(at(2027, 4, 30, 10, 30));
    expect(addMonths(anchor, 12)).toBe(at(2028, 1, 31, 10, 30));
  });

  it('February of a leap year has a 29th', () => {
    expect(addMonths(at(2028, 1, 31, 8), 1)).toBe(at(2028, 2, 29, 8));
    expect(addMonths(at(2027, 1, 30, 8), 1)).toBe(at(2027, 2, 28, 8));
  });

  it('goes back across a year, clamped the same way', () => {
    const anchor = at(2027, 1, 31, 10);
    expect(addMonths(anchor, -1)).toBe(at(2026, 12, 31, 10));
    expect(addMonths(anchor, -2)).toBe(at(2026, 11, 30, 10));
    expect(addMonths(anchor, -13)).toBe(at(2025, 12, 31, 10));
  });
});

describe('anchoredWindow: the monthly slice of a subscription that holds now', () => {
  const JAN_31 = at(2027, 1, 31, 10);

  it('a monthly anchor mid-month: from the last billing date to the next', () => {
    const anchor = at(2026, 10, 15, 9);
    expect(anchoredWindow(anchor, at(2026, 11, 20, 12))).toEqual({
      startDay: dayOf(2026, 11, 15),
      resetsAt: at(2026, 12, 15, 9),
    });
    expect(anchoredWindow(anchor, at(2026, 10, 20))).toEqual({
      startDay: dayOf(2026, 10, 15),
      resetsAt: at(2026, 11, 15, 9),
    });
  });

  it('an anchor on the 31st: Feb 28 to Mar 31, no new window on Mar 28', () => {
    expect(anchoredWindow(JAN_31, at(2027, 2, 10))).toEqual({
      startDay: dayOf(2027, 1, 31),
      resetsAt: at(2027, 2, 28, 10),
    });
    expect(anchoredWindow(JAN_31, at(2027, 3, 28, 12))).toEqual({
      startDay: dayOf(2027, 2, 28),
      resetsAt: at(2027, 3, 31, 10),
    });
    expect(anchoredWindow(JAN_31, at(2027, 3, 29))).toEqual({
      startDay: dayOf(2027, 2, 28),
      resetsAt: at(2027, 3, 31, 10),
    });
  });

  it('a webhook late past Mar 31: the window comes from the anchor alone', () => {
    expect(anchoredWindow(JAN_31, at(2027, 4, 2))).toEqual({
      startDay: dayOf(2027, 3, 31),
      resetsAt: at(2027, 4, 30, 10),
    });
  });

  it('a leap February: Feb 29 to Mar 31', () => {
    expect(anchoredWindow(at(2028, 1, 31, 10), at(2028, 3, 1))).toEqual({
      startDay: dayOf(2028, 2, 29),
      resetsAt: at(2028, 3, 31, 10),
    });
  });

  it('a yearly anchor is sliced into months: month 7 of the year', () => {
    expect(anchoredWindow(at(2026, 3, 15, 6), at(2026, 10, 20))).toEqual({
      startDay: dayOf(2026, 10, 15),
      resetsAt: at(2026, 11, 15, 6),
    });
    expect(anchoredWindow(at(2025, 3, 15, 6), at(2026, 2, 20))).toEqual({
      startDay: dayOf(2026, 2, 15),
      resetsAt: at(2026, 3, 15, 6),
    });
  });

  it('exactly at a billing date a new window starts; a second before, the old one holds', () => {
    const anchor = at(2026, 10, 15, 9);
    const renewal = at(2026, 11, 15, 9);
    expect(anchoredWindow(anchor, renewal)).toEqual({
      startDay: dayOf(2026, 11, 15),
      resetsAt: at(2026, 12, 15, 9),
    });
    expect(anchoredWindow(anchor, renewal - 1)).toEqual({
      startDay: dayOf(2026, 10, 15),
      resetsAt: renewal,
    });
  });

  it('the window counts from the renewal day itself (UTC), not the day after', () => {
    const { startDay } = anchoredWindow(at(2026, 10, 15, 23, 59), at(2026, 11, 16));
    expect(startDay).toBe(utcDay(at(2026, 11, 15, 23, 59)));
    expect(startDay).toBe(dayOf(2026, 11, 15));
  });

  it('an anchor just ahead of now (clock skew): the slice before it, never the calendar month', () => {
    const now = at(2026, 11, 20, 12);
    expect(anchoredWindow(now + 60, now)).toEqual({
      startDay: dayOf(2026, 10, 20),
      resetsAt: now + 60,
    });
  });

  it('an anchor 3 months ahead (a test clock): the window holding now', () => {
    expect(anchoredWindow(JAN_31, at(2026, 11, 5))).toEqual({
      startDay: dayOf(2026, 10, 31),
      resetsAt: at(2026, 11, 30, 10),
    });
    expect(anchoredWindow(JAN_31, at(2026, 12, 1))).toEqual({
      startDay: dayOf(2026, 11, 30),
      resetsAt: at(2026, 12, 31, 10),
    });
  });
});

describe('calendarWindow and windowOf', () => {
  it('the calendar month runs from the 1st to the next 1st (UTC)', () => {
    expect(calendarWindow(at(2026, 12, 31, 23, 59))).toEqual({
      startDay: dayOf(2026, 12, 1),
      resetsAt: at(2027, 1, 1),
    });
    expect(calendarWindow(at(2026, 11, 1))).toEqual({
      startDay: dayOf(2026, 11, 1),
      resetsAt: at(2026, 12, 1),
    });
  });

  it('no anchor is the calendar month; an anchor its slice', () => {
    const now = at(2026, 11, 20);
    expect(windowOf(undefined, now)).toEqual(calendarWindow(now));
    expect(windowOf(at(2026, 10, 15, 9), now)).toEqual(anchoredWindow(at(2026, 10, 15, 9), now));
  });
});

type Harness = Awaited<ReturnType<typeof setup>>;

/** Oct 30 2026, noon: a store subscribes on the 30th. */
const SUBSCRIBED = at(2026, 10, 30, 12);

/** A store on Starter (budget 10 USD) through a live subscription anchored at `anchor`. */
async function payingStore(harness: Harness, anchor: number, created = anchor) {
  const owner = newOwner();
  harness.clock.now = created;
  await harness.open(owner);
  const snapshot = harness.subscribe(owner.pubkey, { billingCycleAnchor: anchor, created });
  await harness.completed(owner.pubkey, snapshot);
  return { owner, snapshot };
}

async function spend(harness: Harness, owner: string, day: number, usd: string): Promise<void> {
  await harness.db.query(
    `insert into store_days (owner, day, spent, reserved) values ($1, $2, $3, 0)
     on conflict (owner, day) do update set spent = $3`,
    [owner, day, usd],
  );
}

async function storeView(
  harness: Harness,
  owner: Awaited<ReturnType<typeof payingStore>>['owner'],
) {
  const response = await harness.call(owner, 'GET', '/v1/admin/store');
  expect(response.status).toBe(200);
  return response.body;
}

describe('which window a store counts its budget over', () => {
  it('a store on a live billing subscription counts from its anchor', async () => {
    const harness = await setup();
    const { owner } = await payingStore(harness, SUBSCRIBED);
    expect(await harness.planSourceOf(owner.pubkey)).toBe('billing');
    expect(await budgetWindow(harness.db, owner.pubkey, at(2026, 11, 5))).toEqual({
      startDay: dayOf(2026, 10, 30),
      resetsAt: at(2026, 11, 30, 12),
    });
  });

  it('a subscription no longer live counts the calendar month', async () => {
    const harness = await setup();
    const { owner } = await payingStore(harness, SUBSCRIBED);
    await harness.db.query(
      `update billing_subscriptions set status = 'canceled' where owner = $1`,
      [owner.pubkey],
    );
    expect(await harness.planSourceOf(owner.pubkey)).toBe('billing');
    const now = at(2026, 11, 5);
    expect(await budgetWindow(harness.db, owner.pubkey, now)).toEqual(calendarWindow(now));
  });

  it('a past_due subscription is still live: it keeps its window', async () => {
    const harness = await setup();
    const { owner } = await payingStore(harness, SUBSCRIBED);
    await harness.db.query(
      `update billing_subscriptions set status = 'past_due' where owner = $1`,
      [owner.pubkey],
    );
    expect((await budgetWindow(harness.db, owner.pubkey, at(2026, 11, 5))).startDay).toBe(
      dayOf(2026, 10, 30),
    );
  });

  it('an operator-managed or Free store counts the calendar month, a live subscription or not', async () => {
    const harness = await setup();
    const { owner } = await payingStore(harness, SUBSCRIBED);
    const now = at(2026, 11, 5);
    for (const source of ['operator', 'free']) {
      await harness.db.query('update stores set plan_source = $2 where owner = $1', [
        owner.pubkey,
        source,
      ]);
      expect(await budgetWindow(harness.db, owner.pubkey, now), source).toEqual(
        calendarWindow(now),
      );
    }
  });

  it('a subscription read before the anchor was stored (null) counts the calendar month', async () => {
    const harness = await setup();
    const { owner } = await payingStore(harness, SUBSCRIBED);
    await harness.db.query(
      'update billing_subscriptions set billing_cycle_anchor = null where owner = $1',
      [owner.pubkey],
    );
    const now = at(2026, 11, 5);
    expect(await budgetWindow(harness.db, owner.pubkey, now)).toEqual(calendarWindow(now));
  });

  it('of two live subscriptions the earliest created sets the window, as it sets the plan', async () => {
    const harness = await setup();
    const { owner, snapshot } = await payingStore(harness, SUBSCRIBED);
    const insert = (id: string, created: number, anchor: number, plan: string | null) =>
      harness.db.query(
        `insert into billing_subscriptions (subscription_id, owner, customer_id, status, plan,
           interval, stripe_created, updated_at, snapshot_fetched_at, billing_cycle_anchor)
         values ($1, $2, $3, 'active', $4, 'month', $5, $5, 0, $6)`,
        [id, owner.pubkey, snapshot.customer, plan, created, anchor],
      );
    const now = at(2026, 11, 20);
    await insert('sub_later', SUBSCRIBED + 100, at(2026, 10, 10, 8), 'growth');
    expect((await budgetWindow(harness.db, owner.pubkey, now)).startDay).toBe(dayOf(2026, 10, 30));
    // One with no plan of ours never sets the plan, created earliest or not.
    await insert('sub_planless', SUBSCRIBED - 200, at(2026, 10, 5, 8), null);
    expect((await budgetWindow(harness.db, owner.pubkey, now)).startDay).toBe(dayOf(2026, 10, 30));
    await insert('sub_earlier', SUBSCRIBED - 100, at(2026, 10, 12, 8), 'growth');
    expect(await budgetWindow(harness.db, owner.pubkey, now)).toEqual({
      startDay: dayOf(2026, 11, 12),
      resetsAt: at(2026, 12, 12, 8),
    });
  });

  it('a switch to yearly resets the anchor: a new window opens at the new anchor', async () => {
    const harness = await setup();
    const { owner, snapshot } = await payingStore(harness, SUBSCRIBED);
    const switched = at(2026, 11, 10, 15);
    harness.clock.now = switched;
    harness.subscribe(owner.pubkey, {
      ...snapshot,
      interval: 'year',
      billingCycleAnchor: switched,
    });
    await harness.subscriptionEvent('customer.subscription.updated', snapshot);
    const [row] = await harness.db.query<{ billing_cycle_anchor: number }>(
      'select billing_cycle_anchor from billing_subscriptions where subscription_id = $1',
      [snapshot.id],
    );
    expect(row?.billing_cycle_anchor).toBe(switched);
    expect(await budgetWindow(harness.db, owner.pubkey, at(2026, 11, 20))).toEqual({
      startDay: dayOf(2026, 11, 10),
      resetsAt: at(2026, 12, 10, 15),
    });
  });
});

describe('the hole is closed: one budget per paid month', () => {
  it('a store that spends its whole budget on the 30th stays paused on the 1st until its billing date', async () => {
    const harness = await setup();
    const { owner } = await payingStore(harness, SUBSCRIBED);
    await spend(harness, owner.pubkey, utcDay(SUBSCRIBED), '10');
    expect(await harness.state.budgetExhausted(owner.pubkey, SUBSCRIBED + 60)).toBe(true);

    const firstOfMonth = at(2026, 11, 1, 1);
    expect(await harness.state.budgetExhausted(owner.pubkey, firstOfMonth)).toBe(true);
    harness.clock.now = firstOfMonth;
    const paused = await storeView(harness, owner);
    expect(paused.budgetPaused).toBe('month');
    expect(paused.usage.month.spent).toBe('10');
    expect(paused.usage.budget).toEqual({ resetsAt: at(2026, 11, 30, 12) });

    // The billing day before its time still belongs to the old window.
    expect(await harness.state.budgetExhausted(owner.pubkey, at(2026, 11, 30, 11))).toBe(true);

    const renewed = at(2026, 11, 30, 13);
    expect(await harness.state.budgetExhausted(owner.pubkey, renewed)).toBe(false);
    harness.clock.now = renewed;
    const whole = await storeView(harness, owner);
    expect(whole.budgetPaused).toBeNull();
    expect(whole.usage.month.spent).toBe('0');
    expect(whole.usage.budget).toEqual({ resetsAt: at(2026, 12, 30, 12) });
  });

  it('room, usage and the admin pause agree on the window, not the calendar month', async () => {
    const harness = await setup();
    const anchor = at(2026, 10, 15, 9);
    const { owner } = await payingStore(harness, anchor);
    // Nov 10 is in the calendar month but before the window (Nov 15 - Dec 15); Nov 16 is in both.
    await spend(harness, owner.pubkey, dayOf(2026, 11, 10), '6');
    await spend(harness, owner.pubkey, dayOf(2026, 11, 16), '4');
    const now = at(2026, 11, 20, 12);
    harness.clock.now = now;
    const view = await storeView(harness, owner);
    expect(view.usage.month.spent).toBe('4');
    expect(view.usage.budget).toEqual({ resetsAt: at(2026, 12, 15, 9) });
    expect(view.budgetPaused).toBeNull();
    expect(await harness.state.budgetExhausted(owner.pubkey, now)).toBe(false);

    // Spend in the window up to the budget pauses all three at once.
    await spend(harness, owner.pubkey, dayOf(2026, 11, 16), '10');
    expect((await storeView(harness, owner)).budgetPaused).toBe('month');
    expect(await harness.state.budgetExhausted(owner.pubkey, now)).toBe(true);
  });

  it('an open reservation left on an earlier day of the window pauses the admin as it pauses turns', async () => {
    const harness = await setup();
    const anchor = at(2026, 10, 15, 9);
    const { owner } = await payingStore(harness, anchor);
    const now = at(2026, 11, 20, 12);
    harness.clock.now = now;
    const [budget] = await harness.db.query<{ monthly_budget_usd: string }>(
      `select t.monthly_budget_usd from stores s join tiers t on t.name = s.tier where s.owner = $1`,
      [owner.pubkey],
    );
    if (!budget) {
      throw new Error('no tier');
    }
    // A turn reserved the whole budget on Nov 16 and never settled (a crash): nothing was spent.
    await harness.db.query(
      `insert into store_days (owner, day, spent, reserved) values ($1, $2, 0, $3)
       on conflict (owner, day) do update set reserved = $3`,
      [owner.pubkey, dayOf(2026, 11, 16), budget.monthly_budget_usd],
    );
    expect(await harness.state.budgetExhausted(owner.pubkey, now)).toBe(true);
    const view = await storeView(harness, owner);
    expect(view.usage.month.reserved).toBe(new Decimal(budget.monthly_budget_usd).toString());
    expect(view.budgetPaused).toBe('month');
  });

  it('a Free store keeps the calendar month and its reset on the 1st', async () => {
    const harness = await setup();
    await harness.directory.setTier(tier('free', '1'));
    const owner = newOwner();
    const now = at(2026, 11, 20, 12);
    harness.clock.now = now;
    await harness.open(owner);
    // The owner's Free choice, as `activateFree` records it.
    await harness.db.query(
      `update stores set status = 'active', tier = 'free', plan_source = 'free' where owner = $1`,
      [owner.pubkey],
    );
    expect(await harness.planSourceOf(owner.pubkey)).toBe('free');
    await spend(harness, owner.pubkey, dayOf(2026, 11, 2), '0.4');
    const view = await storeView(harness, owner);
    expect(view.usage.month.spent).toBe('0.4');
    expect(view.usage.budget).toEqual({ resetsAt: at(2026, 12, 1) });
  });
});

describe('the billing cycle anchor is read and kept', () => {
  const subscription: SubscriptionLike = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    metadata: {},
    cancel_at_period_end: false,
    cancel_at: null,
    created: SUBSCRIBED - 10,
    billing_cycle_anchor: SUBSCRIBED,
    items: { data: [] },
  };

  it("the snapshot carries Stripe's billing_cycle_anchor; a body without it has none", () => {
    expect(snapshotOf(subscription, SUBSCRIBED).billingCycleAnchor).toBe(SUBSCRIBED);
    const { billing_cycle_anchor: _dropped, ...without } = subscription;
    expect(
      snapshotOf(without as unknown as SubscriptionLike, SUBSCRIBED).billingCycleAnchor,
    ).toBeUndefined();
  });

  it('migration 0012 adds a nullable billing_cycle_anchor', async () => {
    expect(MIGRATIONS.map((entry) => entry.id).at(-1)).toBe('0012_billing_cycle_anchor');
    const client = await PGlite.create();
    const db = pgliteDb(client);
    await migrate(db);
    await db.query(
      `insert into stores (owner, status, assistant, assistant_key, catalog_key,
         catalog_key_secret, created_at)
       values ($1, 'pending', $2, $3, $4, $5, $6)`,
      ['1'.repeat(64), 'b'.repeat(64), new Uint8Array(1), 'c'.repeat(64), new Uint8Array(1), 0],
    );
    const insert = (id: string, anchor: number | null) =>
      db.query(
        `insert into billing_subscriptions (subscription_id, owner, customer_id, status,
           stripe_created, updated_at, snapshot_fetched_at, billing_cycle_anchor)
         values ($1, $2, 'cus_1', 'active', 0, 0, 0, $3)`,
        [id, '1'.repeat(64), anchor],
      );
    await insert('sub_1', null);
    await insert('sub_2', SUBSCRIBED);
    expect(
      await db.query(
        'select billing_cycle_anchor from billing_subscriptions order by subscription_id',
      ),
    ).toEqual([{ billing_cycle_anchor: null }, { billing_cycle_anchor: SUBSCRIBED }]);
    expect(
      await db.query(
        `select data_type, is_nullable from information_schema.columns
         where table_name = 'billing_subscriptions' and column_name = 'billing_cycle_anchor'`,
      ),
    ).toEqual([{ data_type: 'bigint', is_nullable: 'YES' }]);
    await client.close();
  });

  it("a store's checkout saves the anchor of its subscription", async () => {
    const harness = await setup();
    const { snapshot } = await payingStore(harness, SUBSCRIBED);
    expect(
      await harness.db.query(
        'select billing_cycle_anchor from billing_subscriptions where subscription_id = $1',
        [snapshot.id],
      ),
    ).toEqual([{ billing_cycle_anchor: SUBSCRIBED }]);
  });

  it('a newer snapshot without an anchor clears the stored one, never keeps it', async () => {
    const harness = await setup();
    const { owner, snapshot } = await payingStore(harness, SUBSCRIBED);
    const [stored] = await harness.db.query<{ snapshot_fetched_at: string }>(
      'select snapshot_fetched_at from billing_subscriptions where subscription_id = $1',
      [snapshot.id],
    );
    expect(stored).toBeDefined();
    const newer = Number(stored?.snapshot_fetched_at) + 1;
    await saveSubscription(
      harness.db,
      owner.pubkey,
      { ...snapshot, billingCycleAnchor: undefined },
      SUBSCRIBED + 3600,
      newer,
    );
    expect(
      await harness.db.query(
        'select billing_cycle_anchor from billing_subscriptions where subscription_id = $1',
        [snapshot.id],
      ),
    ).toEqual([{ billing_cycle_anchor: null }]);
  });
});
