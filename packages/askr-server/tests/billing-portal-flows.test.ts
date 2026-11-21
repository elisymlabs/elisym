import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { createAdminPages } from '../src/admin/pages';
import {
  type PriceLike,
  type ScheduleLike,
  createStripeGateway,
  scheduledChangeOf,
  snapshotOf,
} from '../src/billing/stripe';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { BASE, PERIOD_END, type Owner, newOwner, setup } from './billing-fixtures';
import { NOW } from './fixtures';
import { pgliteDb } from './pglite-db';

const PORTAL = '/v1/admin/billing/portal';
const ADMIN = `${BASE}/admin/`;
const UPDATED = { type: 'redirect', redirect: { return_url: `${ADMIN}?billing=updated` } };

type Harness = Awaited<ReturnType<typeof setup>>;

/** A store paying through a live subscription, recorded by its checkout's webhook. */
async function paying(
  harness: Harness,
  overrides: Parameters<Harness['subscribe']>[1] = {},
): Promise<{ owner: Owner; subscription: string; customer: string; item: string }> {
  const owner = newOwner();
  await harness.open(owner);
  const snapshot = harness.subscribe(owner.pubkey, overrides);
  await harness.completed(owner.pubkey, snapshot);
  return {
    owner,
    subscription: snapshot.id,
    customer: snapshot.customer,
    item: snapshot.itemId ?? '',
  };
}

const price = (lookupKey: string | null, interval = 'month'): PriceLike => ({
  id: `price_${lookupKey ?? 'none'}`,
  lookup_key: lookupKey,
  recurring: { interval },
  // Four expand levels is Stripe's most: a phase price's product stays an id.
  product: 'prod_1',
});

const phase = (
  startDate: number,
  ...prices: ScheduleLike['phases'][number]['items'][number]['price'][]
) => ({
  start_date: startDate,
  items: prices.map((entry) => ({ price: entry })),
});

describe('the portal: no body or {}', () => {
  it("opens the portal's home with exactly today's payload", async () => {
    const harness = await setup();
    const { owner, customer } = await paying(harness);
    expect(await harness.call(owner, 'POST', PORTAL)).toEqual({
      status: 200,
      body: { url: 'https://billing.stripe.test/p/1' },
    });
    expect((await harness.call(owner, 'POST', PORTAL, {})).status).toBe(200);
    expect(harness.stripe.portals).toEqual([
      { customer, return_url: ADMIN },
      { customer, return_url: ADMIN },
    ]);
    expect(harness.stripe.control.retrieved).toBe(1);
  });

  it('opens the home even for a store whose subscription ended (no subscription checks)', async () => {
    const harness = await setup();
    const { owner } = await paying(harness, { status: 'canceled' });
    expect((await harness.call(owner, 'POST', PORTAL, {})).status).toBe(200);
  });

  it('answers suspended and operator_managed for a paying store, before any Stripe call', async () => {
    const harness = await setup();
    const suspended = await paying(harness);
    await harness.directory.setStatus(suspended.owner.pubkey, 'suspended');
    const managed = await paying(harness);
    await harness.directory.setStatus(managed.owner.pubkey, 'active', 'enterprise');
    for (const body of [undefined, {}]) {
      expect(await harness.call(suspended.owner, 'POST', PORTAL, body)).toEqual({
        status: 409,
        body: { error: 'suspended' },
      });
      expect(await harness.call(managed.owner, 'POST', PORTAL, body)).toEqual({
        status: 409,
        body: { error: 'operator_managed' },
      });
    }
    expect(harness.stripe.portals).toEqual([]);
  });

  it('answers bad_request for any other body, opening nothing', async () => {
    const harness = await setup();
    const { owner } = await paying(harness);
    const bodies: unknown[] = [
      { action: 'switch' },
      { action: 'switch', plan: 'growth' },
      { action: 'switch', plan: 'growth', interval: 'week' },
      { action: 'switch', plan: 'enterprise', interval: 'month' },
      { action: 'switch', plan: 'free', interval: 'month' },
      { action: 'switch', plan: 'growth', interval: 'month', extra: 1 },
      { action: 'cancel', plan: 'growth' },
      { action: 'upgrade' },
      { plan: 'growth', interval: 'month' },
      { extra: true },
      [],
      'cancel',
      null,
    ];
    for (const body of bodies) {
      expect(await harness.call(owner, 'POST', PORTAL, body)).toEqual({
        status: 400,
        body: { error: 'bad_request' },
      });
    }
    expect((await harness.billing?.portal(owner.pubkey, '{'))?.status).toBe(400);
    expect(harness.stripe.portals).toEqual([]);
  });
});

