import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanChange } from '../../src/cloud/components/PlanChange';
import { createConsoleApi } from '../../src/cloud/lib/api';
import { OwnerKey } from '../../src/cloud/lib/owner-key';
import { type StoreView, storeViewOf } from '../../src/cloud/lib/store-view';
import { tierCardsFrom } from '../../src/cloud/lib/tiers';
import { type Mounted, buttonNamed, mount, settle } from '../mount';
import {
  type Answer,
  BILLING_REF,
  FakeStore,
  TENANT_ID,
  fakeCloud,
  readyState,
  tiersAnswer,
} from './fake-api';

const API = 'https://api.cloud.test';
const BILLING_URL = 'https://billing.elisym.example/pay';
const DAY = 86400;
const NOW = 1_800_000_000;
/** 30 Nov 2027, 00:00 UTC. */
const SWITCH = Date.UTC(2027, 10, 30) / 1000;
const PATH = `/tenants/${TENANT_ID}`;
const REQUEST_ID = `pr_${'a'.repeat(24)}`;
const PAY_URL = 'https://invoice.stripe.com/i/acct_1/test_1';
const TIERS = tierCardsFrom(tiersAnswer());
const loadTiers = async () => ({ status: 200, body: tiersAnswer() });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function viewWith(plan: unknown, tier: 'starter' | 'business' = 'starter'): StoreView {
  const view = storeViewOf({
    ...new FakeStore(readyState({ tier, activated: true })).view(),
    plan,
  });
  if (view === undefined) {
    throw new Error('the view does not parse');
  }
  return view;
}

/** The panel on a store whose view's plan is `plan`, against a cloud answering `routes`. */
async function panel(
  plan: unknown,
  routes: Record<string, Answer> = {},
  options: { tier?: 'starter' | 'business'; billingUrl?: string | undefined } = {},
) {
  const cloud = fakeCloud(routes);
  const api = createConsoleApi({
    apiOrigin: API,
    signer: OwnerKey.create(),
    fetcher: cloud.fetcher,
  });
  const record = { changed: 0, pages: [] as string[] };
  const billingUrl = 'billingUrl' in options ? options.billingUrl : BILLING_URL;
  mounted = await mount(
    <PlanChange
      api={api}
      tenantId={TENANT_ID}
      view={viewWith(plan, options.tier)}
      tiers={TIERS}
      billingUrl={billingUrl}
      loadTiers={loadTiers}
      now={() => NOW}
      onChanged={() => {
        record.changed += 1;
      }}
      onOpenPage={(page) => record.pages.push(page)}
    />,
  );
  const host = mounted.container;
  return { host, cloud, record };
}

