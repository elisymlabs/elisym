/** The billing tests' Stripe double, admin API and signed webhook deliveries. */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import Stripe from 'stripe';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import { BillingService, WEBHOOK_PATH, createStripeWebhook } from '../src/billing/service';
import {
  type PriceInfo,
  STRIPE_API_VERSION,
  type StripeGateway,
  type SubscriptionSnapshot,
} from '../src/billing/stripe';
import type { FreeTier } from '../src/config';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { type Db, STORES_CHANNEL } from '../src/db/db';
import { StoreDirectory } from '../src/state/stores';
import type { Tier } from '../src/state/types';
import { HOLDER, NOW, stateWith } from './fixtures';

export const BASE = 'https://api.askr.test';
export const WEBHOOK_SECRET = 'whsec_test_secret';
export const PERIOD_END = NOW + 30 * 24 * 60 * 60;

export function tier(name: string, monthlyBudgetUsd = '10'): Tier {
  return {
    name,
    messagesPerSessionPerDay: 20,
    monthlyBudgetUsd,
    ticketsPerStorePerMinute: 30,
    maxProducts: 100,
    syncIntervalMinutes: 60,
    branding: true,
  };
}

/** The eight prices by their literal lookup keys, as set up in Stripe. */
export const PRICES: ReadonlyMap<string, PriceInfo> = new Map(
  (['starter', 'growth', 'pro', 'scale'] as const).flatMap((plan): [string, PriceInfo][] => [
    [`askr_${plan}_monthly`, { id: `price_${plan}_month`, plan, interval: 'month' }],
    [`askr_${plan}_yearly`, { id: `price_${plan}_year`, plan, interval: 'year' }],
  ]),
);

/** Stripe in memory: prices by lookup key, subscriptions by id, and every session asked for. */
export function fakeStripe() {
  const subscriptions = new Map<string, SubscriptionSnapshot>();
  const checkouts: Stripe.Checkout.SessionCreateParams[] = [];
  const portals: Stripe.BillingPortal.SessionCreateParams[] = [];
  const missingCustomers = new Set<string>();
  const expired: string[] = [];
  const prices = new Map(PRICES);
  const control = {
    failPrices: false,
    failCheckout: false,
    failPortal: false,
    /** Refuse the checkout's price as Stripe does a deleted one. */
    missingPrice: false,
    nullUrl: false,
    /** Expiring a session fails, as for one already paid. */
    failExpire: false,
    /** Reading a subscription fails, as when Stripe is down. */
    failSubscription: false,
    retrieved: 0,
    /** Milliseconds each subscription read takes. */
    delayMs: 0,
    /** Subscription reads running now, and the most at once. */
    reading: 0,
    mostReading: 0,
  };
  const missing = (param: string) =>
    new Stripe.errors.StripeInvalidRequestError({
      code: 'resource_missing',
      param,
      message: `No such ${param}`,
      type: 'invalid_request_error',
    });
  const gateway: StripeGateway = {
    async price(lookupKey) {
      if (control.failPrices) {
        throw new Error('stripe is down');
      }
      return prices.get(lookupKey);
    },
    async createCheckoutSession(params) {
      if (control.failCheckout) {
        throw new Error('stripe is down');
      }
      if (typeof params.customer === 'string' && missingCustomers.has(params.customer)) {
        throw missing('customer');
      }
      if (control.missingPrice) {
        throw missing('line_items[0][price]');
      }
      checkouts.push(params);
      const id = `cs_test_${checkouts.length}`;
      return {
        id,
        url: control.nullUrl ? null : `https://checkout.stripe.test/c/${checkouts.length}`,
      };
    },
    async expireCheckoutSession(id) {
      if (control.failExpire) {
        throw new Error('This Checkout Session is not open');
      }
      expired.push(id);
    },
    async createPortalSession(params) {
      if (missingCustomers.has(params.customer ?? '')) {
        throw missing('customer');
      }
      if (control.failPortal) {
        throw new Error('stripe is down');
      }
      portals.push(params);
      return { url: `https://billing.stripe.test/p/${portals.length}` };
    },
    async subscription(id) {
      control.retrieved += 1;
      control.reading += 1;
      control.mostReading = Math.max(control.mostReading, control.reading);
      try {
        if (control.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, control.delayMs));
        }
        if (control.failSubscription) {
          throw new Error('stripe is down');
        }
        return subscriptions.get(id);
      } finally {
        control.reading -= 1;
      }
    },
  };
  return { gateway, subscriptions, checkouts, portals, missingCustomers, expired, prices, control };
}