describe('the portal: switch and cancel flows, exact payloads', () => {
  const cases = [
    {
      name: 'a higher tier, same interval: confirmed',
      from: { plan: 'starter', interval: 'month' },
      to: { plan: 'growth', interval: 'month' },
      type: 'subscription_update_confirm',
    },
    {
      name: 'the same tier, month to year: confirmed',
      from: { plan: 'growth', interval: 'month' },
      to: { plan: 'growth', interval: 'year' },
      type: 'subscription_update_confirm',
    },
    {
      name: 'a higher tier and month to year: confirmed',
      from: { plan: 'starter', interval: 'month' },
      to: { plan: 'scale', interval: 'year' },
      type: 'subscription_update_confirm',
    },
    {
      name: 'a lower tier: the update picker',
      from: { plan: 'pro', interval: 'month' },
      to: { plan: 'starter', interval: 'month' },
      type: 'subscription_update',
    },
    {
      name: 'a lower tier but month to year: the update picker',
      from: { plan: 'pro', interval: 'month' },
      to: { plan: 'growth', interval: 'year' },
      type: 'subscription_update',
    },
    {
      name: 'the same tier, year to month: the update picker',
      from: { plan: 'growth', interval: 'year' },
      to: { plan: 'growth', interval: 'month' },
      type: 'subscription_update',
    },
    {
      name: 'a higher tier but year to month: the update picker',
      from: { plan: 'growth', interval: 'year' },
      to: { plan: 'scale', interval: 'month' },
      type: 'subscription_update',
    },
  ] as const;

  for (const entry of cases) {
    it(entry.name, async () => {
      const harness = await setup();
      const { owner, customer, subscription, item } = await paying(harness, entry.from);
      expect(await harness.call(owner, 'POST', PORTAL, { action: 'switch', ...entry.to })).toEqual({
        status: 200,
        body: { url: 'https://billing.stripe.test/p/1' },
      });
      const flow =
        entry.type === 'subscription_update_confirm'
          ? {
              type: entry.type,
              subscription_update_confirm: {
                subscription,
                items: [
                  { id: item, price: `price_${entry.to.plan}_${entry.to.interval}`, quantity: 1 },
                ],
              },
              after_completion: UPDATED,
            }
          : {
              type: entry.type,
              subscription_update: { subscription },
              after_completion: UPDATED,
            };
      expect(harness.stripe.portals).toEqual([{ customer, return_url: ADMIN, flow_data: flow }]);
    });
  }

  it('cancels through the cancel flow, back to the admin with billing=updated', async () => {
    const harness = await setup();
    const { owner, customer, subscription } = await paying(harness, { plan: 'growth' });
    expect((await harness.call(owner, 'POST', PORTAL, { action: 'cancel' })).status).toBe(200);
    expect(harness.stripe.portals).toEqual([
      {
        customer,
        return_url: ADMIN,
        flow_data: {
          type: 'subscription_cancel',
          subscription_cancel: { subscription },
          after_completion: UPDATED,
        },
      },
    ]);
  });

  it('forgets a customer Stripe deleted, and answers billing_failed when the portal fails', async () => {
    const harness = await setup();
    const { owner, customer } = await paying(harness);
    harness.stripe.control.failPortal = true;
    expect(await harness.call(owner, 'POST', PORTAL, { action: 'cancel' })).toEqual({
      status: 502,
      body: { error: 'billing_failed' },
    });
    harness.stripe.missingCustomers.add(customer);
    expect(await harness.call(owner, 'POST', PORTAL, { action: 'cancel' })).toEqual({
      status: 404,
      body: { error: 'no_customer' },
    });
    expect(await harness.billing?.directory.customerOf(owner.pubkey)).toBeUndefined();
  });
});

