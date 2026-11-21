import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import { nip19 } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { BillingService, MAX_QUEUED_WEBHOOKS, WEBHOOK_PATH } from '../src/billing/service';
import {
  STRIPE_API_VERSION,
  createStripeGateway,
  isResourceMissing,
  planOfPrice,
  snapshotOf,
} from '../src/billing/stripe';
import { runCli } from '../src/cli';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { bodyLimitOf } from '../src/gateway/http';
import { createRoutes } from '../src/gateway/routes';
import { renderServerLlmsTxt } from '../src/gateway/server-llms';
import { reconcilePlan } from '../src/state/billing';
import {
  BASE,
  FREE_PLAN,
  PERIOD_END,
  WEBHOOK_SECRET,
  authHeader,
  fakeStripe,
  newOwner,
  setup,
  tier,
} from './billing-fixtures';
import { HOLDER, NOW, ORIGIN, stateWith } from './fixtures';

const price = (lookupKey: string | null, interval: string, metadata?: Record<string, string>) => ({
  id: 'price_1',
  lookup_key: lookupKey,
  recurring: { interval },
  product: metadata === undefined ? 'prod_1' : { id: 'prod_1', metadata },
});

describe('Stripe objects, strictly', () => {
  it('takes only an exact askr lookup key and a monthly or yearly price', () => {
    expect(planOfPrice(price('askr_pro_monthly_old', 'month'))).toBeUndefined();
    expect(planOfPrice(price('xaskr_pro_monthly', 'month'))).toBeUndefined();
    expect(planOfPrice(price(null, 'week', { askr_tier: 'pro' }))).toBeUndefined();
    expect(planOfPrice(price(null, 'year', { askr_tier: 'pro' }))).toMatchObject({
      interval: 'year',
    });
  });

  it('reads no interval from several items and no period end from none', () => {
    const item = {
      id: 'si_1',
      current_period_end: PERIOD_END,
      price: price('askr_pro_yearly', 'year', { askr_tier: 'pro' }),
    };
    const base = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      metadata: {},
      cancel_at: null,
      cancel_at_period_end: false,
      created: NOW,
    };
    expect(snapshotOf({ ...base, items: { data: [item, item] } }).interval).toBeUndefined();
    expect(snapshotOf({ ...base, items: { data: [] } }).currentPeriodEnd).toBeUndefined();
    expect(snapshotOf({ ...base, items: { data: [item] } })).toMatchObject({
      customer: 'cus_1',
      created: NOW,
    });
  });

  it('calls only an invalid request about the named param a missing resource', () => {
    const missing = (param: string) =>
      new Stripe.errors.StripeInvalidRequestError({
        code: 'resource_missing',
        param,
        message: 'gone',
        type: 'invalid_request_error',
      });
    expect(isResourceMissing(missing('customer'), 'customer')).toBe(true);
    expect(isResourceMissing(missing('line_items[0][price]'), 'customer')).toBe(false);
    expect(isResourceMissing(missing('line_items[0][price]'))).toBe(true);
    expect(isResourceMissing(Object.assign(new Error('gone'), { code: 'resource_missing' }))).toBe(
      false,
    );
  });

  it("pins the SDK's own API version", () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });
});

/** A Stripe API over a stub fetch: every request it was sent, answered by `answer`. */
function stubStripe(answer: (url: URL) => { status: number; body: unknown }) {
  const requests: { url: URL; headers: Headers; method: string }[] = [];
  const fetcher = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers), method: init?.method ?? 'GET' });
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
    });
  };
  const gateway = createStripeGateway('rk_test_stub', Stripe.createFetchHttpClient(fetcher));
  return { gateway, requests };
}

describe('the real Stripe client, over a stub fetch', () => {
  const product = { id: 'prod_pro', object: 'product', metadata: { askr_tier: 'pro' } };
  const proPrice = {
    id: 'price_pro_year',
    object: 'price',
    lookup_key: 'askr_pro_yearly',
    recurring: { interval: 'year' },
    product,
  };

  it('lists the active price of the lookup key with its product expanded, on the pinned version', async () => {
    const { gateway, requests } = stubStripe(() => ({
      status: 200,
      body: { object: 'list', data: [proPrice], has_more: false, url: '/v1/prices' },
    }));
    expect(await gateway.price('askr_pro_yearly')).toEqual({
      id: 'price_pro_year',
      plan: 'pro',
      interval: 'year',
    });
    const [request] = requests;
    expect(request?.url.pathname).toBe('/v1/prices');
    expect(request?.url.searchParams.get('lookup_keys[0]')).toBe('askr_pro_yearly');
    expect(request?.url.searchParams.get('active')).toBe('true');
    expect(request?.url.searchParams.get('expand[0]')).toBe('data.product');
    expect(request?.headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
  });

  it('reads a subscription with its price products expanded, and a missing one as undefined', async () => {
    const subscription = {
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      metadata: { askr_store: 'ab'.repeat(32) },
      cancel_at_period_end: false,
      created: NOW,
      items: {
        object: 'list',
        data: [{ id: 'si_1', current_period_end: PERIOD_END, price: proPrice }],
      },
    };
    const { gateway, requests } = stubStripe((url) =>
      url.pathname.endsWith('/sub_1')
        ? { status: 200, body: subscription }
        : {
            status: 404,
            body: {
              error: {
                type: 'invalid_request_error',
                code: 'resource_missing',
                param: 'id',
                message: 'No such subscription',
              },
            },
          },
    );
    expect(await gateway.subscription('sub_1')).toMatchObject({ plan: 'pro', created: NOW });
    expect(requests[0]?.url.searchParams.get('expand[0]')).toBe('items.data.price.product');
    expect(requests[0]?.url.searchParams.get('expand[1]')).toBe('schedule.phases.items.price');
    expect(requests[0]?.url.searchParams.getAll('expand[2]')).toEqual([]);
    expect(await gateway.subscription('sub_gone')).toBeUndefined();
  });

  it('rethrows any other Stripe failure', async () => {
    const { gateway } = stubStripe(() => ({
      status: 400,
      body: { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'bad' } },
    }));
    await expect(gateway.subscription('sub_1')).rejects.toThrow('bad');
  });
});

