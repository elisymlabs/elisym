import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENTS, WEBHOOK_PATH, createStripeWebhook } from '../src/billing/service';
import { planOfPrice, snapshotOf } from '../src/billing/stripe';
import { billingFromEnv } from '../src/config';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { bodyLimitOf } from '../src/gateway/http';
import { BASE, FREE_PLAN, PERIOD_END, newOwner, setup, tier } from './billing-fixtures';
import { NOW } from './fixtures';
import { pgliteDb } from './pglite-db';

describe('billingFromEnv', () => {
  const files: Record<string, string> = {
    '/key': ' rk_test_1\n',
    '/hook': 'whsec_1\n',
    '/empty': '\n',
  };
  const read = (path: string) => files[path] ?? '';
  it('is off with neither file and on with both, trimmed', () => {
    expect(billingFromEnv({}, read)).toBeUndefined();
    expect(
      billingFromEnv(
        { ASKR_STRIPE_SECRET_KEY_FILE: '', ASKR_STRIPE_WEBHOOK_SECRET_FILE: '' },
        read,
      ),
    ).toBeUndefined();
    expect(
      billingFromEnv(
        { ASKR_STRIPE_SECRET_KEY_FILE: '/key', ASKR_STRIPE_WEBHOOK_SECRET_FILE: '/hook' },
        read,
      ),
    ).toEqual({ secretKey: 'rk_test_1', webhookSecret: 'whsec_1' });
  });
  it('refuses one file without the other, and an empty file, never naming a secret', () => {
    expect(() => billingFromEnv({ ASKR_STRIPE_SECRET_KEY_FILE: '/key' }, read)).toThrow(/both/u);
    expect(() => billingFromEnv({ ASKR_STRIPE_WEBHOOK_SECRET_FILE: '/hook' }, read)).toThrow(
      /both/u,
    );
    expect(() =>
      billingFromEnv(
        { ASKR_STRIPE_SECRET_KEY_FILE: '/empty', ASKR_STRIPE_WEBHOOK_SECRET_FILE: '/hook' },
        read,
      ),
    ).toThrow(/empty/u);
    expect(() =>
      billingFromEnv(
        { ASKR_STRIPE_SECRET_KEY_FILE: '/key', ASKR_STRIPE_WEBHOOK_SECRET_FILE: '/empty' },
        read,
      ),
    ).toThrow(/^((?!rk_test|whsec).)*$/u);
  });
});

describe('reading Stripe objects', () => {
  const price = (
    lookupKey: string | null,
    interval: string,
    metadata?: Record<string, string>,
  ) => ({
    id: 'price_1',
    lookup_key: lookupKey,
    recurring: { interval },
    product: metadata === undefined ? 'prod_1' : { id: 'prod_1', metadata },
  });
  it("takes the plan from the product's askr_tier, else the lookup key, and refuses a mismatch", () => {
    expect(planOfPrice(price('askr_pro_yearly', 'year', { askr_tier: 'pro' }))).toEqual({
      id: 'price_1',
      plan: 'pro',
      interval: 'year',
    });
    expect(planOfPrice(price('askr_growth_monthly', 'month'))).toMatchObject({ plan: 'growth' });
    expect(planOfPrice(price(null, 'month', { askr_tier: 'scale' }))).toMatchObject({
      plan: 'scale',
    });
    expect(planOfPrice(price('askr_pro_monthly', 'month', { askr_tier: 'scale' }))).toBeUndefined();
    expect(planOfPrice(price('askr_pro_monthly', 'year'))).toBeUndefined();
    expect(planOfPrice(price(null, 'month', { askr_tier: 'enterprise' }))).toBeUndefined();
    expect(planOfPrice(price('other_price', 'month'))).toBeUndefined();
    expect(planOfPrice(price('askr_pro_monthly', 'week'))).toBeUndefined();
  });
  it('reads a subscription: one item, the earliest period end, the store metadata', () => {
    const item = (end: number) => ({
      id: 'si_1',
      current_period_end: end,
      price: price('askr_starter_monthly', 'month', { askr_tier: 'starter' }),
    });
    const subscription = {
      id: 'sub_1',
      customer: { id: 'cus_1' },
      status: 'past_due',
      metadata: { askr_store: 'ab'.repeat(32) },
      cancel_at_period_end: true,
      created: NOW - 100,
      items: { data: [item(PERIOD_END)] },
    };
    expect(snapshotOf(subscription)).toEqual({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'past_due',
      store: 'ab'.repeat(32),
      plan: 'starter',
      interval: 'month',
      itemId: 'si_1',
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: true,
      created: NOW - 100,
      scheduledChange: null,
    });
    const two = snapshotOf({
      ...subscription,
      items: { data: [item(PERIOD_END), item(PERIOD_END - 10)] },
    });
    expect(two.plan).toBeUndefined();
    expect(two.itemId).toBeUndefined();
    expect(two.currentPeriodEnd).toBe(PERIOD_END - 10);
  });
});

