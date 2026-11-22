import { nip19 } from 'nostr-tools';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { type PlanPrice, createStripeGateway } from '../src/billing/stripe';
import { CLI_USAGE, migratesFirst, runCli } from '../src/cli';
import type { FreeTier } from '../src/config';
import type { Db, Queryable } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { utcDay } from '../src/state/budget-window';
import { StoreDirectory } from '../src/state/stores';
import {
  computeStats,
  formatStats,
  printable,
  statsJson,
  type OperatorStats,
  type PriceSource,
  type StatsOptions,
} from '../src/stats';
import { MASTER_KEY } from './fixtures';
import { freshDb } from './pglite-db';

const DAY = 86_400;
/** 2026-11-20 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 12) / 1000;
const TODAY = utcDay(NOW);
/** 2026-11-01. */
const MONTH = Date.UTC(2026, 10, 1) / 1000 / DAY;
const FREE: FreeTier = { tier: 'free', perDay: 50, maxActive: 500 };

const NO_PRICES: PriceSource = { kind: 'off' };

function price(
  plan: PlanPrice['plan'],
  interval: PlanPrice['interval'],
  unitAmount: number | null,
  extra: Partial<PlanPrice> = {},
): PlanPrice {
  return { plan, interval, unitAmount, currency: 'usd', taxBehavior: 'inclusive', ...extra };
}

function loaded(...prices: PlanPrice[]): PriceSource {
  return { kind: 'loaded', prices };
}

let ownerCounter = 0;
function newOwnerHex(): string {
  ownerCounter += 1;
  return ownerCounter.toString(16).padStart(64, 'a');
}

async function addTier(db: Db, name: string, monthly = '10'): Promise<void> {
  await db.query(
    `insert into tiers (name, messages_per_session_per_day, monthly_budget_usd,
       tickets_per_store_per_minute, max_products, sync_interval_minutes, branding)
     values ($1, 30, $2, 60, 500, 30, false) on conflict (name) do nothing`,
    [name, monthly],
  );
}

interface StoreFixture {
  status?: 'pending' | 'active' | 'suspended';
  tier?: string | null;
  planSource?: 'operator' | 'free' | 'billing' | null;
  createdAt?: number;
  autoActivatedAt?: number | null;
  email?: string | null;
}

async function addStore(db: Db, fixture: StoreFixture = {}): Promise<string> {
  const owner = newOwnerHex();
  const status = fixture.status ?? 'active';
  const tier =
    fixture.tier === undefined ? (status === 'pending' ? null : 'starter') : fixture.tier;
  if (tier !== null) {
    await addTier(db, tier);
  }
  const planSource =
    fixture.planSource === undefined ? (tier === null ? null : 'billing') : fixture.planSource;
  await db.query(
    `insert into stores (owner, status, tier, assistant, assistant_key, catalog_key,
       catalog_key_secret, created_at, auto_activated_at, contact_email, plan_source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      owner,
      status,
      tier,
      `assistant-${owner}`,
      new Uint8Array([1]),
      `catalog-${owner}`,
      new Uint8Array([2]),
      fixture.createdAt ?? NOW - 100 * DAY,
      fixture.autoActivatedAt ?? null,
      fixture.email ?? null,
      planSource,
    ],
  );
  return owner;
}

interface SubscriptionFixture {
  status?: string;
  plan?: string | null;
  interval?: 'month' | 'year' | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: number;
  stripeCreated?: number;
  updatedAt?: number;
  anchor?: number | null;
  scheduled?: { plan: string | null; interval: 'month' | 'year' | null; at: number };
}

let subscriptionCounter = 0;
async function addSubscription(
  db: Db,
  owner: string,
  fixture: SubscriptionFixture = {},
): Promise<void> {
  subscriptionCounter += 1;
  await db.query(
    `insert into billing_subscriptions (subscription_id, owner, customer_id, status, plan, interval,
       current_period_end, cancel_at_period_end, stripe_created, updated_at, snapshot_fetched_at,
       scheduled_plan, scheduled_interval, scheduled_at, billing_cycle_anchor)
     values ($1, $2, 'cus_1', $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13)`,
    [
      `sub_${subscriptionCounter}`,
      owner,
      fixture.status ?? 'active',
      fixture.plan === undefined ? 'starter' : fixture.plan,
      fixture.interval === undefined ? 'month' : fixture.interval,
      fixture.currentPeriodEnd ?? NOW + 10 * DAY,
      fixture.cancelAtPeriodEnd ?? false,
      fixture.stripeCreated ?? NOW - 60 * DAY,
      fixture.updatedAt ?? NOW - 60 * DAY,
      fixture.scheduled?.plan ?? null,
      fixture.scheduled?.interval ?? null,
      fixture.scheduled?.at ?? null,
      fixture.anchor ?? null,
    ],
  );
}

async function addSpend(
  db: Db,
  owner: string,
  day: number,
  spent: string,
  reserved = '0',
): Promise<void> {
  await db.query('insert into store_days (owner, day, spent, reserved) values ($1, $2, $3, $4)', [
    owner,
    day,
    spent,
    reserved,
  ]);
}

async function addActivity(
  db: Db,
  owner: string,
  day: number,
  counts: { conversations?: number; answers?: number; links?: number; carts?: number },
): Promise<void> {
  await db.query(
    `insert into activity_days (owner, day, conversations, answers, links, carts)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      owner,
      day,
      counts.conversations ?? 0,
      counts.answers ?? 0,
      counts.links ?? 0,
      counts.carts ?? 0,
    ],
  );
}

async function addOrigin(db: Db, owner: string): Promise<void> {
  await db.query(
    `insert into store_origins (owner, origin, first_seen, last_seen)
     values ($1, 'https://shop.example', $2, $2)`,
    [owner, NOW - DAY],
  );
}

function options(extra: Partial<StatsOptions> = {}): StatsOptions {
  return { days: 30, freeTier: FREE, prices: NO_PRICES, ...extra };
}

function stats(db: Db, extra: Partial<StatsOptions> = {}, now = NOW): Promise<OperatorStats> {
  return computeStats(db, now, options(extra));
}

function lineOf(text: string, start: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(start)) ?? ''
  );
}

