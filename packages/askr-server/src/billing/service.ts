import type Stripe from 'stripe';
import * as z from 'zod';
import { type FreeTier, publicBaseOf } from '../config';
import type { Db, Queryable } from '../db/db';
import { WindowLimiter } from '../gateway/limits';
import {
  BillingDirectory,
  LIVE_STATUSES,
  MissingTierError,
  type PlanOutcome,
  markSubscriptionGone,
  noteCustomer,
  operatorManaged,
  ownerOfCustomer,
  reconcilePlan,
  saveSubscription,
  storeNow,
  subscriptionOwner,
} from '../state/billing';
import {
  type BillingInterval,
  PAID_PLANS,
  type PaidPlan,
  STORE_METADATA,
  type StripeGateway,
  type SubscriptionSnapshot,
  isResourceMissing,
  lookupKeyOf,
  verifyWebhook,
} from './stripe';

export const WEBHOOK_PATH = '/v1/stripe/webhook';
/** The query flag the admin reads on its return from Checkout. */
export const BILLING_RETURN_PARAM = 'billing';

/** The events billing applies; any other is acknowledged and ignored. */
export const WEBHOOK_EVENTS: readonly string[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

/** Checkout sessions one store may open per hour: each is a Stripe call. */
const CHECKOUTS_PER_OWNER_PER_HOUR = 20;
const PORTALS_PER_OWNER_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
/** Webhooks one instance applies or holds in its queue at most; past it, 503 and Stripe retries. */
export const MAX_QUEUED_WEBHOOKS = 50;

const CheckoutRequestSchema = z.object({
  plan: z.enum(PAID_PLANS),
  interval: z.enum(['month', 'year']),
});

/** What the admin view shows of a store's billing (`GET /v1/admin/store`). */
export interface BillingView {
  /** The server takes payments (both Stripe secrets are set). */
  enabled: boolean;
  plan: PaidPlan | null;
  interval: BillingInterval | null;
  /** Stripe's subscription status: `active`, `past_due` (payment failed, retrying), `canceled`... */
  status: string | null;
  /** Unix seconds: when the plan renews, or ends with `cancelAtPeriodEnd`. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** The billing portal can open: the store has a Stripe customer. */
  manageable: boolean;
  /** A checkout may start: billing is on, the store is ours to bill and has no live subscription. */
  checkoutAvailable: boolean;
  /** We set this store's plan by hand (or suspended it): its plan changes go through us. */
  operatorManaged: boolean;
}

export const BILLING_OFF: BillingView = {
  enabled: false,
  plan: null,
  interval: null,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  manageable: false,
  checkoutAvailable: false,
  operatorManaged: false,
};

export interface BillingDeps {
  db: Db;
  stripe: StripeGateway;
  webhookSecret: string;
  /** The configured public base: Checkout and the portal return to `<base>/admin/`. */
  publicBase: string;
  /** Tiers the paid plans name must exist before a checkout starts. */
  tierExists: (name: string) => Promise<boolean>;
  /** Where a store whose paid plan ended goes, within its caps; unset: pending. */
  freeTier?: FreeTier;
  /** Called after an event changed a store, so this instance serves and publishes at once. */
  storesChanged: () => void;
  now?: () => number;
  /** Unix milliseconds: when a subscription was read from Stripe. */
  nowMs?: () => number;
  log?: (message: string) => void;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : value.id;
}

/** The subscription an event is about, and the store and customer it names when it does. */
interface EventSubject {
  subscriptionId: string | undefined;
  owner: string | undefined;
  customer: string | undefined;
}

function subjectOf(event: Stripe.Event): EventSubject {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      return {
        subscriptionId: session.mode === 'subscription' ? idOf(session.subscription) : undefined,
        owner: session.client_reference_id ?? session.metadata?.[STORE_METADATA],
        customer: idOf(session.customer),
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      return {
        subscriptionId: subscription.id,
        owner: subscription.metadata[STORE_METADATA],
        customer: idOf(subscription.customer),
      };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      return {
        subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
        owner: invoice.parent?.subscription_details?.metadata?.[STORE_METADATA],
        customer: idOf(invoice.customer),
      };
    }
    default:
      return { subscriptionId: undefined, owner: undefined, customer: undefined };
  }
}