export function authHeader(
  secret: Uint8Array,
  method: string,
  path: string,
  body: string,
  now: number,
) {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: now,
      tags: [
        ['u', `${BASE}${path}`],
        ['method', method],
        ...(body ? [['payload', sha256Hex(body)]] : []),
        ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
      ],
      content: '',
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

export interface Owner {
  secret: Uint8Array;
  pubkey: string;
}

export function newOwner(): Owner {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
}

export const FREE_PLAN: FreeTier = { tier: 'free', perDay: 50, maxActive: 500 };

export async function setup(
  options: { billing?: boolean; freeTier?: FreeTier | null; nowMs?: () => number } = {},
) {
  /** While set, every read of `stripe_events` throws, as when the database drops a query. */
  const failing = { eventSeen: false };
  const base = await stateWith([]);
  /** Transactions open now, and the most at once: the webhook must hold at most one. */
  const transactions = { open: 0, most: 0 };
  const db: Db = {
    ...base.db,
    async query<Row extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      if (failing.eventSeen && sql.includes('from stripe_events')) {
        throw new Error('the database dropped the query');
      }
      return base.db.query<Row>(sql, params);
    },
    async transaction(work) {
      transactions.open += 1;
      transactions.most = Math.max(transactions.most, transactions.open);
      try {
        return await base.db.transaction(work);
      } finally {
        transactions.open -= 1;
      }
    },
  };
  const seeded = { ...base, db, directory: new StoreDirectory(db, base.vault) };
  for (const name of ['free', 'starter', 'growth', 'pro', 'scale', 'enterprise']) {
    await seeded.directory.setTier(tier(name));
  }
  const stripe = fakeStripe();
  const clock = { now: NOW };
  const logs: string[] = [];
  const changed: string[] = [];
  const notified: string[] = [];
  await seeded.db.listen(STORES_CHANNEL, () => notified.push('stores'));
  const freeTier = options.freeTier === undefined ? FREE_PLAN : (options.freeTier ?? undefined);
  const billing =
    options.billing === false
      ? undefined
      : new BillingService({
          db: seeded.db,
          stripe: stripe.gateway,
          webhookSecret: WEBHOOK_SECRET,
          publicBase: `${BASE}/`,
          tierExists: (name) => seeded.directory.tierExists(name),
          ...(freeTier === undefined ? {} : { freeTier }),
          storesChanged: () => changed.push('changed'),
          now: () => clock.now,
          ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
          log: (message) => logs.push(message),
        });
  const api = createAdminApi({
    directory: seeded.directory,
    publicBase: BASE,
    syncClient: {
      async query() {
        return [];
      },
      async publish() {
        return undefined;
      },
    },
    storeEventsChanged: () => undefined,
    connectors: new ConnectorService({
      directory: seeded.directory,
      holder: HOLDER,
      client: {
        async query() {
          return [];
        },
        async publish() {
          return undefined;
        },
      },
      configFor: () => undefined,
      limiter: new ShopRateLimiter(0),
    }),
    ...(freeTier === undefined ? {} : { freeTier }),
    ...(billing === undefined ? {} : { billing }),
    now: () => clock.now,
    log: (message) => logs.push(message),
  });
  const call = async (owner: Owner, method: string, path: string, body?: unknown) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const response = await api({
      request: new Request(`http://internal:8787${path}`, {
        method,
        headers: { authorization: authHeader(owner.secret, method, path, text, clock.now) },
        ...(text ? { body: text } : {}),
      }),
      clientAddress: '203.0.113.9',
    });
    if (!response) {
      throw new Error('not an admin path');
    }
    return { status: response.status, body: await response.json() };
  };
  const webhook = createStripeWebhook(billing);
  /** Deliver a signed event, as Stripe does. */
  const deliver = async (
    event: { id: string; type: string; object: Record<string, unknown> },
    signature?: string | null,
  ) => {
    const payload = JSON.stringify({
      id: event.id,
      object: 'event',
      type: event.type,
      api_version: STRIPE_API_VERSION,
      created: clock.now,
      data: { object: event.object },
    });
    const header =
      signature === undefined
        ? await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET })
        : signature;
    const response = await webhook(
      new Request(`http://internal:8787${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: header === null ? {} : { 'stripe-signature': header },
        body: payload,
      }),
    );
    if (!response) {
      throw new Error('not the webhook path');
    }
    return { status: response.status, body: await response.json() };
  };
  const open = async (owner: Owner) => call(owner, 'POST', '/v1/admin/store');
  const checkout = (owner: Owner, plan: string, interval = 'month') =>
    call(owner, 'POST', '/v1/admin/billing/checkout', { plan, interval });
  const statusOf = (owner: Owner) => seeded.directory.statusOf(owner.pubkey);
  const planSourceOf = async (owner: string) =>
    (
      await seeded.db.query<{ plan_source: string | null }>(
        'select plan_source from stores where owner = $1',
        [owner],
      )
    )[0]?.plan_source;
  /** Stripe's subscription after a paid checkout, and the events it sends. */
  let events = 0;
  const subscribe = (
    owner: string,
    overrides: Partial<SubscriptionSnapshot> = {},
  ): SubscriptionSnapshot => {
    const snapshot: SubscriptionSnapshot = {
      id: `sub_${owner.slice(0, 8)}`,
      customer: `cus_${owner.slice(0, 8)}`,
      status: 'active',
      store: owner,
      plan: 'starter',
      interval: 'month',
      itemId: `si_${owner.slice(0, 8)}`,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      created: NOW,
      billingCycleAnchor: NOW,
      scheduledChange: null,
      ...overrides,
    };
    stripe.subscriptions.set(snapshot.id, snapshot);
    return snapshot;
  };
  const completed = (owner: string, snapshot: SubscriptionSnapshot) => {
    events += 1;
    return deliver({
      id: `evt_${events}`,
      type: 'checkout.session.completed',
      object: {
        id: `cs_${events}`,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: owner,
        metadata: { askr_store: owner },
        customer: snapshot.customer,
        subscription: snapshot.id,
      },
    });
  };
  const subscriptionEvent = (type: string, snapshot: SubscriptionSnapshot) => {
    events += 1;
    return deliver({
      id: `evt_${events}`,
      type,
      object: {
        id: snapshot.id,
        object: 'subscription',
        customer: snapshot.customer,
        metadata: snapshot.store === undefined ? {} : { askr_store: snapshot.store },
      },
    });
  };
  const invoiceEvent = (type: string, snapshot: SubscriptionSnapshot) => {
    events += 1;
    return deliver({
      id: `evt_${events}`,
      type,
      object: {
        id: `in_${events}`,
        object: 'invoice',
        customer: snapshot.customer,
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: snapshot.id, metadata: {} },
        },
      },
    });
  };
  return {
    ...seeded,
    billing,
    transactions,
    failing,
    stripe,
    clock,
    logs,
    changed,
    notified,
    call,
    open,
    checkout,
    deliver,
    statusOf,
    planSourceOf,
    subscribe,
    completed,
    subscriptionEvent,
    invoiceEvent,
  };
}