describe('stats: stores and growth', () => {
  it('counts new stores strictly inside 7 days and inside --days (1)', async () => {
    const db = await freshDb();
    await addStore(db, { createdAt: NOW - 7 * DAY + 1 });
    await addStore(db, { createdAt: NOW - 7 * DAY });
    await addStore(db, { createdAt: NOW - 7 * DAY - 1 });
    await addStore(db, { createdAt: NOW - 2 * DAY });
    expect((await stats(db)).stores.new).toEqual({ days7: 2, window: 4 });
    expect((await stats(db, { days: 3 })).stores.new).toEqual({ days7: 2, window: 1 });
  });

  it('counts each status, and a tier with no plan source as the operator s (2)', async () => {
    const db = await freshDb();
    await addStore(db, { status: 'pending' });
    await addStore(db, { status: 'pending' });
    await addStore(db, { status: 'active', tier: 'pro', planSource: null });
    await addStore(db, { status: 'suspended', tier: 'pro', planSource: 'billing' });
    // Pending with a tier left on it: not on a plan in the plans line.
    await addStore(db, { status: 'pending', tier: 'pro', planSource: null });
    const report = await stats(db);
    expect(report.stores.total).toBe(5);
    expect(report.stores.byStatus).toEqual({ pending: 3, active: 1, suspended: 1 });
    expect(report.stores.byPlan).toEqual([
      { tier: 'pro', source: 'billing', status: 'suspended', count: 1 },
      { tier: 'pro', source: 'operator', status: 'active', count: 1 },
    ]);
  });

  it('counts Free activations as the cap does, and prints the caps from the env (14)', async () => {
    const db = await freshDb();
    await addStore(db, { tier: 'free', planSource: 'free', autoActivatedAt: NOW - DAY + 1 });
    await addStore(db, { tier: 'free', planSource: 'free', autoActivatedAt: NOW - DAY });
    await addStore(db, { tier: 'free', planSource: 'free', autoActivatedAt: NOW - 8 * DAY });
    // The operator put this one on Free: not self-serve, not under the cap.
    await addStore(db, { tier: 'free', planSource: 'operator', autoActivatedAt: null });
    // Self-serve once, suspended now: not active.
    await addStore(db, {
      status: 'suspended',
      tier: 'free',
      planSource: 'free',
      autoActivatedAt: NOW - 2 * DAY,
    });
    const report = await stats(db);
    expect(report.stores.free).toEqual({
      tier: 'free',
      last24h: 1,
      perDay: 50,
      active: 3,
      maxActive: 500,
      last7d: 3,
    });
    const text = formatStats(report);
    expect(lineOf(text, 'free')).toContain('Free activations (incl. lapsed paid)');
    expect(lineOf(text, 'free')).toContain('last 24 h 1/50');
    expect(lineOf(text, 'free')).toContain('active self-serve 3/500');
  });

  it('says Free self-serve is off without a Free tier (15)', async () => {
    const db = await freshDb();
    await addStore(db, { tier: 'free', planSource: 'free', autoActivatedAt: NOW - 60 });
    const report = await stats(db, { freeTier: undefined });
    expect(report.stores.free).toBeNull();
    expect(formatStats(report)).toContain('Free self-serve off');
  });

  it('lists pending stores with settings waiting, the stale ones by created_at (19)', async () => {
    const db = await freshDb();
    const stale = await addStore(db, { status: 'pending', createdAt: NOW - 3 * DAY - 1 });
    await addOrigin(db, stale);
    const fresh = await addStore(db, { status: 'pending', createdAt: NOW - 3 * DAY + 1 });
    await addOrigin(db, fresh);
    // Pending without settings, and active with settings: not waiting.
    await addStore(db, { status: 'pending', createdAt: NOW - 10 * DAY });
    const active = await addStore(db, { createdAt: NOW - 10 * DAY });
    await addOrigin(db, active);
    const report = await stats(db);
    expect(report.stores.waiting).toEqual({
      count: 2,
      stale: [{ owner: stale, createdAt: NOW - 3 * DAY - 1 }],
    });
    expect(formatStats(report)).toContain('age from created_at, not from when settings were saved');
  });

  it('counts the funnel and checkouts opened by stores not paying now (16)', async () => {
    const db = await freshDb();
    const paying = await addStore(db);
    await addOrigin(db, paying);
    await addSubscription(db, paying);
    await db.query('insert into store_totals (owner, conversations) values ($1, 3)', [paying]);
    const lapsed = await addStore(db, { status: 'pending', tier: null });
    await addOrigin(db, lapsed);
    await db.query('insert into store_totals (owner, conversations) values ($1, 0)', [lapsed]);
    for (const [owner, createdAt] of [
      [paying, NOW - DAY],
      [lapsed, NOW - DAY],
    ] as const) {
      await db.query(
        `insert into billing_checkouts (owner, session_id, created_at) values ($1, $2, $3)`,
        [owner, `cs_${owner}`, createdAt],
      );
    }
    const old = await addStore(db, { status: 'pending', tier: null });
    await db.query(
      `insert into billing_checkouts (owner, session_id, created_at) values ($1, 'cs_old', $2)`,
      [old, NOW - 31 * DAY],
    );
    const report = await stats(db);
    expect(report.stores.funnel).toEqual({
      created: 3,
      configured: 2,
      onPlan: 1,
      talked: 1,
      paying: 1,
    });
    expect(report.stores.checkoutOpenedNotPaying).toBe(1);
    expect(report.usage.configuredNeverTalked).toBe(1);
    expect(formatStats(report)).toContain('1 checkout opened, not paying now');
  });
});

