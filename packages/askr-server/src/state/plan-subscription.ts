/** Subscription states that keep a paid plan: `past_due` is the grace while Stripe retries. */
export const LIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

/**
 * The one order of a store's subscriptions, the earliest Stripe created first: of two live ones
 * (two checkouts paid at once) the first is the store's plan, stable whatever the event order.
 */
export const SUBSCRIPTION_ORDER = 'order by stripe_created asc, subscription_id asc';

/**
 * The subscriptions that can set a store's plan (live, on one of our plans), with the store's
 * owner as `$1` and `LIVE_STATUSES` as `$2`; the first in `SUBSCRIPTION_ORDER` is the plan's.
 */
export const PLAN_SUBSCRIPTIONS_WHERE =
  'owner = $1 and status = any($2::text[]) and plan is not null';