interface Applied {
  outcome: PlanOutcome | 'ignored';
  owner?: string;
}

/**
 * Paid plans through Stripe Checkout with Managed Payments (6.1): checkout and portal sessions
 * for the admin API, and the webhook that applies what Stripe says. A tier is only ever read from
 * the subscription Stripe holds, never from a request.
 */
export class BillingService {
  readonly directory: BillingDirectory;
  private readonly now: () => number;
  private readonly nowMs: () => number;
  private readonly log: (message: string) => void;
  private readonly adminUrl: string;
  private readonly checkoutsPerOwner = new WindowLimiter(CHECKOUTS_PER_OWNER_PER_HOUR, HOUR_MS);
  private readonly portalsPerOwner = new WindowLimiter(PORTALS_PER_OWNER_PER_HOUR, HOUR_MS);
  private webhookQueue: Promise<void> = Promise.resolve();
  /** Webhooks being applied or waiting their turn on this instance. */
  private webhooksQueued = 0;

  constructor(private readonly deps: BillingDeps) {
    this.directory = new BillingDirectory(deps.db);
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.log = deps.log ?? (() => undefined);
    this.adminUrl = `${publicBaseOf(deps.publicBase)}/admin/`;
  }

  async view(owner: string): Promise<BillingView> {
    const subscriptions = await this.directory.subscriptions(owner);
    // The same order reconciling uses: the first live one is the store's plan; with none live,
    // the latest Stripe made.
    const live = subscriptions.find((entry) => LIVE_STATUSES.includes(entry.status));
    const shown = live ?? subscriptions.at(-1);
    const state = await this.directory.planState(owner);
    const managed = state !== undefined && (state.status === 'suspended' || operatorManaged(state));
    const ours = state !== undefined && !managed;
    return {
      enabled: true,
      plan: shown?.plan ?? null,
      interval: shown?.interval ?? null,
      status: shown?.status ?? null,
      currentPeriodEnd: shown?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: shown?.cancelAtPeriodEnd ?? false,
      manageable: (await this.directory.customerOf(owner)) !== undefined,
      checkoutAvailable: ours && live === undefined,
      operatorManaged: managed,
    };
  }