describe('stats: subscriptions and revenue', () => {
  it('counts only live subscriptions as paying (3)', async () => {
    const db = await freshDb();
    for (const status of ['active', 'trialing', 'past_due', 'canceled', 'incomplete']) {
      await addSubscription(db, await addStore(db), { status });
    }
    const report = await stats(db);
    expect(report.revenue.paying).toEqual([
      { plan: 'starter', interval: 'month', count: 3, mrrUsd: null },
    ]);
    expect(report.stores.funnel.paying).toBe(3);
  });

  it('counts a store once, on its earliest live plan subscription; a live one with no plan is not paying (4)', async () => {
    const db = await freshDb();
    const store = await addStore(db, { tier: 'growth' });
    await addSubscription(db, store, { plan: 'pro', stripeCreated: NOW - 10 * DAY });
    await addSubscription(db, store, { plan: 'growth', stripeCreated: NOW - 20 * DAY });
    const noPlan = await addStore(db);
    await addSubscription(db, noPlan, { plan: null, interval: null });
    const report = await stats(db);
    expect(report.revenue.paying).toEqual([
      { plan: 'growth', interval: 'month', count: 1, mrrUsd: null },
    ]);
    expect(report.stores.funnel.paying).toBe(1);
  });

  it('prices MRR from Stripe exactly, yearly over twelve months, rounded for display only (5)', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), { plan: 'starter', interval: 'month' });
    await addSubscription(db, await addStore(db, { tier: 'growth' }), {
      plan: 'growth',
      interval: 'year',
    });
    const exact = await stats(db, {
      prices: loaded(price('starter', 'month', 2900), price('growth', 'year', 94800)),
    });
    expect(exact.revenue.mrrUsd).toBe('108');
    expect(exact.revenue.mrrPartial).toBe(false);
    expect(formatStats(exact)).toContain(
      'est. MRR $108.00 (incl. past due and cancelling, incl. tax)',
    );

    const db2 = await freshDb();
    await addSubscription(db2, await addStore(db2, { tier: 'pro' }), {
      plan: 'pro',
      interval: 'year',
    });
    const thirds = await stats(db2, { prices: loaded(price('pro', 'year', 10000)) });
    expect(thirds.revenue.mrrUsd).toBe('8.3333333333333333333');
    expect(thirds.revenue.paying[0]?.mrrUsd).toBe('8.3333333333333333333');
    expect(formatStats(thirds)).toContain('est. MRR $8.33 ');
  });

  it('marks MRR partial for each sold plan without a usable price, never failing the report (6)', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), { plan: 'starter', interval: 'month' });
    await addSubscription(db, await addStore(db, { tier: 'growth' }), {
      plan: 'growth',
      interval: 'month',
    });
    const cases: [PriceSource, string][] = [
      [{ kind: 'off' }, 'billing is off'],
      [{ kind: 'failed', message: 'boom' }, 'Stripe price read failed: boom'],
      [loaded(price('starter', 'month', 2900)), 'no Stripe price'],
      [
        loaded(price('starter', 'month', 2900), price('growth', 'month', null)),
        'the Stripe price has no fixed amount',
      ],
      [
        loaded(
          price('starter', 'month', 2900),
          price('growth', 'month', 9900, { currency: 'eur' }),
        ),
        'the Stripe price is in EUR, not USD',
      ],
    ];
    for (const [prices, reason] of cases) {
      const report = await stats(db, { prices });
      expect(report.revenue.mrrPartial).toBe(true);
      expect(report.revenue.mrrUnavailable).toContainEqual({
        plan: 'growth',
        interval: 'month',
        reason,
      });
      expect(report.usage).toBeDefined();
      expect(report.cost.byPlan.length).toBeGreaterThan(0);
      expect(report.health.budget).toBeDefined();
      const text = formatStats(report);
      expect(text).toContain(`n/a (${reason})`);
      expect(text).toContain('HEALTH');
      if (prices.kind === 'loaded') {
        // The priced plan still counts: the total is a lower bound, not nothing.
        expect(report.revenue.mrrUsd).toBe('29');
        expect(text).toContain('est. MRR >= $29.00');
        expect(text).toContain('1 plan n/a');
      }
    }
    // An unsold plan without a price is not an error; an archived price still prices its plan
    // (the loader returns it); an exclusive price says so.
    const complete = await stats(db, {
      prices: loaded(
        price('starter', 'month', 2900, { taxBehavior: 'exclusive' }),
        price('growth', 'month', 9900, { taxBehavior: 'exclusive' }),
      ),
    });
    expect(complete.revenue.mrrPartial).toBe(false);
    expect(complete.revenue.mrrUnavailable).toEqual([]);
    expect(complete.revenue.mrrUsd).toBe('128');
    expect(complete.revenue.taxBehavior).toBe('exclusive');
    expect(formatStats(complete)).toContain('excl. tax');
    const mixed = await stats(db, {
      prices: loaded(
        price('starter', 'month', 2900, { taxBehavior: 'exclusive' }),
        price('growth', 'month', 9900),
      ),
    });
    expect(mixed.revenue.taxBehavior).toBe('mixed');
  });

  it('reads every plan price with one call, archived ones included', async () => {
    const requests: URL[] = [];
    const product = { id: 'prod_pro', object: 'product', metadata: { askr_tier: 'pro' } };
    const fetcher = async (input: unknown) => {
      const url = new URL(String(input));
      requests.push(url);
      return new Response(
        JSON.stringify({
          object: 'list',
          has_more: false,
          url: '/v1/prices',
          data: [
            {
              id: 'price_pro_year',
              object: 'price',
              active: false,
              lookup_key: 'askr_pro_yearly',
              recurring: { interval: 'year' },
              product,
              unit_amount: 159_00,
              currency: 'usd',
              tax_behavior: 'inclusive',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } },
      );
    };
    const gateway = createStripeGateway('rk_test_stub', Stripe.createFetchHttpClient(fetcher));
    expect(await gateway.planPrices()).toEqual([
      price('pro', 'year', 159_00, { taxBehavior: 'inclusive' }),
    ]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.searchParams.get('active')).toBeNull();
    expect(request?.searchParams.get('lookup_keys[7]')).toBe('askr_scale_yearly');
    expect(request?.searchParams.get('expand[0]')).toBe('data.product');
  });

  it('puts only live cancelling subscriptions at risk; core MRR leaves out past due and cancelling (7, 10.20)', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: NOW + 5 * DAY,
    });
    await addSubscription(db, await addStore(db), {
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: NOW + 2 * DAY,
    });
    await addSubscription(db, await addStore(db), { status: 'past_due' });
    const pastDue = await stats(db);
    await addSubscription(db, await addStore(db));
    const report = await stats(db, { prices: loaded(price('starter', 'month', 2900)) });
    expect(report.revenue.cancelling).toEqual({
      count: 1,
      mrrUsd: '29',
      partial: false,
      firstEndsAt: NOW + 5 * DAY,
    });
    expect(report.revenue.mrrUsd).toBe('87');
    expect(report.revenue.mrrCoreUsd).toBe('29');
    expect(report.revenue.pastDue).toHaveLength(1);
    expect(pastDue.revenue.pastDue).toEqual(report.revenue.pastDue);
    expect(formatStats(report)).toContain('excl. past due / cancelling $29.00');
  });

  it('counts churn: canceled or unpaid inside the window, with no live plan left (8)', async () => {
    const db = await freshDb();
    const windowStart = NOW - 30 * DAY;
    await addSubscription(db, await addStore(db), {
      status: 'canceled',
      updatedAt: windowStart + 1,
    });
    await addSubscription(db, await addStore(db), { status: 'unpaid', updatedAt: NOW - DAY });
    await addSubscription(db, await addStore(db), { status: 'canceled', updatedAt: windowStart });
    const resubscribed = await addStore(db);
    await addSubscription(db, resubscribed, { status: 'canceled', updatedAt: NOW - DAY });
    await addSubscription(db, resubscribed);
    await addSubscription(db, await addStore(db), { status: 'incomplete', updatedAt: NOW - DAY });
    const report = await stats(db);
    expect(report.revenue.churned).toBe(2);
    expect(formatStats(report)).toContain('churned 2 (approx.');
  });

  it('counts new paid inside the window', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), { stripeCreated: NOW - 30 * DAY + 1 });
    await addSubscription(db, await addStore(db), { stripeCreated: NOW - 30 * DAY });
    expect((await stats(db)).revenue.newPaid).toBe(1);
  });

  it('flags integrity problems, a billing store nobody pays for included (9, 10.4)', async () => {
    const db = await freshDb();
    const operator = await addStore(db, { planSource: 'operator' });
    await addSubscription(db, operator);
    const suspended = await addStore(db, { status: 'suspended' });
    await addSubscription(db, suspended);
    const mismatch = await addStore(db, { tier: 'pro' });
    await addSubscription(db, mismatch);
    const unpaid = await addStore(db);
    await addSubscription(db, unpaid, { status: 'canceled' });
    const consistent = await addStore(db);
    await addSubscription(db, consistent);
    // Suspended billing store without a subscription: not served, nothing to flag.
    await addStore(db, { status: 'suspended' });
    const report = await stats(db);
    expect(report.revenue.integrity).toEqual(
      expect.arrayContaining([
        { owner: operator, problem: 'operator_managed' },
        { owner: suspended, problem: 'store_not_active' },
        { owner: mismatch, problem: 'tier_mismatch' },
        { owner: unpaid, problem: 'billing_without_subscription' },
      ]),
    );
    expect(report.revenue.integrity).toHaveLength(4);
    expect(formatStats(report)).toContain(
      `${nip19.npubEncode(unpaid)} billing_without_subscription`,
    );
  });

  it('lists scheduled changes', async () => {
    const db = await freshDb();
    const store = await addStore(db, { tier: 'growth' });
    await addSubscription(db, store, {
      plan: 'growth',
      scheduled: { plan: 'starter', interval: 'month', at: NOW + 14 * DAY },
    });
    const report = await stats(db);
    expect(report.revenue.scheduled).toEqual([
      { owner: store, from: 'growth', to: 'starter', interval: 'month', at: NOW + 14 * DAY },
    ]);
    expect(formatStats(report)).toContain('growth -> starter (month) on 2026-12-04');
  });

  it('counts active operator-managed stores off Free on their own line, out of MRR (10.9)', async () => {
    const db = await freshDb();
    await addStore(db, { tier: 'enterprise', planSource: 'operator' });
    await addStore(db, { tier: 'enterprise', planSource: null });
    await addStore(db, { status: 'suspended', tier: 'enterprise', planSource: 'operator' });
    await addStore(db, { tier: 'free', planSource: 'operator' });
    const report = await stats(db);
    expect(report.revenue.operatorManaged).toEqual([{ tier: 'enterprise', count: 2 }]);
    expect(lineOf(formatStats(report), 'operator')).toBe(
      'operator    enterprise 2  operator-managed (not in MRR)',
    );
    const unset = await stats(db, { freeTier: undefined });
    expect(unset.revenue.operatorManaged).toEqual([
      { tier: 'enterprise', count: 2 },
      { tier: 'free', count: 1 },
    ]);
    expect(formatStats(unset)).toContain('operator-managed (not in MRR, incl. any free tier)');
  });

  it('lists live subscriptions over a day past their period end as stale (10.5)', async () => {
    const db = await freshDb();
    const stale = await addStore(db);
    await addSubscription(db, stale, { currentPeriodEnd: NOW - DAY - 1 });
    await addSubscription(db, await addStore(db), { currentPeriodEnd: NOW - DAY });
    await addSubscription(db, await addStore(db), {
      status: 'canceled',
      currentPeriodEnd: NOW - 10 * DAY,
    });
    const report = await stats(db);
    expect(report.health.staleSubscriptions).toEqual([
      { owner: stale, currentPeriodEnd: NOW - DAY - 1 },
    ]);
  });

  it('reads Stripe event freshness only with billing on', async () => {
    const db = await freshDb();
    await db.query(
      `insert into stripe_events (id, type, received_at) values ('evt_1', 't', $1), ('evt_2', 't', $2)`,
      [NOW - 8 * DAY, NOW - 60],
    );
    expect((await stats(db)).health.stripe).toBeNull();
    expect((await stats(db, { prices: loaded() })).health.stripe).toEqual({
      lastEventAt: NOW - 60,
      events7d: 1,
    });
  });
});