describe('the webhook signature', () => {
  it('refuses a signature older than five minutes, an empty one as unsigned', async () => {
    const { deliver, billing } = await setup();
    const payload = JSON.stringify({ id: 'evt_old', type: 'invoice.paid', data: { object: {} } });
    const signed = (secondsAgo: number) =>
      Stripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret: WEBHOOK_SECRET,
        timestamp: Math.floor(Date.now() / 1000) - secondsAgo,
      });
    expect((await billing?.webhook(payload, await signed(250)))?.status).toBe(200);
    const old = await billing?.webhook(payload, await signed(301));
    expect(old?.status).toBe(400);
    expect(await old?.json()).toEqual({ error: 'bad_signature' });
    const event = { id: 'evt_empty', type: 'invoice.paid', object: {} };
    expect(await deliver(event, '')).toEqual({ status: 400, body: { error: 'unsigned' } });
  });

  it('gives only a POST to it the webhook body cap', () => {
    expect(bodyLimitOf('PUT', WEBHOOK_PATH, undefined)).toBe(16 * 1024);
  });
});

describe('checkout and portal, every refusal', () => {
  it('caps checkouts at 20 and portals at 30 per store per hour', async () => {
    const { open, checkout, call, subscribe, completed, subscriptionEvent } = await setup();
    const owner = newOwner();
    await open(owner);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await checkout(owner, 'pro')).status).toBe(200);
    }
    expect(await checkout(owner, 'pro')).toEqual({ status: 429, body: { error: 'rate_limited' } });
    const portal = newOwner();
    await open(portal);
    const snapshot = subscribe(portal.pubkey);
    await completed(portal.pubkey, snapshot);
    subscribe(portal.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await call(portal, 'POST', '/v1/admin/billing/portal')).status).toBe(200);
    }
    expect((await call(portal, 'POST', '/v1/admin/billing/portal')).status).toBe(429);
  });

  it('refuses a price whose product names another plan or bills another interval', async () => {
    const { open, checkout, stripe } = await setup();
    const owner = newOwner();
    await open(owner);
    stripe.prices.set('askr_pro_monthly', { id: 'price_x', plan: 'scale', interval: 'month' });
    stripe.prices.set('askr_pro_yearly', { id: 'price_y', plan: 'pro', interval: 'month' });
    expect(await checkout(owner, 'pro')).toEqual({
      status: 503,
      body: { error: 'plan_unavailable' },
    });
    expect(await checkout(owner, 'pro', 'year')).toEqual({
      status: 503,
      body: { error: 'plan_unavailable' },
    });
    expect(stripe.checkouts).toEqual([]);
  });

  it('answers billing_failed for a session without a url, and remembers no session', async () => {
    const { open, checkout, stripe, billing } = await setup();
    const owner = newOwner();
    await open(owner);
    stripe.control.nullUrl = true;
    expect(await checkout(owner, 'pro')).toEqual({
      status: 502,
      body: { error: 'billing_failed' },
    });
    expect(await billing?.directory.lastCheckout(owner.pubkey)).toBeUndefined();
  });

  it('keeps the customer when Stripe refuses another missing resource (the price)', async () => {
    const { open, checkout, stripe, subscribe, completed, subscriptionEvent, billing } =
      await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    subscribe(owner.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    stripe.control.missingPrice = true;
    expect(await checkout(owner, 'pro')).toEqual({
      status: 502,
      body: { error: 'billing_failed' },
    });
    expect(await billing?.directory.customerOf(owner.pubkey)).toBe(snapshot.customer);
  });

  it('expires the store previous open session before a new one, and goes on when it cannot', async () => {
    const { open, checkout, stripe, billing } = await setup();
    const owner = newOwner();
    await open(owner);
    await checkout(owner, 'pro');
    expect(stripe.expired).toEqual([]);
    await checkout(owner, 'growth');
    expect(stripe.expired).toEqual(['cs_test_1']);
    stripe.control.failExpire = true;
    expect((await checkout(owner, 'scale')).status).toBe(200);
    expect(await billing?.directory.lastCheckout(owner.pubkey)).toBe('cs_test_3');
  });

  it('answers no_store for a store that does not exist', async () => {
    const { billing } = await setup();
    const response = await billing?.checkout('cd'.repeat(32), '{"plan":"pro","interval":"month"}');
    expect(response?.status).toBe(404);
  });

  it('answers billing_failed when the portal fails, and forgets a customer Stripe deleted', async () => {
    const { open, call, stripe, subscribe, completed } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    stripe.control.failPortal = true;
    expect(await call(owner, 'POST', '/v1/admin/billing/portal')).toEqual({
      status: 502,
      body: { error: 'billing_failed' },
    });
    stripe.control.failPortal = false;
    stripe.missingCustomers.add(snapshot.customer);
    expect(await call(owner, 'POST', '/v1/admin/billing/portal')).toEqual({
      status: 404,
      body: { error: 'no_customer' },
    });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing.manageable).toBe(false);
  });
});