describe('the portal: every refusal of a switch or a cancel', () => {
  const SWITCH = { action: 'switch', plan: 'growth', interval: 'month' };
  const CANCEL = { action: 'cancel' };

  const refused = async (
    harness: Harness,
    owner: Owner,
    body: unknown,
    status: number,
    error: string,
  ) => {
    expect(await harness.call(owner, 'POST', PORTAL, body)).toEqual({ status, body: { error } });
    expect(harness.stripe.portals).toEqual([]);
  };

  it('answers no_store for a key with no store', async () => {
    const harness = await setup();
    const response = await harness.billing?.portal(newOwner().pubkey, JSON.stringify(CANCEL));
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: 'no_store' });
  });

  it('answers suspended and operator_managed before asking for a customer', async () => {
    const harness = await setup();
    const suspended = newOwner();
    await harness.open(suspended);
    await harness.directory.setStatus(suspended.pubkey, 'suspended', 'starter');
    await refused(harness, suspended, SWITCH, 409, 'suspended');
    await refused(harness, suspended, CANCEL, 409, 'suspended');
    const operator = newOwner();
    await harness.open(operator);
    await harness.directory.setStatus(operator.pubkey, 'active', 'enterprise');
    await refused(harness, operator, SWITCH, 409, 'operator_managed');
    await refused(harness, operator, CANCEL, 409, 'operator_managed');
    // A paying store the operator suspended keeps its customer and is still refused.
    const billed = await paying(harness);
    await harness.directory.setStatus(billed.owner.pubkey, 'suspended');
    await refused(harness, billed.owner, CANCEL, 409, 'suspended');
  });

  it('answers no_customer for a store that never paid', async () => {
    const harness = await setup();
    const owner = newOwner();
    await harness.open(owner);
    await refused(harness, owner, SWITCH, 404, 'no_customer');
    await refused(harness, owner, CANCEL, 404, 'no_customer');
  });

  it('caps switches and cancels at 30 per hour, before reading the subscriptions', async () => {
    const harness = await setup();
    const { owner } = await paying(harness, { status: 'canceled' });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await harness.call(owner, 'POST', PORTAL, CANCEL)).body).toEqual({
        error: 'no_subscription',
      });
    }
    await refused(harness, owner, SWITCH, 429, 'rate_limited');
  });

  it('answers no_subscription with no live subscription in the database', async () => {
    const harness = await setup();
    const { owner } = await paying(harness, { status: 'canceled' });
    await refused(harness, owner, SWITCH, 409, 'no_subscription');
    await refused(harness, owner, CANCEL, 409, 'no_subscription');
  });

  it('answers past_due, cancel_pending and change_scheduled from the database, before Stripe', async () => {
    const harness = await setup();
    const pastDue = await paying(harness, { status: 'past_due' });
    const canceling = await paying(harness, { cancelAtPeriodEnd: true });
    const scheduled = await paying(harness, {
      plan: 'pro',
      scheduledChange: { plan: 'starter', interval: 'month', at: PERIOD_END },
    });
    const reads = harness.stripe.control.retrieved;
    for (const body of [SWITCH, CANCEL]) {
      await refused(harness, pastDue.owner, body, 409, 'past_due');
      await refused(harness, canceling.owner, body, 409, 'cancel_pending');
      await refused(harness, scheduled.owner, body, 409, 'change_scheduled');
    }
    expect(harness.stripe.control.retrieved).toBe(reads);
  });

  it('answers change_scheduled for a schedule whose next phase is not ours', async () => {
    const harness = await setup();
    const { owner } = await paying(harness, {
      scheduledChange: { plan: null, interval: null, at: PERIOD_END },
    });
    await refused(harness, owner, CANCEL, 409, 'change_scheduled');
  });

  it('answers same_plan for the plan and interval the store is on, before Stripe', async () => {
    const harness = await setup();
    const { owner } = await paying(harness, { plan: 'growth', interval: 'year' });
    const reads = harness.stripe.control.retrieved;
    await refused(
      harness,
      owner,
      { action: 'switch', plan: 'growth', interval: 'year' },
      409,
      'same_plan',
    );
    expect(harness.stripe.control.retrieved).toBe(reads);
  });

  it('answers plan_unavailable for a missing tier or price, billing_failed when the price read fails', async () => {
    const harness = await setup();
    const { owner } = await paying(harness);
    await harness.directory.deleteTier('growth');
    await refused(harness, owner, SWITCH, 503, 'plan_unavailable');
    harness.stripe.prices.delete('askr_pro_monthly');
    await refused(
      harness,
      owner,
      { action: 'switch', plan: 'pro', interval: 'month' },
      503,
      'plan_unavailable',
    );
    // A lookup key whose price names another plan is not that plan's price.
    harness.stripe.prices.set('askr_scale_monthly', {
      id: 'price_x',
      plan: 'pro',
      interval: 'month',
    });
    await refused(
      harness,
      owner,
      { action: 'switch', plan: 'scale', interval: 'month' },
      503,
      'plan_unavailable',
    );
    harness.stripe.prices.set('askr_scale_monthly', {
      id: 'price_y',
      plan: 'scale',
      interval: 'year',
    });
    await refused(
      harness,
      owner,
      { action: 'switch', plan: 'scale', interval: 'month' },
      503,
      'plan_unavailable',
    );
    harness.stripe.control.failPrices = true;
    await refused(
      harness,
      owner,
      { action: 'switch', plan: 'starter', interval: 'year' },
      502,
      'billing_failed',
    );
    // A cancel needs no tier and no price.
    expect((await harness.call(owner, 'POST', PORTAL, CANCEL)).status).toBe(200);
  });

  it('checks again what Stripe holds now: the database can lag a webhook', async () => {
    const harness = await setup();
    const { owner, subscription } = await paying(harness, { plan: 'starter' });
    const live = harness.stripe.subscriptions.get(subscription);
    if (live === undefined) {
      throw new Error('no subscription');
    }
    const stripeHas = (overrides: Partial<typeof live>) =>
      harness.stripe.subscriptions.set(subscription, { ...live, ...overrides });
    stripeHas({ cancelAtPeriodEnd: true });
    await refused(harness, owner, SWITCH, 409, 'cancel_pending');
    await refused(harness, owner, CANCEL, 409, 'cancel_pending');
    stripeHas({ status: 'past_due' });
    await refused(harness, owner, CANCEL, 409, 'past_due');
    stripeHas({ scheduledChange: { plan: 'starter', interval: 'month', at: PERIOD_END } });
    await refused(harness, owner, CANCEL, 409, 'change_scheduled');
    stripeHas({ plan: 'growth', interval: 'month' });
    await refused(harness, owner, SWITCH, 409, 'same_plan');
    stripeHas({ status: 'canceled' });
    await refused(harness, owner, CANCEL, 409, 'no_subscription');
    harness.stripe.subscriptions.delete(subscription);
    await refused(harness, owner, CANCEL, 409, 'no_subscription');
    harness.stripe.subscriptions.set(subscription, live);
    harness.stripe.control.failSubscription = true;
    await refused(harness, owner, CANCEL, 502, 'billing_failed');
  });

  it('answers subscription_unexpected unless Stripe has exactly one item on a price of ours', async () => {
    const harness = await setup();
    const { owner, subscription } = await paying(harness);
    const live = harness.stripe.subscriptions.get(subscription);
    if (live === undefined) {
      throw new Error('no subscription');
    }
    harness.stripe.subscriptions.set(subscription, { ...live, plan: undefined });
    await refused(harness, owner, SWITCH, 409, 'subscription_unexpected');
    harness.stripe.subscriptions.set(subscription, { ...live, interval: undefined });
    await refused(harness, owner, CANCEL, 409, 'subscription_unexpected');
    harness.stripe.subscriptions.set(subscription, { ...live, itemId: undefined });
    await refused(harness, owner, CANCEL, 409, 'subscription_unexpected');
  });

  it('answers billing_unavailable while billing is off', async () => {
    const harness = await setup({ billing: false });
    const owner = newOwner();
    await harness.open(owner);
    expect((await harness.call(owner, 'POST', PORTAL, CANCEL)).body).toEqual({
      error: 'billing_unavailable',
    });
  });
});