describe('stats: usage', () => {
  it('counts a store active only on a day it answered, once however many days (13)', async () => {
    const db = await freshDb();
    const answering = await addStore(db);
    await addActivity(db, answering, TODAY, { answers: 2, conversations: 1 });
    await addActivity(db, answering, TODAY - 1, { answers: 1 });
    const linksOnly = await addStore(db);
    await addActivity(db, linksOnly, TODAY, { links: 4 });
    const older = await addStore(db);
    await addActivity(db, older, TODAY - 10, { answers: 1, carts: 2 });
    const report = await stats(db);
    expect(report.usage.activeStores).toEqual({ days7: 1, window: 2 });
    expect(report.usage.activity.days7).toEqual({
      conversations: 1,
      answers: 3,
      links: 4,
      carts: 0,
    });
    expect(report.usage.activity.window.carts).toBe(2);
    expect(report.usage.silent).toEqual({ neverAnswered: 1, quiet: 0 });
  });

  it('counts open sessions, lifetime conversations and quiet stores', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    await addActivity(db, store, TODAY - 30, { answers: 1 });
    await db.query('insert into store_totals (owner, conversations) values ($1, 7)', [store]);
    for (const [visitor, end] of [
      ['v1', NOW + 1],
      ['v2', NOW],
    ] as const) {
      await db.query(
        `insert into sessions (owner, assistant, visitor, id, session_end, data)
         values ($1, 'a', $2, $2, $3, '{}')`,
        [store, visitor, end],
      );
    }
    const report = await stats(db);
    expect(report.usage.openSessions).toBe(1);
    expect(report.usage.lifetimeConversations).toBe(7);
    expect(report.usage.silent).toEqual({ neverAnswered: 0, quiet: 1 });
    expect(formatStats(report)).toContain('sessions held 1');
  });

  it('ranks top stores by answers with spend over the same window (10.10)', async () => {
    const db = await freshDb();
    const first = await addStore(db, { tier: 'growth' });
    await addActivity(db, first, TODAY, { answers: 9, conversations: 3, carts: 1 });
    await addSpend(db, first, TODAY, '1.5');
    await addSpend(db, first, TODAY - 30, '100');
    const second = await addStore(db);
    await addActivity(db, second, TODAY - 2, { answers: 4 });
    await addActivity(db, second, TODAY - 30, { answers: 100 });
    const report = await stats(db);
    expect(report.usage.top).toEqual([
      { owner: first, tier: 'growth', conversations: 3, answers: 9, carts: 1, spentUsd: '1.5' },
      { owner: second, tier: 'starter', conversations: 0, answers: 4, carts: 0, spentUsd: '0' },
    ]);
  });

  it('counts connectors per platform and lists enabled failing ones with ms times (16, 10.1)', async () => {
    const db = await freshDb();
    const lastRunMs = Date.UTC(2026, 10, 20, 9);
    const rows: [string, boolean, string | null][] = [
      ['error', true, '401 Unauthorized at https://merchant.example'],
      ['error', false, 'disabled'],
      ['ok', true, null],
    ];
    const failing: string[] = [];
    for (const [status, enabled, message] of rows) {
      const owner = await addStore(db);
      failing.push(owner);
      await db.query(
        `insert into connectors (owner, platform, url, import_policies, enabled, last_status,
           last_run_at, next_run_at)
         values ($1, 'shopify', 'https://merchant.example', false, $2, $3, $4, $4)`,
        [owner, enabled, JSON.stringify({ status, message }), lastRunMs],
      );
    }
    const report = await stats(db);
    expect(report.usage.connectors).toEqual([
      { platform: 'shopify', enabled: false, count: 1 },
      { platform: 'shopify', enabled: true, count: 2 },
    ]);
    expect(report.health.connectorsFailing).toEqual([
      {
        owner: failing[0],
        platform: 'shopify',
        status: 'error',
        message: '401 Unauthorized at https://merchant.example',
        lastRunAtMs: lastRunMs,
      },
    ]);
    expect(formatStats(report)).toContain(
      'shopify error: 401 Unauthorized at https://merchant.example (2026-11-20 09:00 UTC)',
    );
  });
});

