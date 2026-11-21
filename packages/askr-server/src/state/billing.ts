import { HEX_PUBKEY_RE } from '@elisym/commerce';
import {
  type BillingInterval,
  type PaidPlan,
  type ScheduledChange,
  type SubscriptionSnapshot,
  isPaidPlan,
} from '../billing/stripe';
import type { FreeTier } from '../config';
import { type Db, type Queryable, STORES_CHANNEL } from '../db/db';
import { followMoves } from './pg-state';
import { FREE_PLAN_LOCK_ID, freeCapacityReached } from './stores';
import type { StoreStatus } from './types';

/** Subscription states that keep a paid plan: `past_due` is the grace while Stripe retries. */
export const LIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

/**
 * The one order of a store's subscriptions, the earliest Stripe created first: of two live ones
 * (two checkouts paid at once) the first is the store's plan, stable whatever the event order.
 */
const SUBSCRIPTION_ORDER = 'order by stripe_created asc, subscription_id asc';

/** Who set a store's tier (`stores.plan_source`). */
export type PlanSource = 'operator' | 'free' | 'billing';

/** A store's plan as billing reads it. */
export interface PlanState {
  status: StoreStatus;
  tier: string | null;
  planSource: PlanSource | null;
}

/** A store whose tier the operator set (or an earlier release wrote): billing leaves it alone. */
export function operatorManaged(state: PlanState): boolean {
  return state.tier !== null && state.planSource !== 'free' && state.planSource !== 'billing';
}

export interface SubscriptionRecord {
  subscriptionId: string;
  owner: string;
  customerId: string;
  status: string;
  plan: PaidPlan | null;
  interval: BillingInterval | null;
  /** Unix seconds. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** What its schedule changes later, as last read; null with nothing scheduled. */
  scheduledChange: ScheduledChange | null;
  /** Unix seconds: when Stripe created it. */
  stripeCreated: number;
  updatedAt: number;
}

interface SubscriptionRow extends Record<string, unknown> {
  subscription_id: string;
  owner: string;
  customer_id: string;
  status: string;
  plan: PaidPlan | null;
  interval: BillingInterval | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  scheduled_plan: string | null;
  scheduled_interval: BillingInterval | null;
  scheduled_at: number | null;
  stripe_created: number;
  updated_at: number;
}

function scheduledChangeOf(row: SubscriptionRow): ScheduledChange | null {
  if (row.scheduled_at === null) {
    return null;
  }
  const plan = row.scheduled_plan ?? undefined;
  return {
    plan: isPaidPlan(plan) ? plan : null,
    interval: row.scheduled_interval,
    at: row.scheduled_at,
  };
}

function recordOf(row: SubscriptionRow): SubscriptionRecord {
  return {
    subscriptionId: row.subscription_id,
    owner: row.owner,
    customerId: row.customer_id,
    status: row.status,
    plan: row.plan,
    interval: row.interval,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    scheduledChange: scheduledChangeOf(row),
    stripeCreated: row.stripe_created,
    updatedAt: row.updated_at,
  };
}

/** A paid tier billing must apply is missing on the server: the event is retried once it exists. */
export class MissingTierError extends Error {
  constructor(readonly tier: string) {
    super(`the tier ${tier} does not exist`);
    this.name = 'MissingTierError';
  }
}

/**
 * What reconciling a store with its subscriptions did: put it on a paid tier (`paid`), back on
 * Free or pending once its paid plan ended, nothing (`unchanged`), or left it alone (`suspended`,
 * `operator_managed`, `no_store`).
 */
export type PlanOutcome =
  | 'paid'
  | 'free'
  | 'pending'
  | 'unchanged'
  | 'suspended'
  | 'operator_managed'
  | 'no_store';

const SUBSCRIPTION_SELECT = `select subscription_id, owner, customer_id, status, plan, interval,
  current_period_end, cancel_at_period_end, scheduled_plan, scheduled_interval, scheduled_at,
  stripe_created, updated_at from billing_subscriptions`;

/** Where a store named by `owner` (hex) is now: itself, where it moved to, or undefined. */
export async function storeNow(
  tx: Queryable,
  owner: string | undefined,
): Promise<string | undefined> {
  if (owner === undefined || !HEX_PUBKEY_RE.test(owner)) {
    return undefined;
  }
  const exists = await tx.query('select 1 from stores where owner = $1', [owner]);
  if (exists.length > 0) {
    return owner;
  }
  return followMoves(tx, owner);
}

export async function subscriptionOwner(
  tx: Queryable,
  subscriptionId: string,
): Promise<string | undefined> {
  const [row] = await tx.query<{ owner: string }>(
    'select owner from billing_subscriptions where subscription_id = $1',
    [subscriptionId],
  );
  return row?.owner;
}

export async function ownerOfCustomer(
  tx: Queryable,
  customerId: string | undefined,
): Promise<string | undefined> {
  if (customerId === undefined || customerId === '') {
    return undefined;
  }
  const [row] = await tx.query<{ owner: string }>(
    'select owner from billing_customers where customer_id = $1',
    [customerId],
  );
  return row?.owner;
}