describe('a cancel at a date (flexible billing mode)', () => {
  /** 2026-12-01T00:00:00Z: before the period ends. */
  const CANCEL_AT = 1_796_083_200;
  const subscription = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    metadata: {},
    // Flexible mode: the portal's cancel at the period end sets `cancel_at` and may leave this false.
    cancel_at: CANCEL_AT,
    cancel_at_period_end: false,
    created: NOW,
    items: {
      data: [{ id: 'si_1', current_period_end: PERIOD_END, price: price('askr_pro_monthly') }],
    },
  };
  const SWITCH = { action: 'switch', plan: 'growth', interval: 'month' };
  const CANCEL = { action: 'cancel' };

  it('is a pending cancel that ends the plan at cancel_at', () => {
    expect(snapshotOf(subscription, NOW)).toMatchObject({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: CANCEL_AT,
    });
    expect(snapshotOf({ ...subscription, cancel_at: null }, NOW)).toMatchObject({
      cancelAtPeriodEnd: false,
      currentPeriodEnd: PERIOD_END,
    });
  });

  it('refuses a switch and a cancel as cancel_pending, from the database and from Stripe, and shows its date', async () => {
    const harness = await setup();
    const { cancelAtPeriodEnd, currentPeriodEnd } = snapshotOf(subscription, NOW);
    const stored = await paying(harness, { cancelAtPeriodEnd, currentPeriodEnd });
    expect((await harness.call(stored.owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject(
      { cancelAtPeriodEnd: true, currentPeriodEnd: CANCEL_AT },
    );
    const lagging = await paying(harness);
    const live = harness.stripe.subscriptions.get(lagging.subscription);
    if (live === undefined) {
      throw new Error('no subscription');
    }
    harness.stripe.subscriptions.set(lagging.subscription, {
      ...live,
      cancelAtPeriodEnd,
      currentPeriodEnd,
    });
    for (const owner of [stored.owner, lagging.owner]) {
      for (const body of [SWITCH, CANCEL]) {
        expect(await harness.call(owner, 'POST', PORTAL, body)).toEqual({
          status: 409,
          body: { error: 'cancel_pending' },
        });
      }
    }
    expect(harness.stripe.portals).toEqual([]);
  });
});

describe('the scheduled change, from Stripe', () => {
  it("maps the first phase still to come on a price of ours, at that phase's start", () => {
    const schedule: ScheduleLike = {
      phases: [
        phase(NOW - 100, price('askr_pro_monthly')),
        phase(PERIOD_END, price('askr_starter_yearly', 'year')),
        phase(PERIOD_END + 1000, price('askr_growth_monthly')),
      ],
    };
    expect(scheduledChangeOf(schedule, NOW)).toEqual({
      plan: 'starter',
      interval: 'year',
      at: PERIOD_END,
    });
  });

  it('gives plan and interval null for a phase not on exactly one price of ours', () => {
    const foreign = { plan: null, interval: null, at: PERIOD_END };
    const next = (...prices: Parameters<typeof phase>[1][]) =>
      scheduledChangeOf({ phases: [phase(NOW - 1), phase(PERIOD_END, ...prices)] }, NOW);
    expect(next(price('other_monthly'))).toEqual(foreign);
    expect(next(price('askr_pro_monthly'), price('askr_pro_monthly'))).toEqual(foreign);
    expect(next()).toEqual(foreign);
    expect(next('price_unexpanded')).toEqual(foreign);
    expect(next({ id: 'price_gone', deleted: true })).toEqual(foreign);
  });

  it('gives null with no phase still to come, no schedule, or an unexpanded one', () => {
    expect(
      scheduledChangeOf(
        {
          phases: [
            phase(NOW - 100, price('askr_pro_monthly')),
            phase(NOW, price('askr_starter_monthly')),
          ],
        },
        NOW,
      ),
    ).toBeNull();
    expect(scheduledChangeOf(null, NOW)).toBeNull();
    expect(scheduledChangeOf(undefined, NOW)).toBeNull();
    expect(scheduledChangeOf('sub_schedule_1', NOW)).toBeNull();
  });

  it('carries it on the snapshot, read at the time given', () => {
    const subscription = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      metadata: {},
      cancel_at: null,
      cancel_at_period_end: false,
      created: NOW,
      items: {
        data: [{ id: 'si_1', current_period_end: PERIOD_END, price: price('askr_pro_monthly') }],
      },
      schedule: { phases: [phase(PERIOD_END, price('askr_starter_monthly'))] },
    };
    expect(snapshotOf(subscription, NOW).scheduledChange).toEqual({
      plan: 'starter',
      interval: 'month',
      at: PERIOD_END,
    });
    expect(snapshotOf(subscription, PERIOD_END).scheduledChange).toBeNull();
    expect(snapshotOf({ ...subscription, schedule: null }, NOW).scheduledChange).toBeNull();
  });

  it('is read by the real client with the schedule expanded, on its clock', async () => {
    const body = {
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      metadata: {},
      cancel_at_period_end: false,
      created: NOW,
      items: {
        object: 'list',
        data: [{ id: 'si_1', current_period_end: PERIOD_END, price: price('askr_pro_monthly') }],
      },
      schedule: {
        id: 'sub_schedule_1',
        object: 'subscription_schedule',
        phases: [
          phase(NOW - 10, price('askr_pro_monthly')),
          phase(PERIOD_END, price('askr_growth_yearly', 'year')),
        ],
      },
    };
    const fetcher = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
      });
    const gateway = createStripeGateway(
      'rk_test_stub',
      Stripe.createFetchHttpClient(fetcher),
      () => NOW,
    );
    expect(await gateway.subscription('sub_1')).toMatchObject({
      itemId: 'si_1',
      scheduledChange: { plan: 'growth', interval: 'year', at: PERIOD_END },
    });
    const later = createStripeGateway(
      'rk_test_stub',
      Stripe.createFetchHttpClient(fetcher),
      () => PERIOD_END,
    );
    expect((await later.subscription('sub_1'))?.scheduledChange).toBeNull();
  });
});

