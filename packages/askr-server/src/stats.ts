import Decimal from 'decimal.js-light';
import { nip19 } from 'nostr-tools';
import type { BillingInterval, PlanPrice } from './billing/stripe';
import type { FreeTier } from './config';
import type { Db, Queryable } from './db/db';
import { SECS_PER_DAY, monthStartDay, utcDay, windowOf } from './state/budget-window';
import {
  LIVE_STATUSES,
  SUBSCRIPTION_ORDER,
  planSubscriptionsWhereFor,
} from './state/plan-subscription';
import { MAX_PUBLISH_ATTEMPTS } from './state/stores';

/** A store's monthly budget share at or past which the report calls it near its budget. */
export const NEAR_BUDGET_BPS = 8000;
/** A pending store with settings older than this is listed as waiting too long. */
export const PENDING_STALE_SECS = 3 * SECS_PER_DAY;
/** A live subscription this far past its period end means we missed its renewal or end. */
export const STALE_SUBSCRIPTION_SECS = SECS_PER_DAY;
export const TOP_STORES = 10;
export const DEFAULT_STATS_DAYS = 30;
export const MAX_STATS_DAYS = 365;

const STATS_SCHEMA_VERSION = 1;
/** Free text from the database (a shop's error, a platform name) printed to a terminal is cut to this. */
const MAX_PRINTED_TEXT = 200;
/**
 * C0 and C1 control characters (ESC among them), and the zero-width and bidirectional controls
 * that make text read other than it is, as inclusive code point ranges: a shop's text must not
 * drive the operator's terminal.
 */