describe('the billing view', () => {
  it('shows the live subscription over a later ended one', async () => {
    const { open, completed, subscribe, call } = await setup();
    const owner = newOwner();
    await open(owner);
    await completed(owner.pubkey, subscribe(owner.pubkey, { id: 'sub_live', plan: 'pro' }));
    await completed(
      owner.pubkey,
      subscribe(owner.pubkey, {
        id: 'sub_ended',
        plan: 'scale',
        status: 'canceled',
        created: NOW + 60,
      }),
    );
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      plan: 'pro',
      status: 'active',
    });
  });

  it('offers no checkout to a suspended or operator store, and one with no customer yet', async () => {
    const { open, call, directory, completed, subscribe, db } = await setup();
    const fresh = newOwner();
    await open(fresh);
    expect((await call(fresh, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      manageable: false,
      checkoutAvailable: true,
      operatorManaged: false,
    });
    const suspended = newOwner();
    await open(suspended);
    await directory.setStatus(suspended.pubkey, 'suspended', 'starter');
    expect((await call(suspended, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      checkoutAvailable: false,
      operatorManaged: true,
    });
    // A paying store the operator suspended: still billing's, but no checkout and our call.
    const billed = newOwner();
    await open(billed);
    await completed(billed.pubkey, subscribe(billed.pubkey, { status: 'canceled' }));
    await directory.setStatus(billed.pubkey, 'active', 'starter');
    await db.query(`update stores set plan_source = 'billing' where owner = $1`, [billed.pubkey]);
    await directory.setStatus(billed.pubkey, 'suspended');
    expect((await call(billed, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      checkoutAvailable: false,
      operatorManaged: true,
    });
    const operator = newOwner();
    await open(operator);
    await directory.setStatus(operator.pubkey, 'active', 'enterprise');
    expect((await call(operator, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      checkoutAvailable: false,
      operatorManaged: true,
    });
  });

  it('follows a renewal: the new period end, and the row updated time', async () => {
    const { open, completed, subscribe, invoiceEvent, call, clock, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    clock.now += 100;
    subscribe(owner.pubkey, { currentPeriodEnd: PERIOD_END + 1000 });
    await invoiceEvent('invoice.paid', snapshot);
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing.currentPeriodEnd).toBe(
      PERIOD_END + 1000,
    );
    expect(await db.query('select updated_at from billing_subscriptions')).toEqual([
      { updated_at: NOW + 100 },
    ]);
  });
});

describe('what each event does', () => {
  it('ignores a payment session and an invoice with no subscription, without reading Stripe', async () => {
    const { deliver, stripe, subscribe, open, statusOf } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    expect(
      (
        await deliver({
          id: 'evt_pay',
          type: 'checkout.session.completed',
          object: { mode: 'payment', client_reference_id: owner.pubkey, subscription: snapshot.id },
        })
      ).status,
    ).toBe(200);
    expect(
      await deliver({ id: 'evt_inv', type: 'invoice.paid', object: { id: 'in_1', customer: 'c' } }),
    ).toEqual({ status: 200, body: { received: true } });
    expect(stripe.control.retrieved).toBe(0);
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
  });

  it('tells the operator the command that creates a missing tier', async () => {
    const { open, completed, subscribe, directory, logs } = await setup();
    const owner = newOwner();
    await open(owner);
    await directory.deleteTier('growth');
    await completed(owner.pubkey, subscribe(owner.pubkey, { plan: 'growth' }));
    expect(logs.some((line) => line.includes('askr-server tier set growth'))).toBe(true);
  });

  it('serves a store at once when it changed, never when nothing did, and logs the store', async () => {
    const { open, completed, subscribe, subscriptionEvent, changed, logs } = await setup({
      freeTier: null,
    });
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    expect(changed).toHaveLength(1);
    expect(logs.at(-1)).toContain(`store ${owner.pubkey} paid`);
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(changed).toHaveLength(1);
    expect(logs.at(-1)).toContain(`store ${owner.pubkey} unchanged`);
    subscribe(owner.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(changed).toHaveLength(2);
    expect(logs.at(-1)).toContain(`store ${owner.pubkey} pending`);
  });

  it('keeps the store it recorded for a subscription over what its metadata says now', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf } = await setup();
    const first = newOwner();
    const other = newOwner();
    await open(first);
    await open(other);
    const snapshot = subscribe(first.pubkey);
    await completed(first.pubkey, snapshot);
    subscribe(first.pubkey, { store: other.pubkey, plan: 'scale' });
    await subscriptionEvent('customer.subscription.updated', { ...snapshot, store: other.pubkey });
    expect(await statusOf(first)).toEqual({ status: 'active', tier: 'scale' });
    expect(await statusOf(other)).toEqual({ status: 'pending', tier: null });
  });

  it('finds the store of a first event from the subscription, the session, its metadata, or the customer', async () => {
    const { open, deliver, subscribe, statusOf } = await setup();
    // invoice.paid comes first, naming no store: the subscription's metadata does.
    const byMetadata = newOwner();
    await open(byMetadata);
    const viaSnapshot = subscribe(byMetadata.pubkey, { id: 'sub_m' });
    await deliver({
      id: 'evt_first_invoice',
      type: 'invoice.paid',
      object: { parent: { subscription_details: { subscription: viaSnapshot.id } } },
    });
    expect(await statusOf(byMetadata)).toEqual({ status: 'active', tier: 'starter' });

    // No metadata on the subscription: the session's client_reference_id.
    const byReference = newOwner();
    await open(byReference);
    await deliver({
      id: 'evt_ref',
      type: 'checkout.session.completed',
      object: {
        mode: 'subscription',
        client_reference_id: byReference.pubkey,
        subscription: subscribe(byReference.pubkey, { id: 'sub_r', store: undefined }).id,
      },
    });
    expect(await statusOf(byReference)).toEqual({ status: 'active', tier: 'starter' });

    // Neither: the session's metadata.
    const bySessionMetadata = newOwner();
    await open(bySessionMetadata);
    await deliver({
      id: 'evt_session_metadata',
      type: 'checkout.session.completed',
      object: {
        mode: 'subscription',
        metadata: { askr_store: bySessionMetadata.pubkey },
        subscription: subscribe(bySessionMetadata.pubkey, { id: 'sub_s', store: undefined }).id,
      },
    });
    expect(await statusOf(bySessionMetadata)).toEqual({ status: 'active', tier: 'starter' });

    // A subscription event's own metadata, and an invoice's.
    const bySubscriptionEvent = newOwner();
    await open(bySubscriptionEvent);
    await deliver({
      id: 'evt_sub_metadata',
      type: 'customer.subscription.created',
      object: {
        id: subscribe(bySubscriptionEvent.pubkey, { id: 'sub_e', store: undefined }).id,
        metadata: { askr_store: bySubscriptionEvent.pubkey },
      },
    });
    expect(await statusOf(bySubscriptionEvent)).toEqual({ status: 'active', tier: 'starter' });
    const byInvoice = newOwner();
    await open(byInvoice);
    await deliver({
      id: 'evt_invoice_metadata',
      type: 'invoice.paid',
      object: {
        parent: {
          subscription_details: {
            subscription: subscribe(byInvoice.pubkey, { id: 'sub_i', store: undefined }).id,
            metadata: { askr_store: byInvoice.pubkey },
          },
        },
      },
    });
    expect(await statusOf(byInvoice)).toEqual({ status: 'active', tier: 'starter' });
  });

  it('finds the store from a known customer, from Stripe or, when Stripe lost it, the event', async () => {
    const { open, deliver, subscribe, completed, statusOf, logs } = await setup();
    // A second subscription naming no store, and an event with no customer.
    const byCustomer = newOwner();
    await open(byCustomer);
    const first = subscribe(byCustomer.pubkey, { id: 'sub_c1', plan: 'starter' });
    await completed(byCustomer.pubkey, first);
    await deliver({
      id: 'evt_customer',
      type: 'customer.subscription.created',
      object: {
        id: subscribe(byCustomer.pubkey, {
          id: 'sub_c2',
          store: undefined,
          customer: first.customer,
          created: NOW - 10,
          plan: 'pro',
        }).id,
        metadata: {},
      },
    });
    expect(await statusOf(byCustomer)).toEqual({ status: 'active', tier: 'pro' });

    // Stripe no longer has the subscription: only the event's customer names the store.
    for (const [type, object] of [
      ['checkout.session.completed', { mode: 'subscription', subscription: 'sub_gone1' }],
      ['customer.subscription.deleted', { id: 'sub_gone2', metadata: {} }],
      [
        'invoice.payment_failed',
        { parent: { subscription_details: { subscription: 'sub_gone3' } } },
      ],
    ] as const) {
      logs.length = 0;
      await deliver({ id: `evt_${type}`, type, object: { ...object, customer: first.customer } });
      expect(logs.at(-1), type).toContain(`store ${byCustomer.pubkey} unchanged`);
    }
  });

  it('ends a recorded subscription whose price is no longer one of ours', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    subscribe(owner.pubkey, { plan: undefined, interval: undefined, status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
  });

  it('keeps the recorded plan of a live subscription whose price is no longer one of ours', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf, call } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey, { plan: 'pro', interval: 'year' });
    await completed(owner.pubkey, snapshot);
    subscribe(owner.pubkey, { plan: undefined, interval: undefined });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      plan: 'pro',
      interval: 'year',
    });
  });

  it('marks a subscription Stripe deleted canceled, no longer set to cancel', async () => {
    const { open, completed, subscribe, subscriptionEvent, stripe, call } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey, { cancelAtPeriodEnd: true });
    await completed(owner.pubkey, snapshot);
    stripe.subscriptions.delete(snapshot.id);
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      status: 'canceled',
      cancelAtPeriodEnd: false,
    });
  });

  it('keeps a store its first customer, and records no empty customer', async () => {
    const { open, completed, subscribe, subscriptionEvent, billing, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const first = subscribe(owner.pubkey);
    await completed(owner.pubkey, first);
    subscribe(owner.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', first);
    await completed(
      owner.pubkey,
      subscribe(owner.pubkey, { id: 'sub_2', customer: 'cus_other', created: NOW + 1 }),
    );
    expect(await billing?.directory.customerOf(owner.pubkey)).toBe(first.customer);
    const blank = newOwner();
    await open(blank);
    await completed(blank.pubkey, subscribe(blank.pubkey, { id: 'sub_blank', customer: '' }));
    expect(
      await db.query('select 1 from billing_customers where owner = $1', [blank.pubkey]),
    ).toEqual([]);
  });

  it('never looks up an empty customer', async () => {
    const { open, deliver, db, statusOf, logs } = await setup();
    const owner = newOwner();
    await open(owner);
    await db.query(
      `insert into billing_customers (owner, customer_id, created_at) values ($1, '', $2)`,
      [owner.pubkey, NOW],
    );
    await deliver({
      id: 'evt_blank',
      type: 'customer.subscription.deleted',
      object: { id: 'sub_unknown', metadata: {}, customer: '' },
    });
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    expect(logs).toContain('stripe subscription sub_unknown names no Askr store: ignored');
  });
});