/** Remember a store's Stripe customer; a store keeps its first one. */
export async function noteCustomer(
  tx: Queryable,
  owner: string,
  customerId: string,
  now: number,
): Promise<void> {
  if (customerId === '') {
    return;
  }
  await tx.query(
    `insert into billing_customers (owner, customer_id, created_at) values ($1, $2, $3)
     on conflict do nothing`,
    [owner, customerId, now],
  );
}

/**
 * Store a subscription as Stripe has it now; a known one keeps the store it was recorded for, and
 * its plan and interval when Stripe's price no longer names one of ours. Its scheduled change is
 * always Stripe's now, so a schedule released or done clears it.
 */
export async function saveSubscription(
  tx: Queryable,
  owner: string,
  snapshot: SubscriptionSnapshot,
  now: number,
  fetchedAt: number,
): Promise<void> {
  await tx.query(
    `insert into billing_subscriptions (subscription_id, owner, customer_id, status, plan, interval,
       current_period_end, cancel_at_period_end, stripe_created, updated_at, snapshot_fetched_at,
       scheduled_plan, scheduled_interval, scheduled_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $10, $9, $11, $12, $13, $14)
     on conflict (subscription_id) do update set
       customer_id = $3, status = $4,
       plan = coalesce($5, billing_subscriptions.plan),
       interval = coalesce($6, billing_subscriptions.interval),
       current_period_end = $7, cancel_at_period_end = $8, stripe_created = $10, updated_at = $9,
       snapshot_fetched_at = $11,
       scheduled_plan = $12, scheduled_interval = $13, scheduled_at = $14
     where billing_subscriptions.snapshot_fetched_at <= $11`,
    [
      snapshot.id,
      owner,
      snapshot.customer,
      snapshot.status,
      snapshot.plan ?? null,
      snapshot.interval ?? null,
      snapshot.currentPeriodEnd ?? null,
      snapshot.cancelAtPeriodEnd,
      now,
      snapshot.created,
      fetchedAt,
      snapshot.scheduledChange?.plan ?? null,
      snapshot.scheduledChange?.interval ?? null,
      snapshot.scheduledChange?.at ?? null,
    ],
  );
}

/** A subscription Stripe no longer has (the customer's data was deleted): it ended. */
export async function markSubscriptionGone(
  tx: Queryable,
  subscriptionId: string,
  now: number,
  fetchedAt: number,
): Promise<void> {
  await tx.query(
    `update billing_subscriptions set status = 'canceled', cancel_at_period_end = false,
       scheduled_plan = null, scheduled_interval = null, scheduled_at = null,
       updated_at = $2, snapshot_fetched_at = $3
     where subscription_id = $1 and snapshot_fetched_at <= $3`,
    [subscriptionId, now, fetchedAt],
  );
}

async function lockedPlanState(tx: Queryable, owner: string): Promise<PlanState | undefined> {
  const [row] = await tx.query<{
    status: StoreStatus;
    tier: string | null;
    plan_source: PlanSource | null;
  }>('select status, tier, plan_source from stores where owner = $1 for update', [owner]);
  return row === undefined
    ? undefined
    : { status: row.status, tier: row.tier, planSource: row.plan_source };
}

/** What reconciling did, and the store's live subscriptions (more than one is a duplicate). */
export interface Reconciled {
  outcome: PlanOutcome;
  live: string[];
}

/**
 * Bring a store in line with its subscriptions (the earliest live one wins): a live one puts it on
 * its paid tier; with none live, a store billing put on a paid tier goes to Free when Free has
 * room (the same tier and caps as an owner's Free choice), else to pending with no tier, its data
 * kept. Suspended and operator-managed stores are left alone. Notifies the running servers.
 * Run under the Free lock (`onceForEvent` takes it before any store row), as `activateFree` is.
 */
export async function reconcilePlan(
  tx: Queryable,
  owner: string,
  freeTier: FreeTier | undefined,
  now: number,
): Promise<Reconciled> {
  const lives = await tx.query<{ subscription_id: string; plan: string }>(
    `select subscription_id, plan from billing_subscriptions
     where owner = $1 and status = any($2::text[]) and plan is not null ${SUBSCRIPTION_ORDER}`,
    [owner, LIVE_STATUSES],
  );
  const ids = lives.map((row) => row.subscription_id);
  return { outcome: await reconcileWith(tx, owner, lives[0], freeTier, now), live: ids };
}