describe('stats: cost and budget', () => {
  it('splits spend into today, MTD and last month, without reservations (10)', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    await addSpend(db, store, MONTH - 1, '4', '9');
    await addSpend(db, store, MONTH, '2', '9');
    await addSpend(db, store, TODAY, '1', '9');
    await addSpend(db, store, MONTH - 32, '50');
    const report = await stats(db);
    expect(report.cost.todayUsd).toBe('1');
    expect(report.cost.monthToDateUsd).toBe('3');
    expect(report.cost.lastMonthUsd).toBe('4');
  });

  it('takes last month in January as the previous December (10.18)', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    const january = Date.UTC(2027, 0, 10, 12) / 1000;
    const december1 = Date.UTC(2026, 11, 1) / 1000 / DAY;
    await addSpend(db, store, december1, '5');
    await addSpend(db, store, december1 - 1, '70');
    await addSpend(db, store, december1 + 31, '1');
    const report = await stats(db, {}, january);
    expect(report.cost.lastMonthUsd).toBe('5');
    expect(report.cost.monthToDateUsd).toBe('1');
  });

  it('groups spend by current tier with a no plan now row, and gross margin from MRR (10.17, 10.21)', async () => {
    const db = await freshDb();
    const paying = await addStore(db);
    await addSubscription(db, paying);
    await addSpend(db, paying, MONTH - 1, '4');
    const free = await addStore(db, { tier: 'free', planSource: 'free' });
    await addSpend(db, free, MONTH, '2');
    const lapsed = await addStore(db, { status: 'pending', tier: null });
    await addSpend(db, lapsed, TODAY, '1');
    const report = await stats(db, { prices: loaded(price('starter', 'month', 2900)) });
    expect(report.cost.byPlan).toEqual([
      { tier: 'free', monthToDateUsd: '2', lastMonthUsd: '0', mrrUsd: null, grossMarginUsd: '0' },
      {
        tier: 'starter',
        monthToDateUsd: '0',
        lastMonthUsd: '4',
        mrrUsd: '29',
        grossMarginUsd: '25',
      },
      { tier: null, monthToDateUsd: '1', lastMonthUsd: '0', mrrUsd: null, grossMarginUsd: '0' },
    ]);
    const text = formatStats(report);
    expect(text).toContain('gross margin (before tax and Stripe fees)');
    expect(lineOf(text, 'no plan now')).toContain('$1.00');
    const unpriced = await stats(db);
    expect(unpriced.cost.byPlan.find((row) => row.tier === 'starter')?.grossMarginUsd).toBeNull();
  });

  it('gives a plan no MRR or margin when one of its sold intervals has no usable price', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db, { tier: 'growth' }), {
      plan: 'growth',
      interval: 'month',
    });
    await addSubscription(db, await addStore(db, { tier: 'growth' }), {
      plan: 'growth',
      interval: 'year',
    });
    const report = await stats(db, { prices: loaded(price('growth', 'year', 94800)) });
    expect(report.revenue.mrrUsd).toBe('79');
    expect(report.cost.byPlan).toEqual([
      {
        tier: 'growth',
        monthToDateUsd: '0',
        lastMonthUsd: '0',
        mrrUsd: null,
        grossMarginUsd: null,
      },
    ]);
  });

  it('gives cost per conversation, and n/a with no conversation instead of Infinity (20)', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    await addSpend(db, store, TODAY, '1');
    const none = await stats(db);
    expect(none.cost.perConversationUsd).toBeNull();
    expect(formatStats(none)).toContain('per conversation (MTD) n/a');
    await addActivity(db, store, TODAY, { conversations: 3 });
    const some = await stats(db);
    expect(some.cost.perConversationUsd).toBe('0.33333333333333333333');
    expect(formatStats(some)).toContain('per conversation (MTD) $0.3333');
  });

  it('calls a store near at 8000 bps, not at 7999.6, and paused with its reservations (11)', async () => {
    const db = await freshDb();
    const near = await addStore(db);
    await addSpend(db, near, TODAY, '8');
    const almost = await addStore(db);
    await addSpend(db, almost, TODAY, '7.9996');
    const justBelow = await addStore(db);
    await addSpend(db, justBelow, TODAY, '7.999');
    const paused = await addStore(db);
    await addSubscription(db, paused);
    await addSpend(db, paused, TODAY - 1, '9.99');
    await addSpend(db, paused, TODAY, '0', '0.01');
    const report = await stats(db);
    expect(report.health.budget.near).toEqual([{ owner: near, tier: 'starter', bps: 8000 }]);
    expect(report.health.budget.paused).toEqual([{ owner: paused, tier: 'starter', paying: true }]);
    const text = formatStats(report);
    expect(text).toContain('of the current budget period');
    expect(text).toContain(`paused ${nip19.npubEncode(paused)} starter (paying)`);
  });

  it('leaves pending and suspended stores out of the budget lines (12)', async () => {
    const db = await freshDb();
    const suspended = await addStore(db, { status: 'suspended' });
    await addSpend(db, suspended, TODAY, '20');
    const pending = await addStore(db, { status: 'pending', tier: 'starter', planSource: null });
    await addSpend(db, pending, TODAY, '20');
    const report = await stats(db);
    expect(report.health.budget).toEqual({ paused: [], near: [] });
  });

  it('counts a billing store s budget from its billing date, calendar MTD unchanged (10.2)', async () => {
    const db = await freshDb();
    const anchored = await addStore(db);
    await addSubscription(db, anchored, { anchor: Date.UTC(2026, 9, 15, 8) / 1000 });
    await addSpend(db, anchored, MONTH + 9, '5');
    await addSpend(db, anchored, MONTH + 16, '3');
    // The same spend on an operator store: the calendar month counts it all.
    const calendar = await addStore(db, { planSource: 'operator' });
    await addSubscription(db, calendar, { anchor: Date.UTC(2026, 9, 15, 8) / 1000 });
    await addSpend(db, calendar, MONTH + 9, '5');
    await addSpend(db, calendar, MONTH + 16, '3');
    const report = await stats(db);
    expect(report.health.budget.near).toEqual([{ owner: calendar, tier: 'starter', bps: 8000 }]);
    expect(report.cost.monthToDateUsd).toBe('16');
  });
});