describe('each subscription status', () => {
  it('puts a trialing subscription on its tier; leaves a pending store pending while incomplete', async () => {
    const { open, completed, subscribe, statusOf } = await setup();
    const trial = newOwner();
    await open(trial);
    await completed(trial.pubkey, subscribe(trial.pubkey, { status: 'trialing', plan: 'pro' }));
    expect(await statusOf(trial)).toEqual({ status: 'active', tier: 'pro' });
    const incomplete = newOwner();
    await open(incomplete);
    await completed(incomplete.pubkey, subscribe(incomplete.pubkey, { status: 'incomplete' }));
    expect(await statusOf(incomplete)).toEqual({ status: 'pending', tier: null });
  });

  it('ends the plan of an unpaid subscription', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    subscribe(owner.pubkey, { status: 'unpaid' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
  });

  it('never puts a never-paid pending store on Free, nor moves a Free store whose checkout lapsed', async () => {
    const { open, completed, subscribe, statusOf, directory, db } = await setup();
    const pending = newOwner();
    await open(pending);
    for (const [id, status] of [
      ['sub_x1', 'incomplete_expired'],
      ['sub_x2', 'canceled'],
    ] as const) {
      await completed(pending.pubkey, subscribe(pending.pubkey, { id, status }));
      expect(await statusOf(pending)).toEqual({ status: 'pending', tier: null });
    }
    const free = newOwner();
    await open(free);
    await directory.activateFree(free.pubkey, 'free', NOW - 500, FREE_PLAN);
    await completed(free.pubkey, subscribe(free.pubkey, { status: 'incomplete_expired' }));
    expect(await statusOf(free)).toEqual({ status: 'active', tier: 'free' });
    expect(
      await db.query('select auto_activated_at from stores where owner = $1', [free.pubkey]),
    ).toEqual([{ auto_activated_at: NOW - 500 }]);
  });

  it('treats a tier with no plan source as the operator store', async () => {
    const { open, checkout, completed, subscribe, statusOf, db } = await setup();
    const owner = newOwner();
    await open(owner);
    await db.query(
      `update stores set status = 'active', tier = 'enterprise', plan_source = null where owner = $1`,
      [owner.pubkey],
    );
    expect((await checkout(owner, 'pro')).body).toEqual({ error: 'operator_managed' });
    await completed(owner.pubkey, subscribe(owner.pubkey));
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'enterprise' });
  });

  it('reactivates a billed store the operator set back to pending, and claims a paid tier it shares', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf, directory, planSourceOf, db } =
      await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    expect(await directory.setStatus(owner.pubkey, 'pending')).toBe(true);
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'starter' });
    await db.query(`update stores set plan_source = 'free' where owner = $1`, [owner.pubkey]);
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await planSourceOf(owner.pubkey)).toBe('billing');
  });

  it('notifies the running servers when a plan ends, to Free or to pending with no source', async () => {
    for (const freeTier of [FREE_PLAN, null]) {
      const { open, completed, subscribe, subscriptionEvent, notified, planSourceOf } = await setup(
        { freeTier },
      );
      const owner = newOwner();
      await open(owner);
      const snapshot = subscribe(owner.pubkey);
      await completed(owner.pubkey, snapshot);
      await expect.poll(() => notified.length).toBe(1);
      subscribe(owner.pubkey, { status: 'canceled' });
      await subscriptionEvent('customer.subscription.deleted', snapshot);
      await expect.poll(() => notified.length).toBe(2);
      expect(await planSourceOf(owner.pubkey)).toBe(freeTier === null ? null : 'free');
    }
  });

  it('keeps billing on a store the operator only suspends', async () => {
    const { open, completed, subscribe, directory, planSourceOf } = await setup();
    const owner = newOwner();
    await open(owner);
    await completed(owner.pubkey, subscribe(owner.pubkey));
    await directory.setStatus(owner.pubkey, 'suspended');
    expect(await planSourceOf(owner.pubkey)).toBe('billing');
  });
});