async function reconcileWith(
  tx: Queryable,
  owner: string,
  live: { plan: string } | undefined,
  freeTier: FreeTier | undefined,
  now: number,
): Promise<PlanOutcome> {
  const state = await lockedPlanState(tx, owner);
  if (state === undefined) {
    return 'no_store';
  }
  if (state.status === 'suspended') {
    return 'suspended';
  }
  if (operatorManaged(state)) {
    return 'operator_managed';
  }
  if (live !== undefined) {
    if (state.status === 'active' && state.tier === live.plan && state.planSource === 'billing') {
      return 'unchanged';
    }
    // `for share` waits for a `tier delete` under way, so a deleted tier reads as none.
    const tiers = await tx.query('select 1 from tiers where name = $1 for share', [live.plan]);
    if (tiers.length === 0) {
      throw new MissingTierError(live.plan);
    }
    await tx.query(
      `update stores set status = 'active', tier = $2, plan_source = 'billing' where owner = $1`,
      [owner, live.plan],
    );
    await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
    return 'paid';
  }
  if (state.planSource !== 'billing') {
    return 'unchanged';
  }
  const freeExists =
    freeTier !== undefined &&
    (await tx.query('select 1 from tiers where name = $1 for share', [freeTier.tier])).length > 0;
  if (
    freeTier !== undefined &&
    freeExists &&
    !(await freeCapacityReached(tx, freeTier.tier, now, freeTier))
  ) {
    await tx.query(
      `update stores set status = 'active', tier = $2, plan_source = 'free', auto_activated_at = $3
       where owner = $1`,
      [owner, freeTier.tier, now],
    );
    await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
    return 'free';
  }
  await tx.query(
    `update stores set status = 'pending', tier = null, plan_source = null where owner = $1`,
    [owner],
  );
  await tx.query('select pg_notify($1, $2)', [STORES_CHANNEL, owner]);
  return 'pending';
}

/** Billing's reads and the once-per-event transaction (6.1): no Stripe call here. */
export class BillingDirectory {
  constructor(private readonly db: Db) {}

  async customerOf(owner: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ customer_id: string }>(
      'select customer_id from billing_customers where owner = $1',
      [owner],
    );
    return row?.customer_id;
  }

  /** Forget a customer Stripe no longer has, so the next checkout makes a new one. */
  async forgetCustomer(owner: string, customerId: string): Promise<void> {
    await this.db.query('delete from billing_customers where owner = $1 and customer_id = $2', [
      owner,
      customerId,
    ]);
  }

  async planState(owner: string): Promise<PlanState | undefined> {
    const [row] = await this.db.query<{
      status: StoreStatus;
      tier: string | null;
      plan_source: PlanSource | null;
    }>('select status, tier, plan_source from stores where owner = $1', [owner]);
    return row === undefined
      ? undefined
      : { status: row.status, tier: row.tier, planSource: row.plan_source };
  }

  /** A store's subscriptions, the earliest Stripe created first (the order reconciling uses). */
  async subscriptions(owner: string): Promise<SubscriptionRecord[]> {
    const rows = await this.db.query<SubscriptionRow>(
      `${SUBSCRIPTION_SELECT} where owner = $1 ${SUBSCRIPTION_ORDER}`,
      [owner],
    );
    return rows.map(recordOf);
  }

  /** The Checkout Session the store opened last, if any. */
  async lastCheckout(owner: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ session_id: string }>(
      'select session_id from billing_checkouts where owner = $1',
      [owner],
    );
    return row?.session_id;
  }

  /** Remember the store's newest session; answers the one it replaced, to expire. */
  async swapCheckout(owner: string, sessionId: string, now: number): Promise<string | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.query('select 1 from stores where owner = $1 for update', [owner]);
      const [row] = await tx.query<{ session_id: string }>(
        'select session_id from billing_checkouts where owner = $1',
        [owner],
      );
      await tx.query(
        `insert into billing_checkouts (owner, session_id, created_at) values ($1, $2, $3)
         on conflict (owner) do update set session_id = $2, created_at = $3`,
        [owner, sessionId, now],
      );
      return row?.session_id;
    });
  }

  /** Whether Stripe event `id` was applied already: a cheap read before Stripe is asked. */
  async eventSeen(id: string): Promise<boolean> {
    return (await this.db.query('select 1 from stripe_events where id = $1', [id])).length > 0;
  }

  /**
   * Run `work` for Stripe event `id` once: under the Free lock, in one transaction that records
   * the id, so a redelivery (or a second instance) finds it done. A throw rolls everything back,
   * and the event is applied again on Stripe's retry.
   */
  async onceForEvent<Result>(
    id: string,
    type: string,
    now: number,
    work: (tx: Queryable) => Promise<Result>,
  ): Promise<{ duplicate: true } | { duplicate: false; result: Result }> {
    return this.db.transaction(async (tx) => {
      // One event at a time on any instance, under the Free lock (an ended plan may take a Free
      // place), taken before any store row is touched (a customer or subscription row locks its
      // store's row for its foreign key): the order `activateFree` takes them in, so no deadlock.
      await tx.query('select pg_advisory_xact_lock($1)', [FREE_PLAN_LOCK_ID]);
      const seen = await tx.query('select 1 from stripe_events where id = $1', [id]);
      if (seen.length > 0) {
        return { duplicate: true as const };
      }
      const result = await work(tx);
      await tx.query('insert into stripe_events (id, type, received_at) values ($1, $2, $3)', [
        id,
        type,
        now,
      ]);
      return { duplicate: false as const, result };
    });
  }
}