const CONTROL_CODE_POINTS: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isControl(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return CONTROL_CODE_POINTS.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/**
 * A value from the database as the text report prints it: control characters replaced, length
 * capped in code points (never half a surrogate pair).
 */
export function printable(text: string): string {
  const codePoints = Array.from(text, (character) => (isControl(character) ? '?' : character));
  return codePoints.length > MAX_PRINTED_TEXT
    ? `${codePoints.slice(0, MAX_PRINTED_TEXT).join('')}...`
    : codePoints.join('');
}
const RECENT_DAYS = 7;
const FULL_BPS = 10_000;
const MS_PER_SEC = 1000;
const MONTHS_PER_YEAR = 12;
const USD_DECIMALS = 2;
const PER_CONVERSATION_DECIMALS = 4;
/** Subscription states that end a plan for good, as churn counts them. */
const ENDED_STATUSES: readonly string[] = ['canceled', 'unpaid'];

/** What the plan prices came to: billing off, the Stripe read failed, or the prices read. */
export type PriceSource =
  | { kind: 'off' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; prices: readonly PlanPrice[] };

export interface StatsOptions {
  /** The "recent" window in days (1 to `MAX_STATS_DAYS`). */
  days: number;
  freeTier: FreeTier | undefined;
  prices: PriceSource;
}

type PlanSource = 'operator' | 'free' | 'billing';
type IntegrityProblem =
  | 'operator_managed'
  | 'store_not_active'
  | 'tier_mismatch'
  | 'billing_without_subscription';

interface ActivityTotals {
  conversations: number;
  answers: number;
  links: number;
  carts: number;
}

/**
 * The operator's report, one snapshot. Owners are hex, money is a decimal string in USD, times
 * are Unix seconds except connector times (`...Ms`, as the scheduler stores them). Connector
 * messages and catalog sync errors are here for the text report only: `statsJson` drops them.
 */
export interface OperatorStats {
  schemaVersion: typeof STATS_SCHEMA_VERSION;
  generatedAt: number;
  windowDays: number;
  stores: {
    total: number;
    byStatus: { pending: number; active: number; suspended: number };
    byPlan: { tier: string; source: PlanSource; status: 'active' | 'suspended'; count: number }[];
    new: { days7: number; window: number };
    free: {
      tier: string;
      last24h: number;
      perDay: number;
      active: number;
      maxActive: number;
      last7d: number;
    } | null;
    funnel: { created: number; configured: number; onPlan: number; talked: number; paying: number };
    waiting: { count: number; stale: { owner: string; createdAt: number }[] };
    checkoutOpenedNotPaying: number;
  };
  revenue: {
    priceSource: 'stripe' | 'off' | 'failed';
    paying: {
      plan: string;
      interval: BillingInterval | null;
      count: number;
      mrrUsd: string | null;
    }[];
    /** Lower bounds when `mrrPartial`: the sold plans without a usable price are left out. */
    mrrUsd: string;
    mrrCoreUsd: string;
    mrrPartial: boolean;
    mrrUnavailable: { plan: string; interval: BillingInterval | null; reason: string }[];
    taxBehavior: 'inclusive' | 'exclusive' | 'unspecified' | 'mixed' | null;
    newPaid: number;
    churned: number;
    /** `partial`: a cancelling subscription has no usable price, so `mrrUsd` is a lower bound. */
    cancelling: { count: number; mrrUsd: string; partial: boolean; firstEndsAt: number | null };
    pastDue: string[];
    scheduled: {
      owner: string;
      from: string;
      to: string | null;
      interval: BillingInterval | null;
      at: number;
    }[];
    operatorManaged: { tier: string; count: number }[];
    integrity: { owner: string; problem: IntegrityProblem }[];
  };
  usage: {
    activeStores: { days7: number; window: number };
    activity: { days7: ActivityTotals; window: ActivityTotals };
    lifetimeConversations: number;
    openSessions: number;
    silent: { neverAnswered: number; quiet: number };
    configuredNeverTalked: number;
    connectors: { platform: string; enabled: boolean; count: number }[];
    top: {
      owner: string;
      tier: string | null;
      conversations: number;
      answers: number;
      carts: number;
      spentUsd: string;
    }[];
  };
  cost: {
    todayUsd: string;
    monthToDateUsd: string;
    lastMonthUsd: string;
    perConversationUsd: string | null;
    /** `tier` null: stores with no plan now (pending, lapsed), so the rows sum to the totals. */
    byPlan: {
      tier: string | null;
      monthToDateUsd: string;
      lastMonthUsd: string;
      mrrUsd: string | null;
      grossMarginUsd: string | null;
    }[];
  };
  health: {
    budget: {
      paused: { owner: string; tier: string; paying: boolean }[];
      near: { owner: string; tier: string; bps: number }[];
    };
    connectorsFailing: {
      owner: string;
      platform: string;
      status: string;
      message: string | null;
      lastRunAtMs: number | null;
    }[];
    catalogSyncs: {
      owner: string;
      state: 'failed' | 'interrupted';
      error: string | null;
      at: number | null;
    }[];
    storeEvents: { owner: string; gaveUp: number; backlog: number }[];
    staleSubscriptions: { owner: string; currentPeriodEnd: number }[];
    stripe: { lastEventAt: number | null; events7d: number } | null;
  };
}

/** The UTC day number the calendar month before `now`'s starts on (January -> December). */
export function previousMonthStartDay(now: number): number {
  const date = new Date(now * MS_PER_SEC);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / (SECS_PER_DAY * MS_PER_SEC);
}

function usdOfMinor(unitAmount: number): Decimal {
  return new Decimal(unitAmount).div(new Decimal(10).pow(USD_DECIMALS));
}

/** One subscription's monthly amount, full precision: a yearly price over twelve months. */
function monthlyUsd(price: PlanPrice): Decimal {
  const amount = usdOfMinor(price.unitAmount ?? 0);
  return price.interval === 'year' ? amount.div(MONTHS_PER_YEAR) : amount;
}

/** The price of a plan and interval, or why it cannot price a subscription. */
function priceFor(
  source: PriceSource,
  plan: string,
  interval: BillingInterval | null,
): PlanPrice | { reason: string } {
  if (source.kind === 'off') {
    return { reason: 'billing is off' };
  }
  if (source.kind === 'failed') {
    return { reason: `Stripe price read failed: ${source.message}` };
  }
  if (interval === null) {
    return { reason: 'no billing interval stored' };
  }
  const price = source.prices.find(
    (candidate) => candidate.plan === plan && candidate.interval === interval,
  );
  if (price === undefined) {
    return { reason: 'no Stripe price' };
  }
  if (price.unitAmount === null) {
    return { reason: 'the Stripe price has no fixed amount' };
  }
  if (price.currency !== 'usd') {
    return { reason: `the Stripe price is in ${price.currency.toUpperCase()}, not USD` };
  }
  return price;
}

interface PlanRow extends Record<string, unknown> {
  owner: string;
  plan_source: PlanSource | null;
  store_status: string;
  tier: string | null;
  plan: string;
  interval: BillingInterval | null;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number | null;
  scheduled_plan: string | null;
  scheduled_interval: BillingInterval | null;
  scheduled_at: number | null;
  stripe_created: number;
}

function integrityProblem(row: PlanRow): IntegrityProblem | undefined {
  if ((row.plan_source ?? 'operator') === 'operator') {
    return 'operator_managed';
  }
  if (row.store_status !== 'active') {
    return 'store_not_active';
  }
  if (row.plan_source !== 'billing' || row.tier !== row.plan) {
    return 'tier_mismatch';
  }
  return undefined;
}

async function storeSection(
  tx: Queryable,
  now: number,
  options: StatsOptions,
): Promise<OperatorStats['stores']> {
  const [counts] = await tx.query<{
    total: number;
    pending: number;
    active: number;
    suspended: number;
    new_7: number;
    new_window: number;
    configured: number;
    on_plan: number;
    talked: number;
    paying: number;
  }>(
    `select count(*)::int8 as total,
       count(*) filter (where status = 'pending')::int8 as pending,
       count(*) filter (where status = 'active')::int8 as active,
       count(*) filter (where status = 'suspended')::int8 as suspended,
       count(*) filter (where created_at > $1)::int8 as new_7,
       count(*) filter (where created_at > $2)::int8 as new_window,
       count(*) filter (where exists (select 1 from store_origins o where o.owner = s.owner))::int8
         as configured,
       count(*) filter (where tier is not null)::int8 as on_plan,
       count(*) filter (where exists (select 1 from store_totals t
                                      where t.owner = s.owner and t.conversations > 0))::int8
         as talked,
       count(*) filter (where exists (select 1 from billing_subscriptions
                                      where ${planSubscriptionsWhereFor('s.owner', '$3')}))::int8
         as paying
     from stores s`,
    [now - RECENT_DAYS * SECS_PER_DAY, now - options.days * SECS_PER_DAY, LIVE_STATUSES],
  );
  const byPlan = await tx.query<{
    tier: string;
    source: PlanSource;
    status: 'active' | 'suspended';
    count: number;
  }>(
    `select tier, coalesce(plan_source, 'operator') as source, status, count(*)::int8 as count
     from stores where tier is not null and status in ('active', 'suspended')
     group by 1, 2, 3 order by 1, 2, 3`,
  );
  let free: OperatorStats['stores']['free'] = null;
  if (options.freeTier !== undefined) {
    // The same counts as `freeCapacityReached`: a rolling 24 h, and self-serve stores active on Free.
    const [freeCounts] = await tx.query<{ last_24h: number; last_7d: number; active: number }>(
      `select count(*) filter (where auto_activated_at > $1)::int8 as last_24h,
         count(*) filter (where auto_activated_at > $2)::int8 as last_7d,
         count(*) filter (where status = 'active' and tier = $3
                          and auto_activated_at is not null)::int8 as active
       from stores`,
      [now - SECS_PER_DAY, now - RECENT_DAYS * SECS_PER_DAY, options.freeTier.tier],
    );
    free = {
      tier: options.freeTier.tier,
      last24h: freeCounts?.last_24h ?? 0,
      perDay: options.freeTier.perDay,
      active: freeCounts?.active ?? 0,
      maxActive: options.freeTier.maxActive,
      last7d: freeCounts?.last_7d ?? 0,
    };
  }
  const waiting = await tx.query<{ owner: string; created_at: number }>(
    `select owner, created_at from stores s
     where status = 'pending' and tier is null
       and exists (select 1 from store_origins o where o.owner = s.owner)
     order by created_at, owner`,
  );
  const [checkouts] = await tx.query<{ count: number }>(
    `select count(*)::int8 as count from billing_checkouts c
     where c.created_at > $1
       and not exists (select 1 from billing_subscriptions
                       where ${planSubscriptionsWhereFor('c.owner', '$2')})`,
    [now - options.days * SECS_PER_DAY, LIVE_STATUSES],
  );
  return {
    total: counts?.total ?? 0,
    byStatus: {
      pending: counts?.pending ?? 0,
      active: counts?.active ?? 0,
      suspended: counts?.suspended ?? 0,
    },
    byPlan,
    new: { days7: counts?.new_7 ?? 0, window: counts?.new_window ?? 0 },
    free,
    funnel: {
      created: counts?.total ?? 0,
      configured: counts?.configured ?? 0,
      onPlan: counts?.on_plan ?? 0,
      talked: counts?.talked ?? 0,
      paying: counts?.paying ?? 0,
    },
    waiting: {
      count: waiting.length,
      stale: waiting
        .filter((row) => row.created_at < now - PENDING_STALE_SECS)
        .map((row) => ({ owner: row.owner, createdAt: row.created_at })),
    },
    checkoutOpenedNotPaying: checkouts?.count ?? 0,
  };
}

/** The tax behavior of the prices that priced sold plans: one, `mixed`, or null with none. */
function taxBehaviorOf(prices: readonly PlanPrice[]): OperatorStats['revenue']['taxBehavior'] {
  const behaviors = new Set(prices.map((price) => price.taxBehavior ?? 'unspecified'));
  if (behaviors.size > 1) {
    return 'mixed';
  }
  const [only] = behaviors;
  return only ?? null;
}

async function revenueSection(
  tx: Queryable,
  now: number,
  options: StatsOptions,
): Promise<{ revenue: OperatorStats['revenue']; mrrByPlan: Map<string, Decimal | null> }> {
  // Each store's plan subscription, chosen exactly as `reconcilePlan` chooses it.
  const plans = await tx.query<PlanRow>(
    `select s.owner, s.plan_source, s.status as store_status, s.tier, p.plan, p.interval,
       p.status, p.cancel_at_period_end, p.current_period_end, p.scheduled_plan,
       p.scheduled_interval, p.scheduled_at, p.stripe_created
     from stores s
     cross join lateral (
       select plan, interval, status, cancel_at_period_end, current_period_end, scheduled_plan,
         scheduled_interval, scheduled_at, stripe_created
       from billing_subscriptions
       where ${planSubscriptionsWhereFor('s.owner', '$1')}
       ${SUBSCRIPTION_ORDER} limit 1
     ) p
     order by s.owner`,
    [LIVE_STATUSES],
  );
  const groups = new Map<
    string,
    { plan: string; interval: BillingInterval | null; rows: PlanRow[] }
  >();
  for (const row of plans) {
    const key = `${row.plan}/${row.interval ?? ''}`;
    const group = groups.get(key) ?? { plan: row.plan, interval: row.interval, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  let mrr = new Decimal(0);
  let mrrCore = new Decimal(0);
  let cancellingMrr = new Decimal(0);
  let cancellingPartial = false;
  const paying: OperatorStats['revenue']['paying'] = [];
  const unavailable: OperatorStats['revenue']['mrrUnavailable'] = [];
  const usedPrices: PlanPrice[] = [];
  const mrrByPlan = new Map<string, Decimal | null>();
  const sortedGroups = [...groups.values()].sort((left, right) =>
    `${left.plan}/${left.interval}`.localeCompare(`${right.plan}/${right.interval}`),
  );
  for (const group of sortedGroups) {
    const price = priceFor(options.prices, group.plan, group.interval);
    if ('reason' in price) {
      unavailable.push({ plan: group.plan, interval: group.interval, reason: price.reason });
      paying.push({
        plan: group.plan,
        interval: group.interval,
        count: group.rows.length,
        mrrUsd: null,
      });
      mrrByPlan.set(group.plan, null);
      cancellingPartial ||= group.rows.some((row) => row.cancel_at_period_end);
      continue;
    }
    usedPrices.push(price);
    const each = monthlyUsd(price);
    const groupMrr = each.times(group.rows.length);
    mrr = mrr.plus(groupMrr);
    for (const row of group.rows) {
      if (row.cancel_at_period_end) {
        cancellingMrr = cancellingMrr.plus(each);
      } else if (row.status !== 'past_due') {
        mrrCore = mrrCore.plus(each);
      }
    }
    paying.push({
      plan: group.plan,
      interval: group.interval,
      count: group.rows.length,
      mrrUsd: groupMrr.toString(),
    });
    // A plan whose other interval has no usable price stays without MRR.
    if (mrrByPlan.get(group.plan) !== null) {
      mrrByPlan.set(group.plan, (mrrByPlan.get(group.plan) ?? new Decimal(0)).plus(groupMrr));
    }
  }
  const cancelling = plans.filter((row) => row.cancel_at_period_end);
  const cancellingEnds = cancelling.flatMap((row) =>
    row.current_period_end === null ? [] : [row.current_period_end],
  );
  const integrity: OperatorStats['revenue']['integrity'] = plans.flatMap((row) => {
    const problem = integrityProblem(row);
    return problem === undefined ? [] : [{ owner: row.owner, problem }];
  });
  const unpaidBilling = await tx.query<{ owner: string }>(
    `select owner from stores s
     where plan_source = 'billing' and status = 'active'
       and not exists (select 1 from billing_subscriptions
                       where ${planSubscriptionsWhereFor('s.owner', '$1')})
     order by owner`,
    [LIVE_STATUSES],
  );
  for (const row of unpaidBilling) {
    integrity.push({ owner: row.owner, problem: 'billing_without_subscription' });
  }
  const [churn] = await tx.query<{ count: number }>(
    `select count(distinct owner)::int8 as count from billing_subscriptions b
     where status = any($1::text[]) and updated_at > $2
       and not exists (select 1 from billing_subscriptions
                       where ${planSubscriptionsWhereFor('b.owner', '$3')})`,
    [ENDED_STATUSES, now - options.days * SECS_PER_DAY, LIVE_STATUSES],
  );
  const operatorManaged = await tx.query<{ tier: string; count: number }>(
    `select tier, count(*)::int8 as count from stores
     where status = 'active' and coalesce(plan_source, 'operator') = 'operator'
       and tier is not null and tier is distinct from $1::text
       and not exists (select 1 from billing_subscriptions
                       where ${planSubscriptionsWhereFor('stores.owner', '$2')})
     group by tier order by tier`,
    [options.freeTier?.tier ?? null, LIVE_STATUSES],
  );
  const windowStart = now - options.days * SECS_PER_DAY;
  return {
    revenue: {
      priceSource: options.prices.kind === 'loaded' ? 'stripe' : options.prices.kind,
      paying,
      mrrUsd: mrr.toString(),
      mrrCoreUsd: mrrCore.toString(),
      mrrPartial: unavailable.length > 0,
      mrrUnavailable: unavailable,
      taxBehavior: taxBehaviorOf(usedPrices),
      newPaid: plans.filter((row) => row.stripe_created > windowStart).length,
      churned: churn?.count ?? 0,
      cancelling: {
        count: cancelling.length,
        mrrUsd: cancellingMrr.toString(),
        partial: cancellingPartial,
        firstEndsAt: cancellingEnds.length === 0 ? null : Math.min(...cancellingEnds),
      },
      pastDue: plans.filter((row) => row.status === 'past_due').map((row) => row.owner),
      scheduled: plans.flatMap((row) =>
        row.scheduled_at === null
          ? []
          : [
              {
                owner: row.owner,
                from: row.plan,
                to: row.scheduled_plan,
                interval: row.scheduled_interval,
                at: row.scheduled_at,
              },
            ],
      ),
      operatorManaged,
      integrity,
    },
    mrrByPlan,
  };
}

async function usageSection(
  tx: Queryable,
  now: number,
  options: StatsOptions,
): Promise<OperatorStats['usage']> {
  const today = utcDay(now);
  const recentFrom = today - RECENT_DAYS;
  const windowFrom = today - options.days;
  const [activity] = await tx.query<{
    conversations_7: number;
    answers_7: number;
    links_7: number;
    carts_7: number;
    active_7: number;
    conversations_window: number;
    answers_window: number;
    links_window: number;
    carts_window: number;
    active_window: number;
  }>(
    `select coalesce(sum(conversations) filter (where day > $1), 0)::int8 as conversations_7,
       coalesce(sum(answers) filter (where day > $1), 0)::int8 as answers_7,
       coalesce(sum(links) filter (where day > $1), 0)::int8 as links_7,
       coalesce(sum(carts) filter (where day > $1), 0)::int8 as carts_7,
       count(distinct owner) filter (where day > $1 and answers > 0)::int8 as active_7,
       coalesce(sum(conversations) filter (where day > $2), 0)::int8 as conversations_window,
       coalesce(sum(answers) filter (where day > $2), 0)::int8 as answers_window,
       coalesce(sum(links) filter (where day > $2), 0)::int8 as links_window,
       coalesce(sum(carts) filter (where day > $2), 0)::int8 as carts_window,
       count(distinct owner) filter (where day > $2 and answers > 0)::int8 as active_window
     from activity_days where day > least($1::int, $2::int)`,
    [recentFrom, windowFrom],
  );
  const [lifetime] = await tx.query<{ conversations: number }>(
    'select coalesce(sum(conversations), 0)::int8 as conversations from store_totals',
  );
  const [sessions] = await tx.query<{ count: number }>(
    'select count(*)::int8 as count from sessions where session_end > $1',
    [now],
  );
  const [silent] = await tx.query<{ never: number; quiet: number }>(
    `select count(*) filter (where last_day is null)::int8 as never,
       count(*) filter (where last_day <= $1)::int8 as quiet
     from (select (select max(day) from activity_days a
                   where a.owner = s.owner and a.answers > 0) as last_day
           from stores s where s.status = 'active') as answered`,
    [windowFrom],
  );
  const [neverTalked] = await tx.query<{ count: number }>(
    `select count(*)::int8 as count from stores s
     where exists (select 1 from store_origins o where o.owner = s.owner)
       and not exists (select 1 from store_totals t
                       where t.owner = s.owner and t.conversations > 0)`,
  );
  const connectors = await tx.query<{ platform: string; enabled: boolean; count: number }>(
    `select platform, enabled, count(*)::int8 as count from connectors
     group by 1, 2 order by 1, 2`,
  );
  const top = await tx.query<{
    owner: string;
    tier: string | null;
    conversations: number;
    answers: number;
    carts: number;
    spent: string;
  }>(
    `select a.owner, s.tier, sum(a.conversations)::int8 as conversations,
       sum(a.answers)::int8 as answers, sum(a.carts)::int8 as carts,
       (select coalesce(sum(d.spent), 0) from store_days d
        where d.owner = a.owner and d.day > $1)::text as spent
     from activity_days a join stores s on s.owner = a.owner
     where a.day > $1
     group by a.owner, s.tier
     order by 4 desc, 1
     limit $2`,
    [windowFrom, TOP_STORES],
  );
  return {
    activeStores: { days7: activity?.active_7 ?? 0, window: activity?.active_window ?? 0 },
    activity: {
      days7: {
        conversations: activity?.conversations_7 ?? 0,
        answers: activity?.answers_7 ?? 0,
        links: activity?.links_7 ?? 0,
        carts: activity?.carts_7 ?? 0,
      },
      window: {
        conversations: activity?.conversations_window ?? 0,
        answers: activity?.answers_window ?? 0,
        links: activity?.links_window ?? 0,
        carts: activity?.carts_window ?? 0,
      },
    },
    lifetimeConversations: lifetime?.conversations ?? 0,
    openSessions: sessions?.count ?? 0,
    silent: { neverAnswered: silent?.never ?? 0, quiet: silent?.quiet ?? 0 },
    configuredNeverTalked: neverTalked?.count ?? 0,
    connectors,
    top: top.map((row) => ({
      owner: row.owner,
      tier: row.tier,
      conversations: row.conversations,
      answers: row.answers,
      carts: row.carts,
      spentUsd: new Decimal(row.spent).toString(),
    })),
  };
}

async function costSection(
  tx: Queryable,
  now: number,
  mrrByPlan: Map<string, Decimal | null>,
  freeTier: FreeTier | undefined,
): Promise<OperatorStats['cost']> {
  const today = utcDay(now);
  const month = monthStartDay(now);
  const previousMonth = previousMonthStartDay(now);
  const [totals] = await tx.query<{ today: string; month: string; last_month: string }>(
    `select coalesce(sum(spent) filter (where day = $1), 0)::text as today,
       coalesce(sum(spent) filter (where day >= $2), 0)::text as month,
       coalesce(sum(spent) filter (where day >= $3 and day < $2), 0)::text as last_month
     from store_days where day >= $3`,
    [today, month, previousMonth],
  );
  const [conversations] = await tx.query<{ count: number }>(
    'select coalesce(sum(conversations), 0)::int8 as count from activity_days where day >= $1',
    [month],
  );
  // Each store's spend under its current tier (no plan history is kept).
  const byTier = await tx.query<{ tier: string | null; month: string; last_month: string }>(
    `select s.tier, coalesce(sum(d.spent) filter (where d.day >= $1), 0)::text as month,
       coalesce(sum(d.spent) filter (where d.day >= $2 and d.day < $1), 0)::text as last_month
     from store_days d left join stores s on s.owner = d.owner
     where d.day >= $2
     group by s.tier`,
    [month, previousMonth],
  );
  const monthSpent = new Decimal(totals?.month ?? '0');
  const conversationCount = conversations?.count ?? 0;
  const rows = new Map<string | null, { month: Decimal; lastMonth: Decimal }>();
  for (const row of byTier) {
    rows.set(row.tier, { month: new Decimal(row.month), lastMonth: new Decimal(row.last_month) });
  }
  for (const plan of mrrByPlan.keys()) {
    if (!rows.has(plan)) {
      rows.set(plan, { month: new Decimal(0), lastMonth: new Decimal(0) });
    }
  }
  const tiers = [...rows.keys()].sort((left, right) => {
    if (left === null || right === null) {
      return left === null ? 1 : -1;
    }
    return left.localeCompare(right);
  });
  return {
    todayUsd: new Decimal(totals?.today ?? '0').toString(),
    monthToDateUsd: monthSpent.toString(),
    lastMonthUsd: new Decimal(totals?.last_month ?? '0').toString(),
    perConversationUsd:
      conversationCount === 0 ? null : monthSpent.div(conversationCount).toString(),
    byPlan: tiers.map((tier) => {
      const spend = rows.get(tier) ?? { month: new Decimal(0), lastMonth: new Decimal(0) };
      const planMrr = tier === null ? undefined : mrrByPlan.get(tier);
      // Free and stores with no plan now earn nothing, so their margin is their cost. A sold plan
      // without a usable price has no margin, nor has a tier nobody pays through Stripe (operator
      // plans are billed outside it: their cost alone is no loss).
      const earnsNothing = tier === null || tier === freeTier?.tier;
      const revenue = earnsNothing ? new Decimal(0) : planMrr;
      const margin =
        revenue === undefined || revenue === null ? null : revenue.minus(spend.lastMonth);
      return {
        tier,
        monthToDateUsd: spend.month.toString(),
        lastMonthUsd: spend.lastMonth.toString(),
        mrrUsd: planMrr === undefined || planMrr === null ? null : planMrr.toString(),
        grossMarginUsd: margin === null ? null : margin.toString(),
      };
    }),
  };
}

async function budgetHealth(
  tx: Queryable,
  now: number,
): Promise<OperatorStats['health']['budget']> {
  // The anchor `planAnchor` reads, for every active store at once.
  const stores = await tx.query<{
    owner: string;
    tier: string;
    budget: string;
    anchor: number | null;
    paying: boolean;
  }>(
    `select s.owner, s.tier, t.monthly_budget_usd::text as budget,
       case when s.plan_source = 'billing' then
         (select billing_cycle_anchor from billing_subscriptions
          where ${planSubscriptionsWhereFor('s.owner', '$1')}
          ${SUBSCRIPTION_ORDER} limit 1)
       end as anchor,
       exists (select 1 from billing_subscriptions
               where ${planSubscriptionsWhereFor('s.owner', '$1')}) as paying
     from stores s join tiers t on t.name = s.tier
     where s.status = 'active'
     order by s.owner`,
    [LIVE_STATUSES],
  );
  if (stores.length === 0) {
    return { paused: [], near: [] };
  }
  const startDays = stores.map((store) => windowOf(store.anchor ?? undefined, now).startDay);
  const usage = await tx.query<{ owner: string; spent: string; reserved: string }>(
    `select w.owner, coalesce(sum(d.spent), 0)::text as spent,
       coalesce(sum(d.reserved), 0)::text as reserved
     from unnest($1::text[], $2::int[]) as w(owner, start_day)
     left join store_days d on d.owner = w.owner and d.day >= w.start_day
     group by w.owner`,
    [stores.map((store) => store.owner), startDays],
  );
  const usageByOwner = new Map(usage.map((row) => [row.owner, row]));
  const paused: OperatorStats['health']['budget']['paused'] = [];
  const near: OperatorStats['health']['budget']['near'] = [];
  for (const store of stores) {
    const budget = new Decimal(store.budget);
    const row = usageByOwner.get(store.owner);
    // A zero budget is refused by the tiers check; read anyway as no cap, never a division by zero.
    if (row === undefined || budget.lessThanOrEqualTo(0)) {
      continue;
    }
    // As `budgetReached`: the window's spend and the reservations of turns in flight in it.
    const used = new Decimal(row.spent).plus(row.reserved);
    if (used.greaterThanOrEqualTo(budget)) {
      paused.push({ owner: store.owner, tier: store.tier, paying: store.paying });
      continue;
    }
    const bps = used.times(FULL_BPS).div(budget).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    if (bps.greaterThanOrEqualTo(NEAR_BUDGET_BPS)) {
      near.push({ owner: store.owner, tier: store.tier, bps: bps.toNumber() });
    }
  }
  return { paused, near };
}

async function healthSection(
  tx: Queryable,
  now: number,
  options: StatsOptions,
): Promise<OperatorStats['health']> {
  const failing = await tx.query<{
    owner: string;
    platform: string;
    status: string;
    message: string | null;
    last_run_at: number | null;
  }>(
    `select owner, platform, last_status->>'status' as status,
       coalesce(last_status->>'message', last_status->>'reason') as message, last_run_at
     from connectors
     where enabled and last_status is not null and last_status->>'status' <> 'ok'
     order by owner`,
  );
  // Interrupted as `catalogSync` reads it: running, but no live lease holds it.
  const syncs = await tx.query<{
    owner: string;
    state: 'failed' | 'running';
    error: string | null;
    at: number | null;
  }>(
    `select owner, state, error, coalesce(finished_at, started_at) as at from catalog_syncs
     where state = 'failed'
        or (state = 'running' and not (holder is not null and expires_at > $1))
     order by owner`,
    [now],
  );
  const events = await tx.query<{ owner: string; gave_up: number; backlog: number }>(
    `select e.owner,
       count(*) filter (where e.publish_failures >= $1)::int8 as gave_up,
       count(*) filter (where e.publish_failures < $1 and s.status = 'active')::int8 as backlog
     from store_events e join stores s on s.owner = e.owner
     where not e.published and (e.publish_failures >= $1 or s.status = 'active')
     group by e.owner order by e.owner`,
    [MAX_PUBLISH_ATTEMPTS],
  );
  const stale = await tx.query<{ owner: string; current_period_end: number }>(
    `select owner, min(current_period_end)::int8 as current_period_end from billing_subscriptions
     where status = any($1::text[]) and current_period_end < $2
     group by owner order by owner`,
    [LIVE_STATUSES, now - STALE_SUBSCRIPTION_SECS],
  );
  let stripe: OperatorStats['health']['stripe'] = null;
  if (options.prices.kind !== 'off') {
    const [received] = await tx.query<{ last: number | null; week: number }>(
      `select max(received_at)::int8 as last,
         count(*) filter (where received_at > $1)::int8 as week
       from stripe_events`,
      [now - RECENT_DAYS * SECS_PER_DAY],
    );
    stripe = { lastEventAt: received?.last ?? null, events7d: received?.week ?? 0 };
  }
  return {
    budget: await budgetHealth(tx, now),
    connectorsFailing: failing.map((row) => ({
      owner: row.owner,
      platform: row.platform,
      status: row.status,
      message: row.message,
      lastRunAtMs: row.last_run_at,
    })),
    catalogSyncs: syncs.map((row) => ({
      owner: row.owner,
      state: row.state === 'failed' ? 'failed' : 'interrupted',
      error: row.error,
      at: row.at,
    })),
    storeEvents: events.map((row) => ({
      owner: row.owner,
      gaveUp: row.gave_up,
      backlog: row.backlog,
    })),
    staleSubscriptions: stale.map((row) => ({
      owner: row.owner,
      currentPeriodEnd: row.current_period_end,
    })),
    stripe,
  };
}

/**
 * The report at `now`, every number from one read-only snapshot: a repeatable-read transaction
 * that cannot write and cannot hold the live server's database for long. Prices come in already
 * loaded, so no Stripe call ever runs inside it.
 */
export async function computeStats(
  db: Db,
  now: number,
  options: StatsOptions,
): Promise<OperatorStats> {
  return db.transaction(async (tx) => {
    await tx.query('set transaction isolation level repeatable read, read only');
    await tx.query("set local statement_timeout = '10s'");
    await tx.query("set local lock_timeout = '2s'");
    await tx.query("set local idle_in_transaction_session_timeout = '10s'");
    const stores = await storeSection(tx, now, options);
    const { revenue, mrrByPlan } = await revenueSection(tx, now, options);
    const usage = await usageSection(tx, now, options);
    const cost = await costSection(tx, now, mrrByPlan, options.freeTier);
    const health = await healthSection(tx, now, options);
    return {
      schemaVersion: STATS_SCHEMA_VERSION,
      generatedAt: now,
      windowDays: options.days,
      stores,
      revenue,
      usage,
      cost,
      health,
    };
  });
}

/**
 * The report for `--json`: safe to pass on (a digest) because it names stores by key only, never
 * by email, and leaves out connector messages and catalog sync errors, which can name a
 * merchant's URL or platform details.
 */
export function statsJson(stats: OperatorStats): unknown {
  return {
    ...stats,
    health: {
      ...stats.health,
      connectorsFailing: stats.health.connectorsFailing.map(
        ({ message: _message, ...rest }) => rest,
      ),
      catalogSyncs: stats.health.catalogSyncs.map(({ error: _error, ...rest }) => rest),
    },
  };
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** USD for display, half-up to cents with thousands separators: `-$1,234.50`. */
function usd(value: string, decimals: number = USD_DECIMALS): string {
  const amount = new Decimal(value);
  const [whole = '0', fraction] = amount.abs().toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const sign = amount.isNegative() && !amount.toDecimalPlaces(decimals).isZero() ? '-' : '';
  return `${sign}$${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

function dateTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * MS_PER_SEC).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function date(unixSeconds: number): string {
  return new Date(unixSeconds * MS_PER_SEC).toISOString().slice(0, 10);
}

/** Stores are named by full npub, so any line can be pasted into `store activate`. */
function npub(owner: string): string {
  return nip19.npubEncode(owner);
}

function label(name: string): string {
  return `  ${name.padEnd(12)}`;
}

function storesText(stats: OperatorStats): string[] {
  const { stores } = stats;
  const lines = [
    `STORES        ${count(stores.total)} total: ${count(stores.byStatus.active)} active, ${count(stores.byStatus.pending)} pending, ${count(stores.byStatus.suspended)} suspended`,
    `${label('new')}7 d: ${count(stores.new.days7)}   ${stats.windowDays} d: ${count(stores.new.window)}`,
  ];
  const tiers = new Map<string, { total: number; parts: string[] }>();
  for (const row of stores.byPlan) {
    const entry = tiers.get(row.tier) ?? { total: 0, parts: [] };
    entry.total += row.count;
    entry.parts.push(
      `${row.source}${row.status === 'suspended' ? ' suspended' : ''} ${count(row.count)}`,
    );
    tiers.set(row.tier, entry);
  }
  const plans = [...tiers.entries()].map(
    ([tier, entry]) => `${tier} ${count(entry.total)} (${entry.parts.join(', ')})`,
  );
  lines.push(`${label('plans')}${plans.length === 0 ? 'none' : plans.join('  ')}`);
  lines.push(
    stores.free === null
      ? `${label('free')}Free self-serve off`
      : `${label('free')}Free activations (incl. lapsed paid) on ${stores.free.tier}: last 24 h ${count(stores.free.last24h)}/${count(stores.free.perDay)}   last 7 d ${count(stores.free.last7d)}   active self-serve ${count(stores.free.active)}/${count(stores.free.maxActive)}`,
  );
  const { funnel } = stores;
  lines.push(
    `${label('funnel')}created ${count(funnel.created)} > configured ${count(funnel.configured)} > on a plan ${count(funnel.onPlan)} > talked ${count(funnel.talked)} > paying ${count(funnel.paying)}`,
  );
  lines.push(
    `${label('waiting')}${count(stores.waiting.count)} pending with settings, ${count(stores.waiting.stale.length)} for more than 3 days (age from created_at, not from when settings were saved)`,
  );
  for (const stale of stores.waiting.stale) {
    lines.push(`${label('')}${npub(stale.owner)} created ${date(stale.createdAt)}`);
  }
  lines.push(
    `${label('checkouts')}${stats.windowDays} d: ${count(stores.checkoutOpenedNotPaying)} checkout opened, not paying now`,
  );
  return lines;
}

const TAX_TEXT: Record<NonNullable<OperatorStats['revenue']['taxBehavior']>, string> = {
  inclusive: 'incl. tax',
  exclusive: 'excl. tax',
  unspecified: 'tax unspecified',
  mixed: 'tax mixed',
};

const PRICE_SOURCE_TEXT: Record<OperatorStats['revenue']['priceSource'], string> = {
  stripe: '',
  off: ' (billing is off)',
  failed: ' (Stripe price read failed)',
};

/** A Stripe-priced sum for display: n/a without Stripe prices, a lower bound when partial. */
function pricedUsd(
  value: string,
  partial: boolean,
  priceSource: OperatorStats['revenue']['priceSource'],
): string {
  if (priceSource !== 'stripe') {
    return 'n/a';
  }
  return partial ? `>= ${usd(value)}` : usd(value);
}

function mrrText(revenue: OperatorStats['revenue']): string {
  const unavailable = revenue.mrrUnavailable.length;
  const bound = pricedUsd(revenue.mrrUsd, revenue.mrrPartial, revenue.priceSource);
  const partial = revenue.mrrPartial
    ? `, ${unavailable} plan${unavailable === 1 ? '' : 's'} n/a`
    : '';
  const tax = revenue.taxBehavior === null ? '' : `, ${TAX_TEXT[revenue.taxBehavior]}`;
  return `est. MRR ${bound} (incl. past due and cancelling${tax}${partial})${PRICE_SOURCE_TEXT[revenue.priceSource]}`;
}

function revenueText(stats: OperatorStats): string[] {
  const { revenue } = stats;
  const payingCount = revenue.paying.reduce((total, row) => total + row.count, 0);
  const core = pricedUsd(revenue.mrrCoreUsd, revenue.mrrPartial, revenue.priceSource);
  const lines = [
    `REVENUE       ${count(payingCount)} paying (Stripe)  ${mrrText(revenue)}`,
    `${label('core')}excl. past due / cancelling ${core}`,
  ];
  for (const row of revenue.paying) {
    const reason = revenue.mrrUnavailable.find(
      (entry) => entry.plan === row.plan && entry.interval === row.interval,
    )?.reason;
    const money =
      row.mrrUsd === null ? `n/a (${printable(reason ?? 'no price')})` : usd(row.mrrUsd);
    lines.push(
      `${label(row.plan)}${(row.interval ?? '?').padEnd(6)}${count(row.count).padStart(5)}   ${money}`,
    );
  }
  lines.push(
    `${label(`${stats.windowDays} d`)}new ${count(revenue.newPaid)}   churned ${count(revenue.churned)} (approx.: canceled or unpaid, seen in the window)`,
  );
  const firstEnds =
    revenue.cancelling.firstEndsAt === null
      ? ''
      : `, first ends ${date(revenue.cancelling.firstEndsAt)}`;
  lines.push(
    `${label('cancelling')}${count(revenue.cancelling.count)} (${pricedUsd(revenue.cancelling.mrrUsd, revenue.cancelling.partial, revenue.priceSource)} at risk${firstEnds})`,
  );
  lines.push(`${label('past due')}${count(revenue.pastDue.length)}`);
  for (const owner of revenue.pastDue) {
    lines.push(`${label('')}${npub(owner)}`);
  }
  lines.push(`${label('scheduled')}${count(revenue.scheduled.length)}`);
  for (const change of revenue.scheduled) {
    lines.push(
      `${label('')}${npub(change.owner)} ${change.from} -> ${change.to ?? 'not a plan of ours'}${change.interval === null ? '' : ` (${change.interval})`} on ${date(change.at)}`,
    );
  }
  const operatorLabel =
    stats.stores.free === null
      ? 'operator-managed (not in MRR, incl. any free tier)'
      : 'operator-managed (not in MRR)';
  const operator = revenue.operatorManaged.map((row) => `${row.tier} ${count(row.count)}`);
  lines.push(
    `${label('operator')}${operator.length === 0 ? 'none' : operator.join('  ')}  ${operatorLabel}`,
  );
  lines.push(
    `${label('integrity')}${revenue.integrity.length === 0 ? 'ok' : count(revenue.integrity.length)}`,
  );
  for (const issue of revenue.integrity) {
    lines.push(`${label('')}${npub(issue.owner)} ${issue.problem}`);
  }
  return lines;
}

function usageText(stats: OperatorStats): string[] {
  const { usage } = stats;
  const { days7, window } = usage.activity;
  const connectors = new Map<string, { total: number; enabled: number }>();
  for (const row of usage.connectors) {
    const entry = connectors.get(row.platform) ?? { total: 0, enabled: 0 };
    entry.total += row.count;
    entry.enabled += row.enabled ? row.count : 0;
    connectors.set(row.platform, entry);
  }
  const connectorText = [...connectors.entries()].map(
    ([platform, entry]) =>
      `${printable(platform)} ${count(entry.total)} (${count(entry.enabled)} on)`,
  );
  return [
    `USAGE         7 d / ${stats.windowDays} d`,
    `${label('active')}${count(usage.activeStores.days7)} / ${count(usage.activeStores.window)} stores answering`,
    `${label('activity')}conversations ${count(days7.conversations)} / ${count(window.conversations)}   answers ${count(days7.answers)} / ${count(window.answers)}   product opens ${count(days7.links)} / ${count(window.links)}   carts ${count(days7.carts)} / ${count(window.carts)}`,
    `${label('lifetime')}conversations ${count(usage.lifetimeConversations)}`,
    `${label('open now')}sessions held ${count(usage.openSessions)}`,
    `${label('silent')}active, never answered ${count(usage.silent.neverAnswered)}; quiet for ${stats.windowDays} d ${count(usage.silent.quiet)}`,
    `${label('not talking')}configured but no conversation yet ${count(usage.configuredNeverTalked)}`,
    `${label('connectors')}${connectorText.length === 0 ? 'none' : connectorText.join('  ')}`,
  ];
}

function costText(stats: OperatorStats): string[] {
  const { cost } = stats;
  const perConversation =
    cost.perConversationUsd === null
      ? 'n/a'
      : usd(cost.perConversationUsd, PER_CONVERSATION_DECIMALS);
  const lines = [
    `COST (est.)   today ${usd(cost.todayUsd)}   MTD ${usd(cost.monthToDateUsd)}   last month ${usd(cost.lastMonthUsd)}   per conversation (MTD) ${perConversation}`,
    `${label('plan')}${'MTD'.padStart(12)}${'last month'.padStart(14)}${'est. MRR'.padStart(14)}   gross margin (before tax and Stripe fees)`,
  ];
  for (const row of cost.byPlan) {
    lines.push(
      `${label(row.tier ?? 'no plan now')}${usd(row.monthToDateUsd).padStart(12)}${usd(row.lastMonthUsd).padStart(14)}${(row.mrrUsd === null ? '-' : usd(row.mrrUsd)).padStart(14)}   ${row.grossMarginUsd === null ? 'n/a' : usd(row.grossMarginUsd)}`,
    );
  }
  return lines;
}

function topText(stats: OperatorStats): string[] {
  const lines = [`TOP STORES    ${stats.windowDays} d by answers (spend over the same days)`];
  if (stats.usage.top.length === 0) {
    lines.push(`${label('')}none`);
  }
  for (const store of stats.usage.top) {
    lines.push(
      `  ${npub(store.owner)}  ${store.tier ?? '-'}  conversations ${count(store.conversations)}  answers ${count(store.answers)}  carts ${count(store.carts)}  ${usd(store.spentUsd)}`,
    );
  }
  return lines;
}

function healthText(stats: OperatorStats): string[] {
  const { health } = stats;
  const payingPaused = health.budget.paused.filter((store) => store.paying).length;
  const lines = [
    'HEALTH',
    `${label('budget')}of the current budget period, turns in flight counted: paused ${count(health.budget.paused.length)} (${count(payingPaused)} paying)  near ${new Decimal(NEAR_BUDGET_BPS).div(100).toString()}%: ${count(health.budget.near.length)}`,
  ];
  for (const store of health.budget.paused) {
    lines.push(
      `${label('')}paused ${npub(store.owner)} ${store.tier}${store.paying ? ' (paying)' : ''}`,
    );
  }
  for (const store of health.budget.near) {
    const percent = new Decimal(store.bps).div(100).toFixed(2);
    lines.push(`${label('')}near ${npub(store.owner)} ${store.tier} ${percent}%`);
  }
  lines.push(`${label('connectors')}failing ${count(health.connectorsFailing.length)}`);
  for (const connector of health.connectorsFailing) {
    const ran =
      connector.lastRunAtMs === null
        ? ''
        : ` (${dateTime(Math.floor(connector.lastRunAtMs / MS_PER_SEC))})`;
    lines.push(
      `${label('')}${npub(connector.owner)} ${printable(connector.platform)} ${printable(connector.status)}${connector.message === null ? '' : `: ${printable(connector.message)}`}${ran}`,
    );
  }
  const failed = health.catalogSyncs.filter((sync) => sync.state === 'failed').length;
  lines.push(
    `${label('catalog')}failed ${count(failed)}  interrupted ${count(health.catalogSyncs.length - failed)}`,
  );
  for (const sync of health.catalogSyncs) {
    lines.push(
      `${label('')}${npub(sync.owner)} ${sync.state}${sync.error === null ? '' : `: ${printable(sync.error)}`}${sync.at === null ? '' : ` (${dateTime(sync.at)})`}`,
    );
  }
  const gaveUp = health.storeEvents.reduce((total, row) => total + row.gaveUp, 0);
  const backlog = health.storeEvents.reduce((total, row) => total + row.backlog, 0);
  lines.push(`${label('events')}gave up ${count(gaveUp)}  backlog ${count(backlog)}`);
  for (const row of health.storeEvents) {
    lines.push(
      `${label('')}${npub(row.owner)} gave up ${count(row.gaveUp)}  backlog ${count(row.backlog)}`,
    );
  }
  lines.push(
    `${label('stale subs')}${count(health.staleSubscriptions.length)} live subscriptions over a day past their period end (a missed Stripe event)`,
  );
  for (const row of health.staleSubscriptions) {
    lines.push(`${label('')}${npub(row.owner)} period ended ${date(row.currentPeriodEnd)}`);
  }
  lines.push(
    health.stripe === null
      ? `${label('stripe')}billing is off`
      : `${label('stripe')}last event ${health.stripe.lastEventAt === null ? 'never' : dateTime(health.stripe.lastEventAt)} (events in 7 d: ${count(health.stripe.events7d)})`,
  );
  lines.push(
    `${label('not known')}budget refusals, failed turns, Free-cap refusals and webhook errors are not recorded: see docker compose logs askr-server and Stripe Workbench`,
  );
  return lines;
}

/** The text report: the same object as `--json`, plus connector messages and sync errors. */
export function formatStats(stats: OperatorStats): string {
  return [
    `Askr stats  ${dateTime(stats.generatedAt)}   window ${stats.windowDays} d`,
    '(estimates: MRR = Stripe prices x live subscriptions, before Stripe fees, ignoring coupons;',
    " LLM cost = our computed spend, attributed to each store's current plan)",
    '',
    ...storesText(stats),
    '',
    ...revenueText(stats),
    '',
    ...usageText(stats),
    '',
    ...costText(stats),
    '',
    ...topText(stats),
    '',
    ...healthText(stats),
  ].join('\n');
}