describe('reconcilePlan', () => {
  it('answers no_store for a store that does not exist, and skips a live row without a plan', async () => {
    const { db, open, directory } = await setup();
    expect(
      await db.transaction((tx) => reconcilePlan(tx, 'ef'.repeat(32), FREE_PLAN, NOW)),
    ).toEqual({ outcome: 'no_store', live: [] });
    const owner = newOwner();
    await open(owner);
    await db.query(
      `insert into billing_subscriptions (subscription_id, owner, customer_id, status, plan,
         interval, current_period_end, cancel_at_period_end, stripe_created, updated_at,
         snapshot_fetched_at)
       values ('sub_np', $1, 'cus_np', 'active', null, null, null, false, $2, $2, 0)`,
      [owner.pubkey, NOW],
    );
    expect(await db.transaction((tx) => reconcilePlan(tx, owner.pubkey, FREE_PLAN, NOW))).toEqual({
      outcome: 'unchanged',
      live: [],
    });
    expect(await directory.statusOf(owner.pubkey)).toEqual({ status: 'pending', tier: null });
  });
});

describe('the webhook under a burst', () => {
  it('applies one event at a time per instance, so other queries still get the database', async () => {
    const { open, subscribe, deliver, stripe, transactions, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    stripe.control.delayMs = 20;
    let done = 0;
    const burst = Array.from({ length: 12 }, (_unused, index) =>
      deliver({
        id: `evt_burst_${index}`,
        type: 'customer.subscription.updated',
        object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
      }).then((answer) => {
        done += 1;
        return answer;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await db.query('select 1');
    expect(done).toBeLessThan(12);
    const answers = await Promise.all(burst);
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    expect(stripe.control.mostReading).toBe(1);
    expect(transactions.most).toBe(1);
  });
});

describe('createRoutes', () => {
  it('routes the webhook to billing, gives the admin billing, and applies its Free fallback at once', async () => {
    const seeded = await stateWith([]);
    for (const name of ['free', 'starter']) {
      await seeded.directory.setTier(tier(name));
    }
    const stripe = fakeStripe();
    const changed: string[] = [];
    // An hour behind the real clock: the admin's signature window and billing's records follow it.
    const at = NOW - 3_600;
    const logs: string[] = [];
    const client = {
      async query() {
        return [];
      },
      async publish() {
        return undefined;
      },
    };
    const { handler, billing } = createRoutes({
      db: seeded.db,
      directory: seeded.directory,
      publicBase: BASE,
      syncClient: client,
      storeEventsChanged: () => changed.push('changed'),
      connectors: new ConnectorService({
        directory: seeded.directory,
        holder: HOLDER,
        client,
        configFor: () => undefined,
        limiter: new ShopRateLimiter(0),
      }),
      freeTier: FREE_PLAN,
      billingSecrets: { secretKey: 'rk_test', webhookSecret: WEBHOOK_SECRET },
      stripeFor: () => stripe.gateway,
      adminPages: ({ request }) =>
        new URL(request.url).pathname.startsWith('/admin/')
          ? new Response('admin pages')
          : undefined,
      storeDocs: async ({ request }) =>
        new URL(request.url).pathname.startsWith('/s/')
          ? new Response('store docs', { status: 200 })
          : undefined,
      gateway: async () => new Response('gateway', { status: 404 }),
      now: () => at,
      log: (message) => logs.push(message),
    });
    expect(billing).toBeDefined();
    const owner = newOwner();
    const adminCall = async (method: string, path: string, body?: unknown, signer = owner) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      return handler({
        request: new Request(`http://internal${path}`, {
          method,
          headers: { authorization: authHeader(signer.secret, method, path, text, at) },
          ...(text ? { body: text } : {}),
        }),
        clientAddress: '203.0.113.1',
      });
    };
    await adminCall('POST', '/v1/admin/store');
    expect((await (await adminCall('GET', '/v1/admin/store')).json()).billing.enabled).toBe(true);
    // Billing's checkout: its return links under the public base, only for a tier that exists.
    const checkout = await adminCall('POST', '/v1/admin/billing/checkout', {
      plan: 'starter',
      interval: 'month',
    });
    expect(checkout.status).toBe(200);
    expect(stripe.checkouts[0]?.success_url).toBe(`${BASE}/admin/?billing=success`);
    const noTier = await adminCall('POST', '/v1/admin/billing/checkout', {
      plan: 'growth',
      interval: 'month',
    });
    expect(await noTier.json()).toEqual({ error: 'plan_unavailable' });
    expect(stripe.checkouts).toHaveLength(1);
    expect(logs).toContain(`checkout for ${owner.pubkey} refused: the tier growth does not exist`);
    const snapshot = {
      id: 'sub_routes',
      customer: 'cus_routes',
      status: 'active',
      store: owner.pubkey,
      plan: 'starter' as const,
      interval: 'month' as const,
      itemId: 'si_1',
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      created: NOW,
      scheduledChange: null,
    };
    stripe.subscriptions.set(snapshot.id, snapshot);
    const event = async (id: string, type: string) => {
      const payload = JSON.stringify({
        id,
        type,
        data: { object: { id: snapshot.id, metadata: {} } },
      });
      const header = await Stripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret: WEBHOOK_SECRET,
      });
      return handler({
        request: new Request(`http://internal${WEBHOOK_PATH}`, {
          method: 'POST',
          headers: { 'stripe-signature': header },
          body: payload,
        }),
        clientAddress: '203.0.113.1',
      });
    };
    expect((await event('evt_r1', 'customer.subscription.created')).status).toBe(200);
    expect(
      await seeded.db.query('select received_at from stripe_events where id = $1', ['evt_r1']),
    ).toEqual([{ received_at: at }]);
    expect(await seeded.directory.statusOf(owner.pubkey)).toEqual({
      status: 'active',
      tier: 'starter',
    });
    stripe.subscriptions.set(snapshot.id, { ...snapshot, status: 'canceled' });
    await event('evt_r2', 'customer.subscription.deleted');
    expect(await seeded.directory.statusOf(owner.pubkey)).toEqual({
      status: 'active',
      tier: 'free',
    });
    expect(changed).toEqual(['changed', 'changed']);
    // The admin's Free choice: the same Free tier, and the store published at once.
    const choosing = newOwner();
    const view = await (await adminCall('POST', '/v1/admin/store', undefined, choosing)).json();
    const config = finalizeEvent(
      buildConfigEvent(
        {
          assistant: view.assistant,
          origins: [ORIGIN],
          name: 'Example Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: view.catalogKey,
          createdAt: at,
        },
        choosing.secret,
      ),
      choosing.secret,
    );
    const auth = finalizeEvent(
      buildCatalogAuth({ key: view.catalogKey, mode: 'hosted', createdAt: at }),
      choosing.secret,
    );
    await adminCall('POST', '/v1/admin/store/events', { events: [config, auth] }, choosing);
    expect(changed).toHaveLength(3);
    const free = await adminCall('POST', '/v1/admin/store/plan', { plan: 'free' }, choosing);
    expect(free.status).toBe(200);
    expect(await seeded.directory.statusOf(choosing.pubkey)).toEqual({
      status: 'active',
      tier: 'free',
    });
    expect(changed).toHaveLength(4);
    const plain = async (path: string) =>
      (
        await handler({
          request: new Request(`http://internal${path}`),
          clientAddress: '203.0.113.1',
        })
      ).text();
    expect(await plain(`/s/${owner.pubkey}/llms.txt`)).toBe('store docs');
    expect(await plain('/v1/session')).toBe('gateway');
    expect(await plain('/admin/')).toBe('admin pages');
    // The server's own llms.txt comes before the admin API and the webhook.
    expect(await plain('/llms.txt')).toBe(renderServerLlmsTxt(BASE));
  });
});

describe('the Stripe read, outside the transaction', () => {
  it('never holds the database while Stripe answers: a Free choice goes through meanwhile', async () => {
    const { open, subscribe, completed, stripe, directory } = await setup();
    const paying = newOwner();
    const choosing = newOwner();
    await open(paying);
    await open(choosing);
    stripe.control.delayMs = 400;
    let webhookDone = false;
    const webhook = completed(paying.pubkey, subscribe(paying.pubkey)).then((answer) => {
      webhookDone = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stripe.control.reading).toBe(1);
    expect(await directory.activateFree(choosing.pubkey, 'free', NOW, FREE_PLAN)).toBe('activated');
    expect(webhookDone).toBe(false);
    expect((await webhook).status).toBe(200);
  });

  it('answers 500 and records nothing when Stripe cannot be read, and applies the retry', async () => {
    const { open, subscribe, completed, stripe, statusOf, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    stripe.control.failSubscription = true;
    expect((await completed(owner.pubkey, snapshot)).body).toEqual({ error: 'not_applied' });
    expect(await db.query('select 1 from stripe_events')).toEqual([]);
    stripe.control.failSubscription = false;
    expect((await completed(owner.pubkey, snapshot)).status).toBe(200);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'starter' });
  });

  it('never lets an earlier read of a subscription replace a later one', async () => {
    const clockMs = { value: 2_000 };
    const { open, subscribe, completed, subscriptionEvent, statusOf, call, stripe } = await setup({
      nowMs: () => clockMs.value,
    });
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey, { plan: 'pro' });
    await completed(owner.pubkey, snapshot);
    // Another instance read the subscription earlier, when it still looked canceled.
    clockMs.value = 1_000;
    subscribe(owner.pubkey, { plan: 'pro', status: 'canceled' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing.status).toBe('active');
    // Gone from Stripe on an earlier read: not marked canceled either.
    stripe.subscriptions.delete(snapshot.id);
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    // A read at the same moment, or later, does replace it.
    clockMs.value = 2_000;
    subscribe(owner.pubkey, { plan: 'scale' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'scale' });
    clockMs.value = 3_000;
    subscribe(owner.pubkey, { plan: 'pro' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    // That later read is now the mark: one in between is older and does not count.
    clockMs.value = 2_500;
    subscribe(owner.pubkey, { plan: 'growth' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    clockMs.value = 4_000;
    stripe.subscriptions.delete(snapshot.id);
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
    // Marked gone at 4000: an older read of it live does not bring the plan back.
    clockMs.value = 3_500;
    subscribe(owner.pubkey, { plan: 'pro' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
  });

  it('stamps each saved read with the time it was made', async () => {
    const { open, subscribe, completed, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const before = Date.now();
    await completed(owner.pubkey, subscribe(owner.pubkey));
    const [row] = await db.query<{ snapshot_fetched_at: number }>(
      'select snapshot_fetched_at from billing_subscriptions',
    );
    expect(row?.snapshot_fetched_at).toBeGreaterThanOrEqual(before);
    expect(row?.snapshot_fetched_at).toBeLessThanOrEqual(Date.now());
  });

  it('does nothing for an invoice with no subscription, even one naming a known customer', async () => {
    const { open, subscribe, completed, deliver, logs } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    logs.length = 0;
    expect(
      await deliver({
        id: 'evt_one_off',
        type: 'invoice.paid',
        object: { id: 'in_one_off', customer: snapshot.customer },
      }),
    ).toEqual({ status: 200, body: { received: true } });
    expect(logs).toEqual([]);
  });

  it('applies an event once when two instances take it at the same time', async () => {
    const { open, subscribe, stripe, db, statusOf } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    const other = new BillingService({
      db,
      stripe: stripe.gateway,
      webhookSecret: WEBHOOK_SECRET,
      publicBase: BASE,
      tierExists: async () => true,
      storesChanged: () => undefined,
      now: () => NOW,
    });
    const first = new BillingService({
      db,
      stripe: stripe.gateway,
      webhookSecret: WEBHOOK_SECRET,
      publicBase: BASE,
      tierExists: async () => true,
      storesChanged: () => undefined,
      now: () => NOW,
    });
    const payload = JSON.stringify({
      id: 'evt_twice',
      type: 'customer.subscription.created',
      data: { object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } } },
    });
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: WEBHOOK_SECRET,
    });
    stripe.control.delayMs = 30;
    const answers = await Promise.all([
      first.webhook(payload, header).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
      other.webhook(payload, header).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers.filter((answer) => answer.body.duplicate === true)).toHaveLength(1);
    expect(stripe.control.retrieved).toBe(2);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'starter' });
  });
});

describe('two checkouts at once', () => {
  it('leave one session that can be paid: the later one expires the one it replaced', async () => {
    const { open, checkout, stripe, billing } = await setup();
    const owner = newOwner();
    await open(owner);
    const answers = await Promise.all([checkout(owner, 'pro'), checkout(owner, 'growth')]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(stripe.checkouts).toHaveLength(2);
    expect(stripe.expired).toHaveLength(1);
    const kept = await billing?.directory.lastCheckout(owner.pubkey);
    expect([...stripe.expired, kept].sort()).toEqual(['cs_test_1', 'cs_test_2']);
  });
});

describe('the webhook queue bound', () => {
  it('answers busy past its bound, so Stripe retries later, and takes events again once drained', async () => {
    const { open, subscribe, deliver, stripe } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    stripe.control.delayMs = 5;
    const answers = await Promise.all(
      Array.from({ length: MAX_QUEUED_WEBHOOKS + 1 }, (_unused, index) =>
        deliver({
          id: `evt_flood_${index}`,
          type: 'customer.subscription.updated',
          object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
        }),
      ),
    );
    expect(answers.filter((answer) => answer.status === 503)).toEqual([
      { status: 503, body: { error: 'busy' } },
    ]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(MAX_QUEUED_WEBHOOKS);
    const later = await deliver({
      id: 'evt_after_flood',
      type: 'customer.subscription.updated',
      object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
    });
    expect(later.status).toBe(200);
  });

  it('never gives an unsigned or forged request a slot, even with the queue full', async () => {
    const { open, subscribe, deliver, stripe, billing } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    stripe.control.delayMs = 40;
    const slow = Array.from({ length: MAX_QUEUED_WEBHOOKS }, (_unused, index) =>
      deliver({
        id: `evt_slow_${index}`,
        type: 'customer.subscription.updated',
        object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(billing?.queuedWebhooks).toBe(MAX_QUEUED_WEBHOOKS);
    const junk = await Promise.all(
      Array.from({ length: 60 }, (_unused, index) =>
        deliver(
          {
            id: `evt_junk_${index}`,
            type: 'customer.subscription.deleted',
            object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
          },
          index % 2 === 0 ? null : 't=1,v1=00',
        ),
      ),
    );
    expect(junk.every((answer) => answer.status === 400)).toBe(true);
    expect(junk.some((answer) => answer.status === 503)).toBe(false);
    expect(billing?.queuedWebhooks).toBe(MAX_QUEUED_WEBHOOKS);
    expect((await Promise.all(slow)).every((answer) => answer.status === 200)).toBe(true);
    expect(billing?.queuedWebhooks).toBe(0);
    const after = await deliver({
      id: 'evt_after_slow',
      type: 'customer.subscription.updated',
      object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
    });
    expect(after.status).toBe(200);
  });

  it('frees a slot when applying an event fails', async () => {
    const { open, subscribe, deliver, failing } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    const event = (index: number) =>
      deliver({
        id: `evt_failing_${index}`,
        type: 'customer.subscription.updated',
        object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
      });
    failing.eventSeen = true;
    for (let index = 0; index <= MAX_QUEUED_WEBHOOKS; index += 1) {
      await expect(event(index)).rejects.toThrow('the database dropped the query');
    }
    failing.eventSeen = false;
    expect((await event(MAX_QUEUED_WEBHOOKS + 1)).status).toBe(200);
  });

  it('bounds at 50', () => {
    expect(MAX_QUEUED_WEBHOOKS).toBe(50);
  });
});

describe('the operator activating a billed store', () => {
  it('needs a tier, takes the store over and warns the subscription still charges', async () => {
    const { open, subscribe, completed, subscriptionEvent, directory, statusOf, planSourceOf } =
      await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    // Suspended while its subscription ended: billing leaves a suspended store alone.
    expect(await runCli(['store', 'suspend', owner.pubkey], directory)).not.toContain('warning');
    subscribe(owner.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'suspended', tier: 'starter' });
    await expect(runCli(['store', 'activate', owner.pubkey], directory)).rejects.toThrow(
      'activate needs --tier',
    );
    const said = await runCli(['store', 'activate', owner.pubkey, '--tier', 'free'], directory);
    expect(said).toBe(
      `${nip19.npubEncode(owner.pubkey)} is active\nwarning: this store's plan was paid through Stripe; with --tier the operator manages it now, and billing no longer changes it (if its subscription is still live, Stripe keeps charging it until you cancel it there)`,
    );
    expect(await planSourceOf(owner.pubkey)).toBe('operator');
    const plain = newOwner();
    await open(plain);
    expect(
      await runCli(['store', 'activate', plain.pubkey, '--tier', 'pro'], directory),
    ).not.toContain('warning');
  });
});