describe('the scheduled change, stored and shown', () => {
  const columns = async (harness: Harness, subscription: string) =>
    harness.db.query(
      `select scheduled_plan, scheduled_interval, scheduled_at from billing_subscriptions
       where subscription_id = $1`,
      [subscription],
    );

  it('is written from every snapshot, so a released schedule clears it', async () => {
    const harness = await setup();
    const { owner, subscription } = await paying(harness, { plan: 'pro' });
    const live = harness.stripe.subscriptions.get(subscription);
    if (live === undefined) {
      throw new Error('no subscription');
    }
    const change = { plan: 'starter' as const, interval: 'year' as const, at: PERIOD_END };
    harness.stripe.subscriptions.set(subscription, { ...live, scheduledChange: change });
    await harness.subscriptionEvent('customer.subscription.updated', live);
    expect(await columns(harness, subscription)).toEqual([
      { scheduled_plan: 'starter', scheduled_interval: 'year', scheduled_at: PERIOD_END },
    ]);
    expect((await harness.call(owner, 'GET', '/v1/admin/store')).body.billing).toMatchObject({
      plan: 'pro',
      scheduledChange: change,
    });
    harness.stripe.subscriptions.set(subscription, { ...live, scheduledChange: null });
    await harness.subscriptionEvent('customer.subscription.updated', live);
    expect(await columns(harness, subscription)).toEqual([
      { scheduled_plan: null, scheduled_interval: null, scheduled_at: null },
    ]);
    expect(
      (await harness.call(owner, 'GET', '/v1/admin/store')).body.billing.scheduledChange,
    ).toBeNull();
  });

  it('keeps a change to a price not ours as plan null, still blocking', async () => {
    const harness = await setup();
    const { owner, subscription } = await paying(harness, {
      scheduledChange: { plan: null, interval: null, at: PERIOD_END },
    });
    expect(await columns(harness, subscription)).toEqual([
      { scheduled_plan: null, scheduled_interval: null, scheduled_at: PERIOD_END },
    ]);
    expect(
      (await harness.call(owner, 'GET', '/v1/admin/store')).body.billing.scheduledChange,
    ).toEqual({ plan: null, interval: null, at: PERIOD_END });
  });

  it('is cleared when Stripe no longer has the subscription', async () => {
    const harness = await setup();
    const { subscription } = await paying(harness, {
      scheduledChange: { plan: 'starter', interval: 'month', at: PERIOD_END },
    });
    const live = harness.stripe.subscriptions.get(subscription);
    if (live === undefined) {
      throw new Error('no subscription');
    }
    harness.stripe.subscriptions.delete(subscription);
    await harness.subscriptionEvent('customer.subscription.deleted', live);
    expect(await columns(harness, subscription)).toEqual([
      { scheduled_plan: null, scheduled_interval: null, scheduled_at: null },
    ]);
  });

  it('migration 0011 adds the three nullable columns, the interval checked', async () => {
    expect(MIGRATIONS.map((entry) => entry.id).slice(-2)).toEqual([
      '0010_billing',
      '0011_billing_schedule',
    ]);
    const client = await PGlite.create();
    const db = pgliteDb(client);
    await migrate(db);
    await db.query(
      `insert into stores (owner, status, assistant, assistant_key, catalog_key,
         catalog_key_secret, created_at)
       values ($1, 'pending', $2, $3, $4, $5, $6)`,
      ['1'.repeat(64), 'b'.repeat(64), new Uint8Array(1), 'c'.repeat(64), new Uint8Array(1), NOW],
    );
    const insert = (id: string, interval: string | null) =>
      db.query(
        `insert into billing_subscriptions (subscription_id, owner, customer_id, status,
           stripe_created, updated_at, snapshot_fetched_at, scheduled_interval)
         values ($1, $2, 'cus_1', 'active', $3, $3, 0, $4)`,
        [id, '1'.repeat(64), NOW, interval],
      );
    await insert('sub_1', null);
    await insert('sub_2', 'year');
    await expect(insert('sub_3', 'week')).rejects.toThrow();
    expect(
      await db.query(
        'select scheduled_plan, scheduled_at from billing_subscriptions order by subscription_id',
      ),
    ).toEqual([
      { scheduled_plan: null, scheduled_at: null },
      { scheduled_plan: null, scheduled_at: null },
    ]);
    await client.close();
  });
});

