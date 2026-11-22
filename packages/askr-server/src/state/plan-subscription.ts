/** Subscription states that keep a paid plan: `past_due` is the grace while Stripe retries. */
export const LIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

/**
 * The one order of a store's subscriptions, the earliest Stripe created first: of two live ones
 * (two checkouts paid at once) the first is the store's plan, stable whatever the event order.
 */
export const SUBSCRIPTION_ORDER = 'order by stripe_created asc, subscription_id asc';

/**
 * `PLAN_SUBSCRIPTIONS_WHERE` over the subscriptions of the store whose owner is the SQL expression
 * `owner` (an outer column, in a subquery on `billing_subscriptions` over every store), with
 * `LIVE_STATUSES` as the parameter `statuses`.
 */
export function planSubscriptionsWhereFor(owner: string, statuses: string): string {
  return `owner = ${owner} and status = any(${statuses}::text[]) and plan is not null`;
}

/**
 * The subscriptions that can set a store's plan (live, on one of our plans), with the store's
 * owner as `$1` and `LIVE_STATUSES` as `$2`; the first in `SUBSCRIPTION_ORDER` is the plan's.
 */
export const PLAN_SUBSCRIPTIONS_WHERE = planSubscriptionsWhereFor('$1', '$2');
