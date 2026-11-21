import Stripe from 'stripe';

/**
 * The Stripe API version every call and webhook endpoint uses: the SDK's own, so its types match
 * what is sent and read. Managed Payments needs `2025-03-31.basil` or later.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive';

/** The self-serve paid plans: each a server tier of the same name and a Stripe product. */
export const PAID_PLANS = ['starter', 'growth', 'pro', 'scale'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export type BillingInterval = 'month' | 'year';

/** `askr_<tier>_monthly|yearly`, the lookup keys of the eight prices. */
const LOOKUP_KEY_RE = /^askr_(starter|growth|pro|scale)_(monthly|yearly)$/u;
/** The product metadata naming its tier. */
const TIER_METADATA = 'askr_tier';
/** The subscription and session metadata naming the store's owner (hex). */
export const STORE_METADATA = 'askr_store';

export function isPaidPlan(value: string | undefined): value is PaidPlan {
  return PAID_PLANS.some((plan) => plan === value);
}

export function lookupKeyOf(plan: PaidPlan, interval: BillingInterval): string {
  return `askr_${plan}_${interval === 'month' ? 'monthly' : 'yearly'}`;
}

/** A price we sell: its id, the plan its product names and how often it bills. */
export interface PriceInfo {
  id: string;
  plan: PaidPlan;
  interval: BillingInterval;
}

/** A subscription as read from Stripe, reduced to what the server keeps. */
export interface SubscriptionSnapshot {
  id: string;
  customer: string;
  status: string;
  /** `metadata.askr_store`: the owner hex the checkout named. */
  store: string | undefined;
  /** Undefined when the price is not one of ours. */
  plan: PaidPlan | undefined;
  interval: BillingInterval | undefined;
  /** Unix seconds: the earliest period end of its items. */
  currentPeriodEnd: number | undefined;
  cancelAtPeriodEnd: boolean;
  /** Unix seconds: when Stripe created it. */
  created: number;
}

/** The Stripe calls billing makes: the real client, or a test double. */
export interface StripeGateway {
  /** The active price with this lookup key, with its plan; undefined when there is none. */
  price(lookupKey: string): Promise<PriceInfo | undefined>;
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
  ): Promise<{ id: string; url: string | null }>;
  /** Expire an open Checkout Session so it can no longer be paid; throws when it is not open. */
  expireCheckoutSession(id: string): Promise<void>;
  createPortalSession(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
  /** The subscription now; undefined when Stripe no longer has it (deleted with the customer's data). */
  subscription(id: string): Promise<SubscriptionSnapshot | undefined>;
}

/** The part of a Stripe price billing reads (its product expanded). */
export interface PriceLike {
  id: string;
  lookup_key: string | null;
  recurring: { interval: string } | null;
  product: string | { id: string; metadata?: Record<string, string> };
}

/** The part of a Stripe subscription billing reads. */
export interface SubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  metadata: Record<string, string>;
  cancel_at_period_end: boolean;
  created: number;
  items: { data: { current_period_end: number; price: PriceLike }[] };
}

function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : value.id;
}

function intervalOf(value: string | undefined): BillingInterval | undefined {
  if (value === 'month' || value === 'year') {
    return value;
  }
  return undefined;
}

/**
 * The plan a price is for: its product's `askr_tier` metadata (the product must be expanded),
 * else its lookup key. A product naming another tier than the lookup key is not trusted.
 */
export function planOfPrice(price: PriceLike): PriceInfo | undefined {
  const fromKey = LOOKUP_KEY_RE.exec(price.lookup_key ?? '');
  const product = typeof price.product === 'string' ? undefined : price.product;
  const plan = product?.metadata?.[TIER_METADATA] ?? fromKey?.[1];
  if (!isPaidPlan(plan) || (fromKey !== null && fromKey[1] !== plan)) {
    return undefined;
  }
  const interval = intervalOf(price.recurring?.interval);
  const keyInterval = fromKey?.[2] === 'yearly' ? 'year' : 'month';
  if (interval === undefined || (fromKey !== null && keyInterval !== interval)) {
    return undefined;
  }
  return { id: price.id, plan, interval };
}

export function snapshotOf(subscription: SubscriptionLike): SubscriptionSnapshot {
  const items = subscription.items.data;
  const [first] = items;
  const price = first === undefined ? undefined : planOfPrice(first.price);
  const ends = items.map((item) => item.current_period_end);
  return {
    id: subscription.id,
    customer: idOf(subscription.customer) ?? '',
    status: subscription.status,
    store: subscription.metadata[STORE_METADATA],
    // One line item per subscription: more is not ours, so no plan.
    plan: items.length === 1 ? price?.plan : undefined,
    interval: items.length === 1 ? price?.interval : undefined,
    currentPeriodEnd: ends.length === 0 ? undefined : Math.min(...ends),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    created: subscription.created,
  };
}

/** Stripe's answer that an object does not exist. */
export function isResourceMissing(error: unknown, param?: string): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError &&
    error.code === 'resource_missing' &&
    (param === undefined || error.param === param)
  );
}

/** The real Stripe client for a restricted secret key, pinned to `STRIPE_API_VERSION`. */
export function createStripeGateway(
  secretKey: string,
  httpClient?: ReturnType<typeof Stripe.createFetchHttpClient>,
): StripeGateway {
  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'askr-server' },
    ...(httpClient === undefined ? {} : { httpClient }),
  });
  return {
    async price(lookupKey) {
      const prices = await stripe.prices.list({
        lookup_keys: [lookupKey],
        active: true,
        expand: ['data.product'],
        limit: 1,
      });
      const [price] = prices.data;
      return price === undefined ? undefined : planOfPrice(price);
    },
    async createCheckoutSession(params) {
      const session = await stripe.checkout.sessions.create(params);
      return { id: session.id, url: session.url };
    },
    async expireCheckoutSession(id) {
      await stripe.checkout.sessions.expire(id);
    },
    async createPortalSession(params) {
      const session = await stripe.billingPortal.sessions.create(params);
      return { url: session.url };
    },
    async subscription(id) {
      try {
        return snapshotOf(
          await stripe.subscriptions.retrieve(id, { expand: ['items.data.price.product'] }),
        );
      } catch (error) {
        if (isResourceMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

/**
 * A webhook event whose signature checks out against `secret` (over the raw body, within
 * Stripe's default 5 minute tolerance); throws otherwise.
 */
export function verifyWebhook(
  payload: string,
  header: string,
  secret: string,
): Promise<Stripe.Event> {
  return Stripe.webhooks.constructEventAsync(payload, header, secret);
}