describe('the schedule webhooks', () => {
  for (const type of [
    'subscription_schedule.created',
    'subscription_schedule.updated',
    'subscription_schedule.canceled',
  ]) {
    it(`${type} reads its subscription again`, async () => {
      const harness = await setup();
      const { owner, subscription, customer } = await paying(harness, { plan: 'pro' });
      const live = harness.stripe.subscriptions.get(subscription);
      if (live === undefined) {
        throw new Error('no subscription');
      }
      const change = { plan: 'growth' as const, interval: 'month' as const, at: PERIOD_END };
      harness.stripe.subscriptions.set(subscription, { ...live, scheduledChange: change });
      expect(
        await harness.deliver({
          id: `evt_${type}`,
          type,
          object: {
            id: 'sub_schedule_1',
            object: 'subscription_schedule',
            subscription,
            released_subscription: null,
            customer,
          },
        }),
      ).toEqual({ status: 200, body: { received: true } });
      expect(
        (await harness.call(owner, 'GET', '/v1/admin/store')).body.billing.scheduledChange,
      ).toEqual(change);
    });
  }

  it('subscription_schedule.released reads the subscription it let go of, clearing the change', async () => {
    const harness = await setup();
    const { owner, subscription, customer } = await paying(harness, {
      scheduledChange: { plan: 'starter', interval: 'month', at: PERIOD_END },
    });
    const live = harness.stripe.subscriptions.get(subscription);
    if (live === undefined) {
      throw new Error('no subscription');
    }
    harness.stripe.subscriptions.set(subscription, { ...live, scheduledChange: null });
    const reads = harness.stripe.control.retrieved;
    await harness.deliver({
      id: 'evt_released',
      type: 'subscription_schedule.released',
      object: {
        id: 'sub_schedule_1',
        object: 'subscription_schedule',
        subscription: null,
        released_subscription: subscription,
        customer,
      },
    });
    expect(harness.stripe.control.retrieved).toBe(reads + 1);
    expect(
      (await harness.call(owner, 'GET', '/v1/admin/store')).body.billing.scheduledChange,
    ).toBeNull();
  });

  it('ignores a schedule that names no subscription', async () => {
    const harness = await setup();
    const reads = harness.stripe.control.retrieved;
    await harness.deliver({
      id: 'evt_lonely',
      type: 'subscription_schedule.created',
      object: {
        id: 'sub_schedule_2',
        object: 'subscription_schedule',
        subscription: null,
        released_subscription: null,
        customer: 'cus_nobody',
      },
    });
    expect(harness.stripe.control.retrieved).toBe(reads);
  });
});

describe('the /admin redirect', () => {
  it('keeps the query string, so the plan chosen on the landing reaches the admin', () => {
    const pages = createAdminPages(new Map(), 'wss://relay.test');
    const redirect = (path: string) =>
      pages({ request: new Request(`http://localhost${path}`), clientAddress: '127.0.0.1' });
    expect(redirect('/admin?plan=growth&interval=year')?.headers.get('location')).toBe(
      '/admin/?plan=growth&interval=year',
    );
    expect(redirect('/admin?plan=growth&interval=year')?.status).toBe(308);
    expect(redirect('/admin')?.headers.get('location')).toBe('/admin/');
  });
});