describe('stats: health', () => {
  it('lists failed and interrupted catalog syncs as the server reads them (17, 10.13)', async () => {
    const db = await freshDb();
    const rows: [string, string | null, number, string | null][] = [
      ['running', 'h1', NOW - 1, null],
      ['running', 'h2', NOW + 60, null],
      ['running', null, NOW + 60, null],
      ['failed', null, 0, 'feed at https://merchant.example/feed 404'],
      ['done', null, 0, null],
    ];
    const owners: string[] = [];
    for (const [state, holder, expiresAt, error] of rows) {
      const owner = await addStore(db);
      owners.push(owner);
      await db.query(
        `insert into catalog_syncs (owner, holder, expires_at, state, error, started_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [owner, holder, expiresAt, state, error, NOW - 600],
      );
    }
    const report = await stats(db);
    expect(report.health.catalogSyncs).toEqual(
      [
        { owner: owners[0], state: 'interrupted', error: null, at: NOW - 600 },
        { owner: owners[2], state: 'interrupted', error: null, at: NOW - 600 },
        {
          owner: owners[3],
          state: 'failed',
          error: 'feed at https://merchant.example/feed 404',
          at: NOW - 600,
        },
      ].sort((left, right) => (left.owner ?? '').localeCompare(right.owner ?? '')),
    );
    expect(lineOf(formatStats(report), 'catalog')).toBe('catalog     failed 1  interrupted 2');
  });

  it('splits unpublished store events into gave up and backlog (18)', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    const suspended = await addStore(db, { status: 'suspended' });
    const events: [string, string, boolean, number][] = [
      ['e1', store, false, 8],
      ['e2', store, false, 7],
      ['e3', store, true, 8],
      ['e4', suspended, false, 3],
      ['e5', suspended, false, 9],
    ];
    for (const [id, owner, published, failures] of events) {
      await db.query(
        `insert into store_events (id, owner, event, published, publish_failures)
         values ($1, $2, '{}', $3, $4)`,
        [id, owner, published, failures],
      );
    }
    const report = await stats(db);
    expect(report.health.storeEvents).toEqual(
      [
        { owner: store, gaveUp: 1, backlog: 1 },
        { owner: suspended, gaveUp: 1, backlog: 0 },
      ].sort((left, right) => left.owner.localeCompare(right.owner)),
    );
  });
});

async function richDb(email: string): Promise<Db> {
  const db = await freshDb();
  const store = await addStore(db, { email, tier: 'growth' });
  await addOrigin(db, store);
  await addSubscription(db, store, { plan: 'growth', status: 'past_due' });
  await addActivity(db, store, TODAY, { answers: 3, conversations: 2, carts: 1 });
  await addSpend(db, store, TODAY, '9.5', '0.6');
  await db.query(
    `insert into connectors (owner, platform, url, import_policies, enabled, last_status)
     values ($1, 'woocommerce', 'https://merchant.example', false, true, $2)`,
    [store, JSON.stringify({ status: 'error', message: 'secret merchant detail' })],
  );
  await db.query(
    `insert into catalog_syncs (owner, state, error, started_at) values ($1, 'failed', $2, $3)`,
    [store, 'sync error detail', NOW - 60],
  );
  await addStore(db, { status: 'pending', email: `second-${email}` });
  return db;
}

describe('stats: output', () => {
  it('prints in text what the JSON has, money as strings (21)', async () => {
    const db = await richDb('owner@shop.example');
    const report = await stats(db, { prices: loaded(price('growth', 'month', 9900)) });
    const json = JSON.parse(JSON.stringify(statsJson(report))) as OperatorStats;
    expect(json.revenue.mrrUsd).toBe('99');
    expect(typeof json.revenue.mrrCoreUsd).toBe('string');
    expect(typeof json.cost.monthToDateUsd).toBe('string');
    expect(typeof json.usage.top[0]?.spentUsd).toBe('string');
    expect(json.schemaVersion).toBe(1);
    const text = formatStats(report);
    expect(text).toContain(`est. MRR $99.00`);
    expect(text).toContain(`STORES        ${json.stores.total} total`);
    expect(json.cost.monthToDateUsd).toBe('9.5');
    expect(text).toContain('MTD $9.50');
    expect(text).toContain(nip19.npubEncode(json.revenue.pastDue[0] ?? ''));
  });

  it('never prints a contact email, and leaves connector messages and sync errors out of the JSON (22, 10.22)', async () => {
    const email = 'owner@shop.example';
    const db = await richDb(email);
    const report = await stats(db);
    const json = JSON.stringify(statsJson(report));
    const text = formatStats(report);
    expect(json).not.toContain('shop.example');
    expect(text).not.toContain('shop.example');
    expect(json).not.toContain('secret merchant detail');
    expect(json).not.toContain('sync error detail');
    expect(json).not.toContain('"message":');
    expect(json).not.toContain('"error":');
    expect(text).toContain('secret merchant detail');
    expect(text).toContain('sync error detail');
  });
});

/** A `Db` that records every statement its transactions run. */
function recording(db: Db): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const wrap = (tx: Queryable): Queryable => ({
    query: (sql, params) => {
      statements.push(sql);
      return tx.query(sql, params);
    },
    script: (sql) => tx.script(sql),
  });
  return {
    statements,
    db: { ...db, transaction: (work) => db.transaction((tx) => work(wrap(tx))) },
  };
}

const TABLES = [
  'stores',
  'tiers',
  'store_days',
  'activity_days',
  'store_totals',
  'store_origins',
  'billing_subscriptions',
  'billing_checkouts',
  'stripe_events',
  'connectors',
  'catalog_syncs',
  'store_events',
  'sessions',
];

async function rowCounts(db: Db): Promise<number[]> {
  const counts: number[] = [];
  for (const table of TABLES) {
    const [row] = await db.query<{ count: number }>(`select count(*)::int8 as count from ${table}`);
    counts.push(row?.count ?? -1);
  }
  return counts;
}

describe('stats: a harmless snapshot (23)', () => {
  it('writes nothing, and opens a read-only repeatable-read transaction with timeouts', async () => {
    const base = await richDb('a@b.example');
    const before = await rowCounts(base);
    const { db, statements } = recording(base);
    await stats(db, { prices: loaded() });
    expect(await rowCounts(base)).toEqual(before);
    expect(statements.slice(0, 4)).toEqual([
      'set transaction isolation level repeatable read, read only',
      "set local statement_timeout = '10s'",
      "set local lock_timeout = '2s'",
      "set local idle_in_transaction_session_timeout = '10s'",
    ]);
    // Read only for real: the same transaction refuses a write.
    await expect(
      base.transaction(async (tx) => {
        await tx.query(statements[0] ?? '');
        await tx.query('delete from stores');
      }),
    ).rejects.toThrow(/read-only/u);
  });
});

describe('stats: the CLI (24)', () => {
  async function cli(args: string[], loadPrices?: () => Promise<PriceSource>) {
    const db = await freshDb();
    await addSubscription(db, await addStore(db));
    const directory = new StoreDirectory(db, new KeyVault(MASTER_KEY));
    return runCli(args, {
      directory,
      db,
      freeTier: FREE,
      now: () => NOW,
      ...(loadPrices === undefined ? {} : { loadPrices }),
    });
  }

  it('refuses bad flags', async () => {
    await expect(cli(['stats', '--days', '0'])).rejects.toThrow('--days must be');
    await expect(cli(['stats', '--days', '366'])).rejects.toThrow('--days must be');
    await expect(cli(['stats', '--days', 'x'])).rejects.toThrow('--days must be');
    await expect(cli(['stats', '--days', '01'])).rejects.toThrow('--days must be');
    await expect(cli(['stats', '--json', '--json'])).rejects.toThrow('--json is given twice');
    await expect(cli(['stats', '--days', '3', '--days', '4'])).rejects.toThrow('given twice');
    await expect(cli(['stats', '--verbose', '1'])).rejects.toThrow('Unknown flag --verbose');
    await expect(cli(['stats', '--days'])).rejects.toThrow('Bad arguments');
  });

  it('prints the text report alone, JSON with --json, the window from --days', async () => {
    expect(await cli(['stats'])).toContain('Askr stats  2026-11-20 12:00 UTC   window 30 d');
    expect(await cli(['stats', '--days', '365'])).toContain('window 365 d');
    const json = JSON.parse(await cli(['stats', '--json', '--days', '7'])) as OperatorStats;
    expect(json.windowDays).toBe(7);
    expect(json.revenue.paying).toHaveLength(1);
    expect(CLI_USAGE).toContain('askr-server stats [--days <n>] [--json]');
  });

  it('prints the report when the price read fails, with the reason', async () => {
    const text = await cli(['stats'], async () => {
      throw new Error('Stripe is down');
    });
    expect(text).toContain('n/a (Stripe price read failed: Stripe is down)');
    expect(text).toContain('HEALTH');
    expect(await cli(['stats'])).toContain('n/a (billing is off)');
  });

  it('loads the prices before the snapshot opens', async () => {
    const base = await freshDb();
    const { db, statements } = recording(base);
    let seenAtLoad = -1;
    await runCli(['stats'], {
      directory: new StoreDirectory(base, new KeyVault(MASTER_KEY)),
      db,
      now: () => NOW,
      loadPrices: async () => {
        seenAtLoad = statements.length;
        return loaded();
      },
    });
    expect(seenAtLoad).toBe(0);
    expect(statements.length).toBeGreaterThan(0);
  });
});

describe('free text from the database in the text report', () => {
  it('never lets a shop drive the terminal: control characters replaced, length capped', () => {
    expect(printable('401 \u001b[2J\u001b]0;owned\u0007 Unauthorized\r\n\u009b31m')).toBe(
      '401 ?[2J?]0;owned? Unauthorized???31m',
    );
    expect(printable('plain text, unchanged')).toBe('plain text, unchanged');
    const long = 'x'.repeat(500);
    expect(printable(long)).toBe(`${'x'.repeat(200)}...`);
  });

  it('prints a failing connector message from a shop through it', async () => {
    const db = await freshDb();
    const owner = await addStore(db);
    await db.query(
      `insert into connectors (owner, platform, url, import_policies, enabled, last_status,
         last_run_at, next_run_at)
       values ($1, 'shopify', 'https://merchant.example', false, true, $2, $3, $3)`,
      [
        owner,
        JSON.stringify({ status: 'error', message: 'bad \u001b[2J gateway' }),
        Date.UTC(2026, 10, 20, 9),
      ],
    );
    const text = formatStats(await stats(db));
    expect(text).toContain('shopify error: bad ?[2J gateway');
    expect(text).not.toContain('\u001b');
  });
});

describe('stats: review round', () => {
  it('prints cancelling MRR as n/a without Stripe prices and as a lower bound when partial', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), { cancelAtPeriodEnd: true });
    const off = await stats(db);
    expect(off.revenue.cancelling).toMatchObject({ count: 1, mrrUsd: '0', partial: true });
    expect(lineOf(formatStats(off), 'cancelling')).toContain('1 (n/a at risk');
    expect(lineOf(formatStats(off), 'core')).toBe('core        excl. past due / cancelling n/a');
    await addSubscription(db, await addStore(db, { tier: 'growth' }), {
      plan: 'growth',
      cancelAtPeriodEnd: true,
    });
    const partial = await stats(db, { prices: loaded(price('starter', 'month', 2900)) });
    expect(partial.revenue.cancelling).toMatchObject({ count: 2, mrrUsd: '29', partial: true });
    expect(lineOf(formatStats(partial), 'cancelling')).toContain('2 (>= $29.00 at risk');
  });

  it('takes the earliest end of several cancelling subscriptions', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: NOW + 9 * DAY,
    });
    await addSubscription(db, await addStore(db), {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: NOW + 4 * DAY,
    });
    expect((await stats(db)).revenue.cancelling.firstEndsAt).toBe(NOW + 4 * DAY);
  });

  it('gives no margin to a tier billed outside Stripe, and keeps Free s cost as its margin', async () => {
    const db = await freshDb();
    const enterprise = await addStore(db, { tier: 'enterprise', planSource: 'operator' });
    await addSpend(db, enterprise, MONTH - 1, '40');
    const free = await addStore(db, { tier: 'free', planSource: 'free' });
    await addSpend(db, free, MONTH - 1, '3');
    const report = await stats(db, { prices: loaded() });
    expect(report.cost.byPlan).toEqual([
      {
        tier: 'enterprise',
        monthToDateUsd: '0',
        lastMonthUsd: '40',
        mrrUsd: null,
        grossMarginUsd: null,
      },
      { tier: 'free', monthToDateUsd: '0', lastMonthUsd: '3', mrrUsd: null, grossMarginUsd: '-3' },
    ]);
    expect(lineOf(formatStats(report), 'enterprise')).toMatch(/\$40\.00\s+-\s+n\/a$/u);
  });

  it('leaves an operator-managed store with a live subscription out of the operator line', async () => {
    const db = await freshDb();
    const charged = await addStore(db, { tier: 'starter', planSource: 'operator' });
    await addSubscription(db, charged);
    await addStore(db, { tier: 'enterprise', planSource: 'operator' });
    const report = await stats(db);
    expect(report.revenue.operatorManaged).toEqual([{ tier: 'enterprise', count: 1 }]);
    expect(report.revenue.integrity).toEqual([{ owner: charged, problem: 'operator_managed' }]);
  });

  it('flags a live subscription on a store with no plan source or a Free source', async () => {
    const db = await freshDb();
    const noSource = await addStore(db, { planSource: null });
    await addSubscription(db, noSource);
    const freeSource = await addStore(db, { planSource: 'free' });
    await addSubscription(db, freeSource);
    const report = await stats(db);
    expect(report.revenue.integrity).toEqual(
      [
        { owner: noSource, problem: 'operator_managed' },
        { owner: freeSource, problem: 'tier_mismatch' },
      ].sort((left, right) => left.owner.localeCompare(right.owner)),
    );
  });

  it('runs the migrations before every command but stats', () => {
    expect(migratesFirst(['stats', '--json'])).toBe(false);
    expect(migratesFirst(['stats'])).toBe(false);
    expect(migratesFirst([])).toBe(true);
    expect(migratesFirst(['store', 'list'])).toBe(true);
    expect(migratesFirst(['tier', 'set', 'stats'])).toBe(true);
  });

  it('prints a Stripe failure message through printable', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db));
    const text = formatStats(
      await stats(db, { prices: { kind: 'failed', message: 'down \u001b[2J‮ now' } }),
    );
    expect(text).toContain('n/a (Stripe price read failed: down ?[2J? now)');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('‮');
  });

  it('replaces zero-width and bidi controls, and never cuts a surrogate pair', () => {
    expect(printable('a​b‏c‪d‮e⁦f⁩g﻿h')).toBe('a?b?c?d?e?f?g?h');
    expect(printable('a b')).toBe('a b');
    const emoji = '\u{1F600}';
    expect(printable(`${'x'.repeat(199)}${emoji}${emoji}`)).toBe(`${'x'.repeat(199)}${emoji}...`);
    expect(printable(emoji.repeat(200))).toBe(emoji.repeat(200));
  });

  it('prints a catalog sync error containing ESC through printable', async () => {
    const db = await freshDb();
    const owner = await addStore(db);
    await db.query(
      `insert into catalog_syncs (owner, state, error, started_at) values ($1, 'failed', $2, $3)`,
      [owner, 'feed \u001b]0;owned\u0007 down', NOW - 60],
    );
    const text = formatStats(await stats(db));
    expect(text).toContain(`${nip19.npubEncode(owner)} failed: feed ?]0;owned? down`);
    expect(text).not.toContain('\u001b');
  });

  it('reads a price with no tax behavior as unspecified, and a live subscription with no interval as unpriced', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db));
    await addSubscription(db, await addStore(db, { tier: 'pro' }), { plan: 'pro', interval: null });
    const report = await stats(db, {
      prices: loaded(price('starter', 'month', 2900, { taxBehavior: null })),
    });
    expect(report.revenue.taxBehavior).toBe('unspecified');
    expect(report.revenue.mrrUnavailable).toEqual([
      { plan: 'pro', interval: null, reason: 'no billing interval stored' },
    ]);
  });

  it('lists only past due subscriptions as past due, trialing not', async () => {
    const db = await freshDb();
    await addSubscription(db, await addStore(db), { status: 'trialing' });
    const late = await addStore(db);
    await addSubscription(db, late, { status: 'past_due' });
    expect((await stats(db)).revenue.pastDue).toEqual([late]);
  });

  it('keeps a pending store with settings at exactly three days off the stale list', async () => {
    const db = await freshDb();
    const store = await addStore(db, { status: 'pending', createdAt: NOW - 3 * DAY });
    await addOrigin(db, store);
    expect((await stats(db)).stores.waiting).toEqual({ count: 1, stale: [] });
  });

  it('bounds the 7 d and window activity by day', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    await addActivity(db, store, TODAY - 7, { answers: 5, links: 2 });
    await addActivity(db, store, TODAY - 20, { links: 3 });
    const report = await stats(db);
    expect(report.usage.activity.days7).toEqual({
      conversations: 0,
      answers: 0,
      links: 0,
      carts: 0,
    });
    expect(report.usage.activity.window.links).toBe(5);
    expect(report.usage.activeStores).toEqual({ days7: 0, window: 1 });
  });

  it('counts only active stores as silent', async () => {
    const db = await freshDb();
    await addStore(db, { status: 'suspended' });
    await addStore(db, { status: 'pending' });
    await addStore(db);
    expect((await stats(db)).usage.silent).toEqual({ neverAnswered: 1, quiet: 0 });
  });

  it('ranks top stores by answers, not conversations', async () => {
    const db = await freshDb();
    const talkative = await addStore(db);
    await addActivity(db, talkative, TODAY, { conversations: 50, answers: 2 });
    const answering = await addStore(db);
    await addActivity(db, answering, TODAY, { conversations: 1, answers: 9 });
    expect((await stats(db)).usage.top.map((store) => store.owner)).toEqual([answering, talkative]);
  });

  it('keeps yesterday out of today s spend, and counts the month s first day in MTD conversations', async () => {
    const db = await freshDb();
    const store = await addStore(db);
    await addSpend(db, store, TODAY - 1, '2');
    await addSpend(db, store, TODAY, '1');
    await addActivity(db, store, MONTH, { conversations: 4 });
    await addActivity(db, store, MONTH - 1, { conversations: 100 });
    const report = await stats(db);
    expect(report.cost.todayUsd).toBe('1');
    expect(report.cost.perConversationUsd).toBe('0.75');
  });
});