describe('POST /v1/admin/billing/checkout', () => {
  it('opens a Managed Payments subscription session for the price of the lookup key', async () => {
    const { open, checkout, stripe } = await setup();
    const owner = newOwner();
    await open(owner);
    const answer = await checkout(owner, 'growth', 'year');
    expect(answer).toEqual({ status: 200, body: { url: 'https://checkout.stripe.test/c/1' } });
    expect(stripe.checkouts).toEqual([
      {
        mode: 'subscription',
        managed_payments: { enabled: true },
        line_items: [{ price: 'price_growth_year', quantity: 1 }],
        client_reference_id: owner.pubkey,
        metadata: { askr_store: owner.pubkey },
        subscription_data: { metadata: { askr_store: owner.pubkey } },
        success_url: `${BASE}/admin/?billing=success`,
        cancel_url: `${BASE}/admin/?billing=canceled`,
      },
    ]);
    // Nothing the client sent but the plan and interval reaches Stripe, and no tax parameter
    // Managed Payments refuses.
    expect(stripe.checkouts[0]).not.toHaveProperty('automatic_tax');
    expect(stripe.checkouts[0]).not.toHaveProperty('customer');
  });

  it('reuses the store customer, and starts over without it once Stripe no longer has it', async () => {
    const { open, checkout, stripe, subscribe, completed, subscriptionEvent, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const first = subscribe(owner.pubkey);
    await completed(owner.pubkey, first);
    stripe.subscriptions.set(first.id, { ...first, status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', first);
    expect((await checkout(owner, 'pro')).status).toBe(200);
    expect(stripe.checkouts.at(-1)?.customer).toBe(first.customer);
    stripe.missingCustomers.add(first.customer);
    expect((await checkout(owner, 'pro')).status).toBe(200);
    expect(stripe.checkouts.at(-1)).not.toHaveProperty('customer');
    expect(
      await db.query('select 1 from billing_customers where owner = $1', [owner.pubkey]),
    ).toEqual([]);
  });

  it('refuses a bad body, a live subscription, a suspended or operator-managed store', async () => {
    const { open, checkout, call, directory, subscribe, completed, stripe, invoiceEvent, db } =
      await setup();
    const owner = newOwner();
    await open(owner);
    expect((await checkout(owner, 'enterprise')).body).toEqual({ error: 'bad_request' });
    expect((await checkout(owner, 'free')).status).toBe(400);
    expect((await checkout(owner, 'pro', 'week')).status).toBe(400);
    expect((await call(owner, 'POST', '/v1/admin/billing/checkout', { plan: 'pro' })).status).toBe(
      400,
    );

    await completed(owner.pubkey, subscribe(owner.pubkey));
    expect(await checkout(owner, 'pro')).toEqual({
      status: 409,
      body: { error: 'subscription_exists' },
    });
    // Past due still counts: the plan is in its grace, and the portal fixes the payment.
    const pastDue = subscribe(owner.pubkey, { status: 'past_due' });
    await invoiceEvent('invoice.payment_failed', pastDue);
    expect(
      await db.query('select status from billing_subscriptions where owner = $1', [owner.pubkey]),
    ).toEqual([{ status: 'past_due' }]);
    expect((await checkout(owner, 'pro')).body).toEqual({ error: 'subscription_exists' });

    const managed = newOwner();
    await open(managed);
    expect(await directory.setStatus(managed.pubkey, 'active', 'enterprise')).toBe(true);
    expect(await checkout(managed, 'pro')).toEqual({
      status: 409,
      body: { error: 'operator_managed' },
    });
    const suspended = newOwner();
    await open(suspended);
    await directory.setStatus(suspended.pubkey, 'suspended', 'starter');
    expect((await checkout(suspended, 'pro')).body).toEqual({ error: 'suspended' });
    expect(stripe.checkouts).toEqual([]);
  });

  it('lets a store on Free upgrade', async () => {
    const { open, checkout, directory, db } = await setup();
    const owner = newOwner();
    await open(owner);
    expect(await directory.activateFree(owner.pubkey, 'free', NOW, FREE_PLAN)).toBe('activated');
    expect(
      await db.query('select plan_source from stores where owner = $1', [owner.pubkey]),
    ).toEqual([{ plan_source: 'free' }]);
    expect((await checkout(owner, 'starter')).status).toBe(200);
  });

  it('answers plan_unavailable without the tier or the price, billing_failed when Stripe fails', async () => {
    const { open, checkout, directory, stripe, logs } = await setup();
    const owner = newOwner();
    await open(owner);
    expect((await directory.deleteTier('scale'))?.deleted).toBe(true);
    expect(await checkout(owner, 'scale')).toEqual({
      status: 503,
      body: { error: 'plan_unavailable' },
    });
    expect(logs.some((line) => line.includes('the tier scale does not exist'))).toBe(true);
    stripe.control.failPrices = true;
    expect(await checkout(owner, 'pro')).toEqual({
      status: 502,
      body: { error: 'billing_failed' },
    });
    stripe.control.failPrices = false;
    stripe.control.failCheckout = true;
    expect(await checkout(owner, 'pro')).toEqual({
      status: 502,
      body: { error: 'billing_failed' },
    });
  });

  it('answers billing_unavailable on both routes while billing is off, and the view says so', async () => {
    const { open, checkout, call } = await setup({ billing: false });
    const owner = newOwner();
    const opened = await open(owner);
    expect(opened.body.billing).toEqual({
      enabled: false,
      plan: null,
      interval: null,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      manageable: false,
      checkoutAvailable: false,
      operatorManaged: false,
      scheduledChange: null,
    });
    expect(await checkout(owner, 'pro')).toEqual({
      status: 503,
      body: { error: 'billing_unavailable' },
    });
    expect((await call(owner, 'POST', '/v1/admin/billing/portal')).body).toEqual({
      error: 'billing_unavailable',
    });
  });

  it('answers moved for a key the store moved away from', async () => {
    const { open, checkout, directory } = await setup();
    const from = newOwner();
    const to = newOwner();
    await open(from);
    expect(await directory.moveStore(from.pubkey, to.pubkey, NOW, undefined)).toEqual({ ok: true });
    expect(await checkout(from, 'pro')).toEqual({ status: 409, body: { error: 'moved' } });
  });
});

describe('POST /v1/admin/billing/portal', () => {
  it('needs a customer, then opens the portal back to the admin', async () => {
    const { open, call, stripe, subscribe, completed } = await setup();
    const owner = newOwner();
    await open(owner);
    expect(await call(owner, 'POST', '/v1/admin/billing/portal')).toEqual({
      status: 404,
      body: { error: 'no_customer' },
    });
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    expect(await call(owner, 'POST', '/v1/admin/billing/portal')).toEqual({
      status: 200,
      body: { url: 'https://billing.stripe.test/p/1' },
    });
    expect(stripe.portals).toEqual([{ customer: snapshot.customer, return_url: `${BASE}/admin/` }]);
  });
});

describe('POST /v1/stripe/webhook', () => {
  it('lists the ten events Stripe must send', () => {
    expect(WEBHOOK_EVENTS).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
      'subscription_schedule.created',
      'subscription_schedule.updated',
      'subscription_schedule.released',
      'subscription_schedule.canceled',
    ]);
  });

  it('refuses an unsigned event and a bad signature, applying nothing', async () => {
    const { deliver, stripe, open, statusOf, subscribe } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    const event = {
      id: 'evt_forged',
      type: 'customer.subscription.created',
      object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
    };
    expect(await deliver(event, null)).toEqual({ status: 400, body: { error: 'unsigned' } });
    expect(await deliver(event, 't=1,v1=00')).toEqual({
      status: 400,
      body: { error: 'bad_signature' },
    });
    const wrongSecret = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: '{}',
      secret: 'whsec_other',
    });
    expect((await deliver(event, wrongSecret)).status).toBe(400);
    expect(stripe.control.retrieved).toBe(0);
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
  });

  it('answers 503 while billing is off and 404 to another method; other paths are not its', async () => {
    const off = createStripeWebhook(undefined);
    expect(
      (await off(new Request(`http://internal${WEBHOOK_PATH}`, { method: 'POST', body: '{}' })))
        ?.status,
    ).toBe(503);
    expect((await off(new Request(`http://internal${WEBHOOK_PATH}`)))?.status).toBe(404);
    expect(
      await off(new Request('http://internal/v1/session', { method: 'POST' })),
    ).toBeUndefined();
  });

  it('gives the webhook a 1 MiB body without a NIP-98 header', () => {
    expect(bodyLimitOf('POST', WEBHOOK_PATH, undefined)).toBe(1024 * 1024);
  });

  it('acknowledges an event it does not handle without reading Stripe', async () => {
    const { deliver, stripe } = await setup();
    expect(
      await deliver({ id: 'evt_x', type: 'customer.created', object: { id: 'cus_1' } }),
    ).toEqual({ status: 200, body: { received: true, ignored: true } });
    expect(stripe.control.retrieved).toBe(0);
  });

  it('activates a pending store on the paid tier from the subscription, never from the event', async () => {
    const { open, completed, subscribe, statusOf, planSourceOf, changed, notified, call } =
      await setup();
    const owner = newOwner();
    await open(owner);
    // The event names no plan at all: the plan is the one of the price Stripe holds.
    const snapshot = subscribe(owner.pubkey, { plan: 'pro', interval: 'year' });
    expect(await completed(owner.pubkey, snapshot)).toEqual({
      status: 200,
      body: { received: true },
    });
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    expect(await planSourceOf(owner.pubkey)).toBe('billing');
    expect(changed).toEqual(['changed']);
    await expect.poll(() => notified.length).toBeGreaterThan(0);
    const view = (await call(owner, 'GET', '/v1/admin/store')).body;
    expect(view.billing).toEqual({
      enabled: true,
      plan: 'pro',
      interval: 'year',
      status: 'active',
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      manageable: true,
      checkoutAvailable: false,
      operatorManaged: false,
      scheduledChange: null,
    });
  });

  it('applies an event once: a redelivery answers duplicate and reads nothing', async () => {
    const { open, deliver, subscribe, stripe, statusOf, db } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    const event = {
      id: 'evt_once',
      type: 'customer.subscription.created',
      object: { id: snapshot.id, metadata: { askr_store: owner.pubkey } },
    };
    expect((await deliver(event)).body).toEqual({ received: true });
    expect(stripe.control.retrieved).toBe(1);
    expect((await deliver(event)).body).toEqual({ received: true, duplicate: true });
    expect(stripe.control.retrieved).toBe(1);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'starter' });
    expect(await db.query('select id, type from stripe_events')).toEqual([
      { id: 'evt_once', type: 'customer.subscription.created' },
    ]);
  });

  it('follows a plan change, keeps a past due store active, records a cancel at period end', async () => {
    const { open, completed, subscribe, subscriptionEvent, invoiceEvent, statusOf, call } =
      await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    subscribe(owner.pubkey, { plan: 'scale', interval: 'year' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'scale' });

    subscribe(owner.pubkey, { plan: 'scale', status: 'past_due' });
    expect((await invoiceEvent('invoice.payment_failed', snapshot)).status).toBe(200);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'scale' });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      status: 'past_due',
      checkoutAvailable: false,
    });

    subscribe(owner.pubkey, { plan: 'scale', cancelAtPeriodEnd: true });
    await invoiceEvent('invoice.paid', snapshot);
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'scale' });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: PERIOD_END,
    });
  });

  it('puts a store whose subscription ended on Free, its data kept', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf, planSourceOf, call, changed } =
      await setup();
    const owner = newOwner();
    await open(owner);
    await call(owner, 'PUT', '/v1/admin/store/contact', { email: 'shop@example.com' });
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    subscribe(owner.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
    expect(await planSourceOf(owner.pubkey)).toBe('free');
    expect(changed).toEqual(['changed', 'changed']);
    const view = (await call(owner, 'GET', '/v1/admin/store')).body;
    expect(view.email).toBe('shop@example.com');
    expect(view.billing).toMatchObject({
      status: 'canceled',
      plan: 'starter',
      manageable: true,
      checkoutAvailable: true,
    });
  });

  it('puts it back to pending with no tier when Free is full, off, or missing', async () => {
    const variants = [
      ['full', { ...FREE_PLAN, maxActive: 1 }],
      ['off', null],
      ['missing', FREE_PLAN],
    ] as const;
    for (const [variant, freeTier] of variants) {
      const context = await setup({ freeTier });
      const { open, directory, completed, subscribe, subscriptionEvent, statusOf } = context;
      if (variant === 'full') {
        const other = newOwner();
        await open(other);
        expect(await directory.activateFree(other.pubkey, 'free', NOW, FREE_PLAN)).toBe(
          'activated',
        );
      }
      if (variant === 'missing') {
        expect((await directory.deleteTier('free'))?.deleted).toBe(true);
      }
      const owner = newOwner();
      await open(owner);
      const snapshot = subscribe(owner.pubkey);
      await completed(owner.pubkey, snapshot);
      subscribe(owner.pubkey, { status: 'canceled' });
      await subscriptionEvent('customer.subscription.deleted', snapshot);
      expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    }
  });

  it('treats a subscription Stripe no longer has as ended', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf, stripe } = await setup();
    const owner = newOwner();
    await open(owner);
    const snapshot = subscribe(owner.pubkey);
    await completed(owner.pubkey, snapshot);
    stripe.subscriptions.delete(snapshot.id);
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'free' });
  });

  it('applies the earliest of two live subscriptions, whatever the event order, logs the duplicate, and falls to the other when it ends', async () => {
    const {
      open,
      completed,
      subscribe,
      subscriptionEvent,
      invoiceEvent,
      statusOf,
      clock,
      logs,
      call,
    } = await setup();
    const owner = newOwner();
    await open(owner);
    // The later one's event comes first.
    const second = subscribe(owner.pubkey, { id: 'sub_b', plan: 'pro', created: NOW + 30 });
    const first = subscribe(owner.pubkey, { id: 'sub_a', plan: 'growth', created: NOW });
    await completed(owner.pubkey, second);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    clock.now += 60;
    await completed(owner.pubkey, first);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'growth' });
    expect(logs).toContain(
      `duplicate live subscription for store ${owner.pubkey}: sub_a, sub_b; the earliest is applied, cancel and refund the others`,
    );
    // An event on the later one (its updated time moves on) does not flip the plan, and the view
    // shows the same one.
    clock.now += 60;
    await invoiceEvent('invoice.paid', second);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'growth' });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing.plan).toBe('growth');
    subscribe(owner.pubkey, { id: 'sub_a', plan: 'growth', status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', first);
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
  });

  it('breaks a tie on the creation time by subscription id, the same in the view and the tier', async () => {
    const { open, completed, subscribe, statusOf, call } = await setup();
    const owner = newOwner();
    await open(owner);
    await completed(owner.pubkey, subscribe(owner.pubkey, { id: 'sub_y', plan: 'scale' }));
    await completed(owner.pubkey, subscribe(owner.pubkey, { id: 'sub_x', plan: 'pro' }));
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'pro' });
    expect((await call(owner, 'GET', '/v1/admin/store')).body.billing.plan).toBe('pro');
  });

  it('never changes an operator-managed or suspended store, but records its subscription', async () => {
    const { open, directory, completed, subscribe, subscriptionEvent, statusOf, db } =
      await setup();
    const managed = newOwner();
    await open(managed);
    await directory.setStatus(managed.pubkey, 'active', 'enterprise');
    const snapshot = subscribe(managed.pubkey, { plan: 'starter' });
    await completed(managed.pubkey, snapshot);
    expect(await statusOf(managed)).toEqual({ status: 'active', tier: 'enterprise' });
    subscribe(managed.pubkey, { status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    expect(await statusOf(managed)).toEqual({ status: 'active', tier: 'enterprise' });
    expect(
      await db.query('select status from billing_subscriptions where owner = $1', [managed.pubkey]),
    ).toEqual([{ status: 'canceled' }]);

    const paid = newOwner();
    await open(paid);
    const paidSnapshot = subscribe(paid.pubkey);
    await completed(paid.pubkey, paidSnapshot);
    // The operator suspends a paying store: Stripe's later events leave it suspended.
    await directory.setStatus(paid.pubkey, 'suspended');
    subscribe(paid.pubkey, { plan: 'scale' });
    await subscriptionEvent('customer.subscription.updated', paidSnapshot);
    expect(await statusOf(paid)).toEqual({ status: 'suspended', tier: 'starter' });
    // The operator moving it to a tier takes it over from billing.
    await directory.setStatus(paid.pubkey, 'active', 'growth');
    await subscriptionEvent('customer.subscription.updated', paidSnapshot);
    expect(await statusOf(paid)).toEqual({ status: 'active', tier: 'growth' });
  });

  it('answers 500 while the paid tier is missing, and applies the event once it exists', async () => {
    const { open, subscribe, statusOf, directory, logs, deliver } = await setup();
    const owner = newOwner();
    await open(owner);
    expect((await directory.deleteTier('growth'))?.deleted).toBe(true);
    const snapshot = subscribe(owner.pubkey, { plan: 'growth' });
    const event = {
      id: 'evt_retry',
      type: 'checkout.session.completed',
      object: {
        mode: 'subscription',
        client_reference_id: owner.pubkey,
        customer: snapshot.customer,
        subscription: snapshot.id,
      },
    };
    expect(await deliver(event)).toEqual({ status: 500, body: { error: 'not_applied' } });
    expect(logs.some((line) => line.includes('the tier growth does not exist'))).toBe(true);
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    await directory.setTier(tier('growth'));
    expect((await deliver(event)).body).toEqual({ received: true });
    expect(await statusOf(owner)).toEqual({ status: 'active', tier: 'growth' });
  });

  it('ignores a subscription that names no Askr store or is not on an Askr price', async () => {
    const { subscribe, subscriptionEvent, open, statusOf, db } = await setup();
    const stranger = subscribe('ff'.repeat(32), { id: 'sub_other', store: undefined });
    expect((await subscriptionEvent('customer.subscription.created', stranger)).status).toBe(200);
    const owner = newOwner();
    await open(owner);
    const foreign = subscribe(owner.pubkey, { id: 'sub_foreign', plan: undefined });
    expect((await subscriptionEvent('customer.subscription.created', foreign)).status).toBe(200);
    expect(await statusOf(owner)).toEqual({ status: 'pending', tier: null });
    expect(await db.query('select 1 from billing_subscriptions')).toEqual([]);
  });

  it('follows the store when its owner key moved (K21)', async () => {
    const { open, completed, subscribe, subscriptionEvent, statusOf, directory, call, clock } =
      await setup();
    const from = newOwner();
    const to = newOwner();
    await open(from);
    const snapshot = subscribe(from.pubkey);
    await completed(from.pubkey, snapshot);
    expect(await directory.moveStore(from.pubkey, to.pubkey, NOW, undefined)).toEqual({ ok: true });
    // Stripe still names the old key: the stored row moved with the store.
    subscribe(from.pubkey, { plan: 'pro' });
    await subscriptionEvent('customer.subscription.updated', snapshot);
    expect(await statusOf(to)).toEqual({ status: 'active', tier: 'pro' });
    expect((await call(to, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      plan: 'pro',
      manageable: true,
    });

    // A checkout under the old key, with a new customer, that completes after the move lands on
    // the store too (its metadata names the old key, followed through the move).
    subscribe(from.pubkey, { plan: 'pro', status: 'canceled' });
    await subscriptionEvent('customer.subscription.deleted', snapshot);
    clock.now += 60;
    const late = subscribe(from.pubkey, { id: 'sub_late', plan: 'scale', customer: 'cus_late' });
    await completed(from.pubkey, late);
    expect(await statusOf(to)).toEqual({ status: 'active', tier: 'scale' });
  });
});

describe('migration 0010_billing', () => {
  it('marks self-serve Free stores free and tiered ones operator', async () => {
    const client = await PGlite.create();
    const db = pgliteDb(client);
    const before = MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((entry) => entry.id === '0010_billing'),
    );
    expect(before.map((entry) => entry.id).at(-1)).toBe('0009_catalog_sync_times');
    await db.script(
      'create table migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    for (const migration of before) {
      await db.script(migration.sql);
      await db.query('insert into migrations (id) values ($1)', [migration.id]);
    }
    await db.query(
      `insert into tiers (name, messages_per_session_per_day, monthly_budget_usd,
         tickets_per_store_per_minute, max_products, sync_interval_minutes, branding)
       values ('free', 20, 1, 30, 100, 1440, true), ('pro', 20, 5, 30, 100, 60, false)`,
    );
    const insert = (owner: string, status: string, tierName: string | null, auto: number | null) =>
      db.query(
        `insert into stores (owner, status, tier, assistant, assistant_key, catalog_key,
           catalog_key_secret, created_at, auto_activated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          owner,
          status,
          tierName,
          `b${owner.slice(1)}`,
          new Uint8Array(1),
          `c${owner.slice(1)}`,
          new Uint8Array(1),
          NOW,
          auto,
        ],
      );
    await insert('1'.repeat(64), 'active', 'free', NOW);
    await insert('2'.repeat(64), 'active', 'pro', null);
    await insert('3'.repeat(64), 'pending', null, null);
    // Activated on Free once, then set back to pending with no tier: no plan, so no source.
    await insert('5'.repeat(64), 'pending', null, NOW);
    await migrate(db);
    const rows = await db.query<{ owner: string; plan_source: string | null }>(
      'select owner, plan_source from stores order by owner',
    );
    expect(rows.map((row) => row.plan_source)).toEqual(['free', 'operator', null, null]);
    await expect(
      db.query(`update stores set plan_source = 'x' where owner = $1`, ['3'.repeat(64)]),
    ).rejects.toThrow();
    for (const table of ['billing_customers', 'billing_subscriptions', 'stripe_events']) {
      expect(await db.query(`select count(*)::int as n from ${table}`)).toEqual([{ n: 0 }]);
    }
    // A store moving to a new key carries its billing rows (on update cascade).
    await db.query(
      `insert into billing_customers (owner, customer_id, created_at) values ($1, 'cus_1', $2)`,
      ['2'.repeat(64), NOW],
    );
    // Every subscription row carries when Stripe created it: the order duplicates are settled by.
    await expect(
      db.query(
        `insert into billing_subscriptions (subscription_id, owner, customer_id, status,
           cancel_at_period_end, stripe_created, updated_at, snapshot_fetched_at)
         values ('sub_null', $1, 'cus_n', 'active', false, null, $2, 0)`,
        ['1'.repeat(64), NOW],
      ),
    ).rejects.toThrow();
    // One Stripe customer is one store's.
    await expect(
      db.query(
        `insert into billing_customers (owner, customer_id, created_at) values ($1, 'cus_1', $2)`,
        ['1'.repeat(64), NOW],
      ),
    ).rejects.toThrow();
    await db.query('update stores set owner = $2 where owner = $1', [
      '2'.repeat(64),
      '4'.repeat(64),
    ]);
    expect(await db.query('select owner from billing_customers')).toEqual([
      { owner: '4'.repeat(64) },
    ]);
    await client.close();
  });
});