  /** `POST /v1/admin/billing/checkout` for the signed-in owner's store: `{url}` to pay at. */
  async checkout(owner: string, body: string): Promise<Response> {
    const parsed = CheckoutRequestSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      return json({ error: 'bad_request' }, 400);
    }
    const { plan, interval } = parsed.data;
    const state = await this.directory.planState(owner);
    if (state === undefined) {
      return json({ error: 'no_store' }, 404);
    }
    if (state.status === 'suspended') {
      return json({ error: 'suspended' }, 409);
    }
    if (operatorManaged(state)) {
      return json({ error: 'operator_managed' }, 409);
    }
    const subscriptions = await this.directory.subscriptions(owner);
    if (subscriptions.some((entry) => LIVE_STATUSES.includes(entry.status))) {
      return json({ error: 'subscription_exists' }, 409);
    }
    if (!this.checkoutsPerOwner.hit(owner, this.now() * 1000)) {
      return json({ error: 'rate_limited' }, 429);
    }
    if (!(await this.deps.tierExists(plan))) {
      this.log(`checkout for ${owner} refused: the tier ${plan} does not exist`);
      return json({ error: 'plan_unavailable' }, 503);
    }
    const lookupKey = lookupKeyOf(plan, interval);
    let price: Awaited<ReturnType<StripeGateway['price']>>;
    try {
      price = await this.deps.stripe.price(lookupKey);
    } catch (error) {
      this.log(`checkout for ${owner}: reading the price ${lookupKey} failed: ${errorText(error)}`);
      return json({ error: 'billing_failed' }, 502);
    }
    if (price === undefined || price.plan !== plan || price.interval !== interval) {
      this.log(`checkout for ${owner} refused: no active Askr price ${lookupKey}`);
      return json({ error: 'plan_unavailable' }, 503);
    }
    const customer = await this.directory.customerOf(owner);
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      managed_payments: { enabled: true },
      line_items: [{ price: price.id, quantity: 1 }],
      client_reference_id: owner,
      metadata: { [STORE_METADATA]: owner },
      subscription_data: { metadata: { [STORE_METADATA]: owner } },
      success_url: `${this.adminUrl}?${BILLING_RETURN_PARAM}=success`,
      cancel_url: `${this.adminUrl}?${BILLING_RETURN_PARAM}=canceled`,
    };
    // The new session replaces the store's last one under the store row's lock, and the one it
    // replaced is expired: two tabs (or two `askr plan` runs), even at once, leave one session
    // that can be paid. One already paid or expired is left as is.
    try {
      const session = await this.createCheckout(owner, params, customer);
      if (session.url === null) {
        this.log(`checkout for ${owner}: Stripe answered a session without a url`);
        return json({ error: 'billing_failed' }, 502);
      }
      const previous = await this.directory.swapCheckout(owner, session.id, this.now());
      if (previous !== undefined) {
        await this.deps.stripe.expireCheckoutSession(previous).catch(() => undefined);
      }
      return json({ url: session.url }, 200);
    } catch (error) {
      this.log(`checkout for ${owner} failed: ${errorText(error)}`);
      return json({ error: 'billing_failed' }, 502);
    }
  }

  /** With the store's customer; one Stripe no longer has is forgotten and the session made anew. */
  private async createCheckout(
    owner: string,
    params: Stripe.Checkout.SessionCreateParams,
    customer: string | undefined,
  ): Promise<{ id: string; url: string | null }> {
    if (customer !== undefined) {
      try {
        return await this.deps.stripe.createCheckoutSession({ ...params, customer });
      } catch (error) {
        if (!isResourceMissing(error, 'customer')) {
          throw error;
        }
        await this.directory.forgetCustomer(owner, customer);
      }
    }
    return this.deps.stripe.createCheckoutSession(params);
  }

  /** `POST /v1/admin/billing/portal`: `{url}` of the customer portal for the store's customer. */
  async portal(owner: string): Promise<Response> {
    const customer = await this.directory.customerOf(owner);
    if (customer === undefined) {
      return json({ error: 'no_customer' }, 404);
    }
    if (!this.portalsPerOwner.hit(owner, this.now() * 1000)) {
      return json({ error: 'rate_limited' }, 429);
    }
    try {
      const session = await this.deps.stripe.createPortalSession({
        customer,
        return_url: this.adminUrl,
      });
      return json({ url: session.url }, 200);
    } catch (error) {
      // A customer Stripe deleted (the owner asked Link to delete their data): forgotten, so the
      // store can check out again instead of failing here forever.
      if (isResourceMissing(error, 'customer')) {
        await this.directory.forgetCustomer(owner, customer);
        return json({ error: 'no_customer' }, 404);
      }
      this.log(`billing portal for ${owner} failed: ${errorText(error)}`);
      return json({ error: 'billing_failed' }, 502);
    }
  }

  /**
   * `POST /v1/stripe/webhook`: a signed event over the raw body, applied once. 400 for a missing
   * or bad signature, 500 when applying failed (Stripe retries), 200 otherwise.
   */
  async webhook(payload: string, signature: string | null): Promise<Response> {
    // A queue past its bound answers busy at once: Stripe retries the event later, and a flood of
    // requests never piles up in memory.
    if (this.webhooksQueued >= MAX_QUEUED_WEBHOOKS) {
      return json({ error: 'busy' }, 503);
    }
    this.webhooksQueued += 1;
    // One event at a time per instance, in the order they came: a burst holds at most one
    // database connection, and on one instance a later read of a subscription is applied later.
    const turn = this.webhookQueue
      .then(() => this.handleWebhook(payload, signature))
      .finally(() => {
        this.webhooksQueued -= 1;
      });
    this.webhookQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async handleWebhook(payload: string, signature: string | null): Promise<Response> {
    if (signature === null || signature === '') {
      return json({ error: 'unsigned' }, 400);
    }
    let event: Stripe.Event;
    try {
      event = await verifyWebhook(payload, signature, this.deps.webhookSecret);
    } catch {
      return json({ error: 'bad_signature' }, 400);
    }
    if (!WEBHOOK_EVENTS.includes(event.type)) {
      return json({ received: true, ignored: true }, 200);
    }
    const subject = subjectOf(event);
    if (await this.directory.eventSeen(event.id)) {
      return json({ received: true, duplicate: true }, 200);
    }
    let applied: { duplicate: true } | { duplicate: false; result: Applied };
    try {
      // Read again from Stripe, with no transaction open and no lock held (so a Free choice never
      // waits on Stripe): events come in any order, the subscription now is what counts.
      const fetchedAt = this.nowMs();
      const snapshot =
        subject.subscriptionId === undefined
          ? undefined
          : await this.deps.stripe.subscription(subject.subscriptionId);
      applied = await this.directory.onceForEvent(event.id, event.type, this.now(), (tx) =>
        this.apply(tx, subject, snapshot, fetchedAt),
      );
    } catch (error) {
      const reason =
        error instanceof MissingTierError
          ? `the tier ${error.tier} does not exist: create it (askr-server tier set ${error.tier} ...), Stripe retries`
          : errorText(error);
      this.log(`stripe event ${event.id} (${event.type}) not applied: ${reason}`);
      return json({ error: 'not_applied' }, 500);
    }
    if (applied.duplicate) {
      return json({ received: true, duplicate: true }, 200);
    }
    const { result } = applied;
    if (result.owner !== undefined) {
      this.log(`stripe event ${event.id} (${event.type}): store ${result.owner} ${result.outcome}`);
    }
    if (result.outcome === 'paid' || result.outcome === 'free' || result.outcome === 'pending') {
      this.deps.storesChanged();
    }
    return json({ received: true }, 200);
  }

  private async apply(
    tx: Queryable,
    subject: EventSubject,
    snapshot: SubscriptionSnapshot | undefined,
    fetchedAt: number,
  ): Promise<Applied> {
    const subscriptionId = subject.subscriptionId;
    if (subscriptionId === undefined) {
      return { outcome: 'ignored' };
    }
    const recorded = await subscriptionOwner(tx, subscriptionId);
    const owner =
      recorded ??
      (await storeNow(tx, snapshot?.store)) ??
      (await storeNow(tx, subject.owner)) ??
      (await ownerOfCustomer(tx, snapshot?.customer ?? subject.customer));
    if (owner === undefined) {
      this.log(`stripe subscription ${subscriptionId} names no Askr store: ignored`);
      return { outcome: 'ignored' };
    }
    const now = this.now();
    if (snapshot === undefined) {
      await markSubscriptionGone(tx, subscriptionId, now, fetchedAt);
    } else {
      // A subscription we never recorded on a price that is not ours is someone else's. One we
      // recorded keeps its plan, and its status still counts: a cancel must end the paid plan.
      if (snapshot.plan === undefined && recorded === undefined) {
        this.log(`stripe subscription ${subscriptionId} is not on an Askr price: ignored`);
        return { outcome: 'ignored' };
      }
      await noteCustomer(tx, owner, snapshot.customer, now);
      await saveSubscription(tx, owner, snapshot, now, fetchedAt);
    }
    const reconciled = await reconcilePlan(tx, owner, this.deps.freeTier, now);
    if (reconciled.live.length > 1) {
      this.log(
        `duplicate live subscription for store ${owner}: ${reconciled.live.join(', ')}; the earliest is applied, cancel and refund the others`,
      );
    }
    return { outcome: reconciled.outcome, owner };
  }
}

/** The webhook route, or undefined for other paths; 503 while billing is off. */
export function createStripeWebhook(
  billing: BillingService | undefined,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH) {
      return undefined;
    }
    if (request.method !== 'POST') {
      return json({ error: 'not_found' }, 404);
    }
    if (billing === undefined) {
      return json({ error: 'billing_unavailable' }, 503);
    }
    return billing.webhook(await request.text(), request.headers.get('stripe-signature'));
  };
}