function text(): string {
  return document.body.textContent ?? '';
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function hasButton(name: string): boolean {
  return [...document.querySelectorAll('button')].some((button) => button.textContent === name);
}

function anyButton(name: string): HTMLButtonElement {
  return buttonNamed(document.body, name);
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

/** Opens the sheet and picks `tier` once the plans are read; the preview is asked. */
async function pick(tier: string) {
  await click(anyButton('Change plan'));
  await settle(() => document.querySelector(`[data-tier="${tier}"]`) !== null);
  const card = document.querySelector<HTMLButtonElement>(`[data-tier="${tier}"]`);
  if (card === null) {
    throw new Error(`no plan ${tier}`);
  }
  await click(card);
}

function sent(cloud: ReturnType<typeof fakeCloud>, method: string, path: string) {
  return cloud.calls.filter((call) => call.method === method && call.path === path);
}

describe('the Change plan sheet', () => {
  it('marks the plan in force, and asks the server what a change to another would do', async () => {
    const { cloud } = await panel(
      { canChange: true },
      { [`POST ${PATH}/plan/preview`]: { status: 409, body: { error: 'invoice_pending' } } },
    );
    await pick('business');
    const current = document.querySelector<HTMLButtonElement>('[data-tier="starter"]');
    expect(current?.disabled).toBe(true);
    expect(current?.hasAttribute('data-current')).toBe(true);
    expect(current?.textContent).toContain('Your plan');
    // Enterprise is not a self-serve plan: talked about, never picked.
    expect(document.querySelector('[data-tier="high-risk"]')).toBeNull();
    expect(text()).toContain('Talk to us');
    await settle(() => text().includes('try again in an hour'));
    expect(sent(cloud, 'POST', `${PATH}/plan/preview`).map((call) => call.body)).toEqual([
      { tier: 'business' },
    ]);
    expect(
      sent(cloud, 'POST', `${PATH}/plan/preview`).every((call) => call.signer !== undefined),
    ).toBe(true);
    // A refusal offers no change: only Close.
    expect(hasButton('Close')).toBe(true);
    expect(sent(cloud, 'POST', `${PATH}/plan`)).toEqual([]);
    await click(anyButton('Close'));
    expect(dialog()).toBeNull();
  });

  it('a card upgrade: its words and amount, then pay and switch; done says so', async () => {
    const { cloud, record } = await panel(
      { canChange: true, card: { open: true } },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'starter',
            to: 'business',
            how: 'card',
            forfeits: NOW + 12 * DAY + 60,
            fitProblems: [],
          },
        },
        [`POST ${PATH}/plan`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'business',
            fitProblems: [],
            request: { id: REQUEST_ID, to: 'business', status: 'done', endedAt: NOW },
          },
        },
      },
    );
    await pick('business');
    await settle(() => hasButton('Pay $99 and switch'));
    expect(dialog()?.textContent).toContain(
      'Business starts now at $99 a month, charged to your card today. A new monthly period starts today.The 12 days left on Starter are not carried over.',
    );
    // Two clicks in one moment send one change.
    await act(async () => {
      anyButton('Pay $99 and switch').click();
      anyButton('Pay $99 and switch').click();
    });
    await settle(() => dialog() === null);
    expect(sent(cloud, 'POST', `${PATH}/plan`).map((call) => call.body)).toEqual([
      { tier: 'business' },
    ]);
    expect(record.changed).toBe(1);
    expect(text()).toContain('Your payment went through: you are on Business.');
  });

  it('a card upgrade waiting for the bank: the sheet closes, the row says the rest', async () => {
    const { record } = await panel(
      { canChange: true },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: { tier: 'starter', to: 'business', how: 'card', fitProblems: [] },
        },
        [`POST ${PATH}/plan`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'starter',
            fitProblems: [],
            request: { id: REQUEST_ID, to: 'business', status: 'awaiting_confirmation' },
          },
        },
      },
    );
    await pick('business');
    await settle(() => hasButton('Pay $99 and switch'));
    // No paid time left to forfeit: no words of it.
    expect(dialog()?.textContent).not.toContain('carried over');
    await click(anyButton('Pay $99 and switch'));
    await settle(() => dialog() === null);
    expect(record.changed).toBe(1);
    expect(text()).not.toContain('went through');
  });

  it('a stablecoin upgrade: the billing page, linked with the owner-bound reference', async () => {
    const { cloud } = await panel(
      { canChange: true },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: {
            tier: 'starter',
            to: 'business',
            how: 'billing_page',
            forfeits: NOW + 12 * DAY,
            fitProblems: [],
          },
        },
      },
    );
    await pick('business');
    await settle(() => text().includes('On the billing page'));
    expect(dialog()?.textContent).toContain(
      'Business starts when your payment arrives, for a full month.The 12 days left on Starter are not carried over.On the billing page, choose Business, one month.',
    );
    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Open the billing page',
    );
    expect(link?.getAttribute('href')).toBe(`${BILLING_URL}?customer_ref=${BILLING_REF}`);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(sent(cloud, 'POST', `${PATH}/plan`)).toEqual([]);
  });

  it('no billing page here: says so, and links nowhere', async () => {
    await panel(
      { canChange: true },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: { tier: 'starter', to: 'business', how: 'billing_page', fitProblems: [] },
        },
      },
      { billingUrl: undefined },
    );
    await pick('business');
    await settle(() => text().includes('The billing page is not available here: contact elisym.'));
    expect(document.querySelector('a[href*="customer_ref"]')).toBeNull();
    expect(hasButton('Close')).toBe(true);
  });

  it('a downgrade: the day, what is over and the cap; scheduled, the sheet closes', async () => {
    const capWords =
      'Starter is meant for up to 2,000 paid orders a month; you had 2,340 this month. Orders are never blocked.';
    const { cloud, record } = await panel(
      { canChange: true },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: {
            tier: 'business',
            to: 'starter',
            how: 'scheduled',
            at: SWITCH,
            fitProblems: ['240 products, the Starter plan takes up to 100'],
            capWords,
          },
        },
        [`POST ${PATH}/plan`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'business',
            fitProblems: [],
            scheduled: { tier: 'starter', at: SWITCH },
          },
        },
      },
      { tier: 'business' },
    );
    await pick('starter');
    await settle(() => hasButton('Move to Starter on 30 Nov'));
    const said = dialog()?.textContent ?? '';
    expect(said).toContain(
      'Your store moves to Starter on 30 Nov. Until then you keep Business. From then, $29 a month.',
    );
    expect(said).toContain(
      "On Starter, your store will be over its limits: 240 products, the Starter plan takes up to 100. Nothing is removed: your products stay on sale, but you cannot add new ones until you are within Starter's limits.",
    );
    expect(said).toContain(capWords);
    await click(anyButton('Move to Starter on 30 Nov'));
    await settle(() => dialog() === null);
    expect(sent(cloud, 'POST', `${PATH}/plan`).map((call) => call.body)).toEqual([
      { tier: 'starter' },
    ]);
    expect(record.changed).toBe(1);
    // The scheduled row says it once the store is read again: no line of its own here.
    expect(text()).not.toContain('Your store is on');
  });

  it('nothing paid now: moves at once, and says so', async () => {
    const { record } = await panel(
      { canChange: true },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: { tier: 'starter', to: 'business', how: 'now', fitProblems: [] },
        },
        [`POST ${PATH}/plan`]: {
          body: { tenantId: TENANT_ID, tier: 'business', fitProblems: [] },
        },
      },
    );
    await pick('business');
    await settle(() => hasButton('Move to Business now'));
    expect(dialog()?.textContent).toContain(
      'Your store moves to Business now. Your next payment is $99 a month.',
    );
    await click(anyButton('Move to Business now'));
    await settle(() => dialog() === null);
    expect(record.changed).toBe(1);
    expect(text()).toContain('Your store is on Business now.');
  });

  it('a store that paid before is sent to pay for the bigger plan', async () => {
    await panel(
      { canChange: true },
      { [`POST ${PATH}/plan/preview`]: { status: 409, body: { error: 'pay_for_upgrade' } } },
    );
    await pick('business');
    await settle(() => text().includes('Pay for Business to move to it'));
    expect(dialog()?.textContent).toContain(
      'Pay for Business to move to it: on the billing page choose Business, or pay by card.',
    );
    expect(
      [...document.querySelectorAll('a')].some(
        (anchor) =>
          anchor.textContent === 'Open the billing page' &&
          anchor.getAttribute('href') === `${BILLING_URL}?customer_ref=${BILLING_REF}`,
      ),
    ).toBe(true);
  });

  it("over the smaller plan's limits: the server's words, and the page that fixes it", async () => {
    for (const [code, detail, label, page] of [
      [
        'remove_products_first',
        'Starter takes up to 100 products, your store has 300: remove 200 first',
        'Go to Products',
        'products',
      ],
      [
        'remove_own_rpc_first',
        'Starter runs on our RPCs: remove your own RPC first',
        'Go to Settings',
        'settings',
      ],
    ] as const) {
      const { record } = await panel(
        { canChange: true },
        { [`POST ${PATH}/plan/preview`]: { status: 409, body: { error: code, detail } } },
        { tier: 'business' },
      );
      await pick('starter');
      await settle(() => text().includes(detail));
      // No switch button: only the way to fix it.
      expect(hasButton('Move to Starter now')).toBe(false);
      await click(anyButton(label));
      expect(record.pages).toEqual([page]);
      expect(dialog()).toBeNull();
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('the change refused after its preview: said in the sheet, and the store read again', async () => {
    const { record } = await panel(
      { canChange: true },
      {
        [`POST ${PATH}/plan/preview`]: {
          body: { tier: 'starter', to: 'business', how: 'now', fitProblems: [] },
        },
        [`POST ${PATH}/plan`]: { status: 409, body: { error: 'state_changed' } },
      },
    );
    await pick('business');
    await settle(() => hasButton('Move to Business now'));
    await click(anyButton('Move to Business now'));
    await settle(() => text().includes('Your store changed meanwhile'));
    expect(dialog()).not.toBeNull();
    expect(hasButton('Move to Business now')).toBe(false);
    expect(record.changed).toBe(1);
    // Picking again asks again, and offers the change again.
    const card = document.querySelector<HTMLButtonElement>('[data-tier="business"]');
    if (card === null) {
      throw new Error('no plan');
    }
    await click(card);
    await settle(() => hasButton('Move to Business now'));
  });

  it('a cloud that cannot be reached, or a preview it does not answer as one', async () => {
    const { cloud } = await panel(
      { canChange: true },
      { [`POST ${PATH}/plan/preview`]: { body: { how: 'later' } } },
    );
    await pick('business');
    await settle(() => text().includes('The cloud did not answer as expected (HTTP 200).'));
    expect(hasButton('Close')).toBe(true);
    cloud.routes.set(`POST ${PATH}/plan/preview`, {
      status: 503,
      body: { error: 'stripe_unavailable' },
    });
    await click(anyButton('Close'));
    await pick('business');
    await settle(() => text().includes('Card payments could not be reached just now'));
  });
});

describe('picks in a row', () => {
  it("only the newest pick's answer counts: an older preview that lands late is dropped", async () => {
    const catalog = tiersAnswer();
    const list = Array.isArray(catalog.tiers) ? catalog.tiers : [];
    const withPro = {
      tiers: [
        ...list,
        { ...list[1], id: 'pro', name: 'Pro', price: '$199/mo', monthlyCents: 19900 },
      ],
    };
    const loadPro = async () => ({ status: 200, body: withPro });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cloud = fakeCloud({
      [`POST ${PATH}/plan/preview`]: (body) => ({
        body: {
          tier: 'starter',
          to: Object(body).tier,
          how: Object(body).tier === 'business' ? 'card' : 'now',
          fitProblems: [],
        },
      }),
    });
    const fetcher = async (request: Request) => {
      const answer = await cloud.fetcher(request.clone());
      const asked = await request.clone().text();
      if (asked.includes('business')) {
        await held;
      }
      return answer;
    };
    const api = createConsoleApi({ apiOrigin: API, signer: OwnerKey.create(), fetcher });
    mounted = await mount(
      <PlanChange
        api={api}
        tenantId={TENANT_ID}
        view={viewWith({ canChange: true })}
        tiers={tierCardsFrom(withPro)}
        billingUrl={BILLING_URL}
        loadTiers={loadPro}
        now={() => NOW}
        onChanged={() => undefined}
        onOpenPage={() => undefined}
      />,
    );
    await pick('business');
    await settle(() => text().includes('Reading what this change does'));
    const pro = document.querySelector<HTMLButtonElement>('[data-tier="pro"]');
    if (pro === null) {
      throw new Error('no plan pro');
    }
    await click(pro);
    await settle(() => hasButton('Move to Pro now'));
    release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(hasButton('Move to Pro now')).toBe(true);
    expect(hasButton('Pay $99 and switch')).toBe(false);
  });
});

describe('the plan rows', () => {
  it('a plan that cannot change here says why, with no Change plan', async () => {
    await panel({ canChange: false, reason: 'partner' });
    expect(text()).toContain('Your partner manages your plan.');
    expect(hasButton('Change plan')).toBe(false);
    await mounted?.unmount();
    await panel({ canChange: false, reason: 'not_self_serve' });
    expect(text()).toContain('To change this plan, contact elisym.');
    expect(hasButton('Change plan')).toBe(false);
  });

  it('a cloud that sends no plan shows nothing', async () => {
    const view = viewWith(undefined);
    expect(view.plan).toBeUndefined();
    const { host } = await panel(undefined);
    expect(host.textContent).toBe('');
  });

  it('a payment being processed: Check again reads it; applied, it says so', async () => {
    const { cloud, record } = await panel(
      { canChange: true, request: { id: REQUEST_ID, to: 'business', status: 'charging' } },
      {
        [`POST ${PATH}/plan/requests/${REQUEST_ID}/check`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'business',
            request: { id: REQUEST_ID, to: 'business', status: 'done' },
          },
        },
      },
    );
    expect(text()).toContain('Your payment is being processed.');
    // One change at a time: no Change plan while it is on its way, and no Cancel before the bank asks.
    expect(hasButton('Change plan')).toBe(false);
    expect(hasButton('Cancel')).toBe(false);
    expect(document.querySelector('a')).toBeNull();
    await click(anyButton('Check again'));
    await settle(() => record.changed === 1);
    expect(sent(cloud, 'POST', `${PATH}/plan/requests/${REQUEST_ID}/check`)).toHaveLength(1);
    expect(text()).toContain('Your payment went through: you are on Business.');
  });

  it('Check again that finds it still on its way says nothing new', async () => {
    const { record } = await panel(
      { canChange: true, request: { id: REQUEST_ID, to: 'business', status: 'charging' } },
      {
        [`POST ${PATH}/plan/requests/${REQUEST_ID}/check`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'starter',
            request: { id: REQUEST_ID, to: 'business', status: 'charging' },
          },
        },
      },
    );
    await click(anyButton('Check again'));
    await settle(() => record.changed === 1);
    expect(text()).not.toContain('went through');
  });

  it("waiting for the bank: the amount and the deadline, Stripe's page, Cancel", async () => {
    const expiresAt = Date.UTC(2027, 10, 3, 14, 20) / 1000;
    const { cloud, record } = await panel(
      {
        canChange: true,
        request: {
          id: REQUEST_ID,
          to: 'business',
          status: 'awaiting_confirmation',
          payUrl: PAY_URL,
          expiresAt,
        },
      },
      {
        [`DELETE ${PATH}/plan/requests/${REQUEST_ID}`]: {
          body: {
            tenantId: TENANT_ID,
            tier: 'starter',
            request: { id: REQUEST_ID, to: 'business', status: 'cancelled' },
            outcome: 'cancelled',
          },
        },
      },
    );
    expect(text()).toContain(
      'Your card needs you to confirm the payment of $99 by 3 Nov, 14:20 UTC. Until then nothing changes.',
    );
    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Confirm the payment',
    );
    expect(link?.getAttribute('href')).toBe(PAY_URL);
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(hasButton('Change plan')).toBe(false);
    await act(async () => {
      anyButton('Cancel').click();
      anyButton('Cancel').click();
    });
    await settle(() => record.changed === 1);
    const cancels = sent(cloud, 'DELETE', `${PATH}/plan/requests/${REQUEST_ID}`);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.signer).toBeDefined();
    expect(cancels[0]?.body).toBeUndefined();
  });

  it("Cancel that finds it paid, or held for us: the server's words", async () => {
    for (const [outcome, words] of [
      ['already_paid', 'Your payment went through: you are on Business.'],
      ['needs_us', 'Your plan change needs us: we will contact you.'],
    ] as const) {
      const { record } = await panel(
        {
          canChange: true,
          request: { id: REQUEST_ID, to: 'business', status: 'awaiting_confirmation' },
        },
        {
          [`DELETE ${PATH}/plan/requests/${REQUEST_ID}`]: {
            body: {
              tenantId: TENANT_ID,
              tier: 'business',
              request: { id: REQUEST_ID, to: 'business', status: 'done' },
              outcome,
              words,
            },
          },
        },
      );
      await click(anyButton('Cancel'));
      await settle(() => record.changed === 1);
      expect(document.querySelector('[role="status"].text-ok')?.textContent).toBe(words);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('Cancel that cannot be done now: the words, and the request still shown', async () => {
    const { record } = await panel(
      {
        canChange: true,
        request: { id: REQUEST_ID, to: 'business', status: 'awaiting_confirmation' },
      },
      {
        [`DELETE ${PATH}/plan/requests/${REQUEST_ID}`]: {
          status: 503,
          body: {
            error: 'cancel_not_done',
            detail: 'Your payment could not be cancelled right now: try again in a minute.',
          },
        },
      },
    );
    await click(anyButton('Cancel'));
    await settle(() => text().includes('try again in a minute'));
    expect(record.changed).toBe(0);
    expect(hasButton('Cancel')).toBe(true);
    // A pay page that is not Stripe's invoice host is never linked.
    expect(document.querySelector('a')).toBeNull();
  });

  it("a pay page off Stripe's invoice host is not linked", async () => {
    await panel({
      canChange: true,
      request: {
        id: REQUEST_ID,
        to: 'business',
        status: 'awaiting_confirmation',
        payUrl: 'https://evil.example/i/1',
      },
    });
    expect(document.querySelector('a')).toBeNull();
    expect(hasButton('Cancel')).toBe(true);
  });

  it('a gone request (404) or one moved (409): the store is read again', async () => {
    for (const [status, error] of [
      [404, 'no_such_request'],
      [409, 'not_cancellable'],
    ] as const) {
      const { record } = await panel(
        {
          canChange: true,
          request: { id: REQUEST_ID, to: 'business', status: 'awaiting_confirmation' },
        },
        { [`DELETE ${PATH}/plan/requests/${REQUEST_ID}`]: { status, body: { error } } },
      );
      await click(anyButton('Cancel'));
      await settle(() => record.changed === 1);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('an ended request says what happened; a failed one offers Change plan again', async () => {
    for (const [status, words, canChangeShown] of [
      ['expired', 'The payment for Business was not completed in time: nothing changed.', true],
      ['cancelled', 'You cancelled the change to Business: nothing changed.', true],
      ['failed', 'Business could not be started: nothing changed. Try again.', true],
      ['unknown', 'Your plan change needs us: we will contact you.', false],
    ] as const) {
      await panel({
        canChange: true,
        request: { id: REQUEST_ID, to: 'business', status, endedAt: NOW },
      });
      expect(text(), status).toContain(words);
      expect(hasButton('Check again'), status).toBe(false);
      expect(hasButton('Cancel'), status).toBe(false);
      expect(hasButton('Change plan'), status).toBe(canChangeShown);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('a scheduled downgrade: when, and Keep', async () => {
    const { cloud, record } = await panel(
      { canChange: true, scheduled: { tier: 'starter', at: SWITCH } },
      { [`DELETE ${PATH}/plan/scheduled`]: { body: { tenantId: TENANT_ID, tier: 'business' } } },
      { tier: 'business' },
    );
    expect(text()).toContain('Moves to Starter on 30 Nov');
    await click(anyButton('Keep Business'));
    await settle(() => record.changed === 1);
    expect(sent(cloud, 'DELETE', `${PATH}/plan/scheduled`)).toHaveLength(1);
    expect(text()).toContain('Your store stays on Business.');
  });

  it("Keep refused: the server's words, and the store read again", async () => {
    const detail =
      'Your store moves to Starter in a few minutes: once it has, change plan to go back to Business.';
    const { record } = await panel(
      { canChange: true, scheduled: { tier: 'starter', at: SWITCH } },
      {
        [`DELETE ${PATH}/plan/scheduled`]: {
          status: 409,
          body: { error: 'keep_refused', detail },
        },
      },
      { tier: 'business' },
    );
    await click(anyButton('Keep Business'));
    await settle(() => text().includes(detail));
    expect(record.changed).toBe(1);
  });

  it('Keep not open: its words instead of the button', async () => {
    await panel(
      {
        canChange: true,
        scheduled: {
          tier: 'starter',
          at: SWITCH,
          keepRefusal: 'card_started',
          keepWords: 'Your Starter card plan has started: change plan to go back to Business.',
        },
      },
      {},
      { tier: 'business' },
    );
    expect(text()).toContain(
      'Your Starter card plan has started: change plan to go back to Business.',
    );
    expect(hasButton('Keep Business')).toBe(false);
  });
});
