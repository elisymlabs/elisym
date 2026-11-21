import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingSection } from '../src/components/BillingSection';
import { BillingSwitch } from '../src/components/BillingSwitch';
import { CONTACT_URL } from '../src/constants';
import { PENDING_CONTACT_TEXT } from '../src/lib/activation';
import { ApiError } from '../src/lib/api';
import type { AdminClient } from '../src/lib/deps';
import { OPERATOR_TEXT, SUSPENDED_TEXT } from '../src/lib/plan-actions';
import { PAID_THROUGH_US_TEXT, type PlanIntent } from '../src/lib/plan-intent';
import { PLANS } from '../src/lib/plans';
import type { BillingInterval, BillingView, StoreView } from '../src/lib/types';
import { BILLING_OFF, BILLING_ON, FREE_TIER, billingProps, fakeApi, storeView } from './fakes';
import { type Mounted, byId, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

/** 2026-12-25T00:00:00Z */
const PERIOD_END = 1_798_156_800;

const CARDS = ['free', 'starter', 'growth', 'pro', 'scale', 'enterprise'] as const;

/** A store paying for Growth, yearly, with nothing pending. */
const GROWTH_YEARLY: BillingView = {
  enabled: true,
  plan: 'growth',
  interval: 'year',
  status: 'active',
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  manageable: true,
  checkoutAvailable: false,
  operatorManaged: false,
  scheduledChange: null,
};

const PAYING = storeView({ tier: { ...FREE_TIER, name: 'growth' }, billing: GROWTH_YEARLY });
const ON_FREE = storeView({ tier: { ...FREE_TIER }, billing: BILLING_ON });
const CHOOSING = storeView({ status: 'pending', tier: null, billing: BILLING_ON });

async function mountBilling(
  view: StoreView,
  options: { api?: AdminClient; intent?: PlanIntent } = {},
) {
  const props = billingProps(options.api ?? fakeApi());
  mounted = await mount(
    <BillingSection
      {...props}
      view={view}
      {...(options.intent === undefined ? {} : { intent: options.intent })}
    />,
  );
  return { container: mounted.container, ...props, api: props.deps.api };
}

/** What each card offers, as its action area reads. */
function actions(container: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    CARDS.map((card) => [
      card,
      byId(container, `plan-${card}`).querySelector('[data-action]')?.textContent ?? '',
    ]),
  );
}

/** Every button in the plan cards. */
function cardButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...byId(container, 'plans').querySelectorAll<HTMLButtonElement>('li button')];
}

async function choosePeriod(container: HTMLElement, interval: BillingInterval) {
  const label = interval === 'year' ? 'Yearly' : 'Monthly';
  const radio = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label,
  );
  if (radio === undefined) {
    throw new Error(`no ${label} radio`);
  }
  await click(radio);
}

describe('the Billing tab, by store state (D6.3)', () => {
  it('pending with no plan and billing on: Start on Free, Upgrade on each paid plan, Contact us', async () => {
    const { container } = await mountBilling(CHOOSING);
    expect(actions(container)).toEqual({
      free: 'Start on Free',
      starter: 'Upgrade',
      growth: 'Upgrade',
      pro: 'Upgrade',
      scale: 'Upgrade',
      enterprise: 'Contact us',
    });
    expect(byId(container, 'current-plan-name').textContent).toBe('No plan yet');
    expect(byId(container, 'plans').textContent).not.toContain(PAID_THROUGH_US_TEXT);
  });

  it('pending with no plan and billing off: Start on Free only, the paid plans through us', async () => {
    const { container } = await mountBilling(
      storeView({ status: 'pending', tier: null, billing: BILLING_OFF }),
    );
    expect(actions(container)).toEqual({
      free: 'Start on Free',
      starter: '',
      growth: '',
      pro: '',
      scale: '',
      enterprise: 'Contact us',
    });
    expect(byId(container, 'plans').textContent).toContain(PAID_THROUGH_US_TEXT);
    expect(byId(container, 'plans').querySelectorAll('.contact-link')).toHaveLength(1);
  });

  it('active on Free with checkout: Free is the current plan, each paid plan an Upgrade to its checkout', async () => {
    const { container, api, deps, onIntentDone } = await mountBilling(ON_FREE);
    expect(actions(container)).toEqual({
      free: 'Current plan',
      starter: 'Upgrade',
      growth: 'Upgrade',
      pro: 'Upgrade',
      scale: 'Upgrade',
      enterprise: 'Contact us',
    });
    expect(byId(container, 'current-plan-name').textContent).toBe('Free');
    await click(byId(container, 'upgrade-growth'));
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('growth', 'year');
    expect(deps.openUrl).toHaveBeenCalledWith('https://checkout.stripe.test/c/1');
    expect(onIntentDone).toHaveBeenCalledTimes(1);
    expect(api.billingPortal).not.toHaveBeenCalled();
  });

  it('checks out the period shown: monthly once Monthly is chosen', async () => {
    const { container, api } = await mountBilling(ON_FREE);
    await choosePeriod(container, 'month');
    await click(byId(container, 'upgrade-pro'));
    await settle(() => vi.mocked(api.checkout).mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('pro', 'month');
  });

  it('paying, nothing pending: Current plan, the other period a switch, up an Upgrade, down a Downgrade, Free a cancel', async () => {
    const { container } = await mountBilling(PAYING);
    expect(actions(container)).toEqual({
      free: 'Cancel plan',
      starter: 'Downgrade',
      growth: 'Current plan',
      pro: 'Upgrade',
      scale: 'Upgrade',
      enterprise: 'Contact us',
    });
    await choosePeriod(container, 'month');
    expect(actions(container)).toEqual({
      free: 'Cancel plan',
      starter: 'Downgrade',
      growth: 'Switch to monthly',
      pro: 'Upgrade',
      scale: 'Upgrade',
      enterprise: 'Contact us',
    });
    expect(byId(container, 'current-plan-name').textContent).toBe('Growth, billed yearly');
  });

  it('paying monthly: the yearly card of the same plan is Switch to yearly', async () => {
    const { container } = await mountBilling(
      storeView({ billing: { ...GROWTH_YEARLY, interval: 'month', status: 'trialing' } }),
    );
    expect(actions(container).growth).toBe('Switch to yearly');
    await choosePeriod(container, 'month');
    expect(actions(container).growth).toBe('Current plan');
  });

  it('sends each portal action with its plan and the period shown, or the cancel', async () => {
    const { container, api, deps } = await mountBilling(PAYING);
    await click(byId(container, 'change-pro'));
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length === 1);
    expect(api.billingPortal).toHaveBeenLastCalledWith({
      action: 'switch',
      plan: 'pro',
      interval: 'year',
    });
    await act(async () => {
      globalThis.dispatchEvent(new Event('pageshow'));
    });
    await choosePeriod(container, 'month');
    await click(byId(container, 'change-growth'));
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length === 2);
    expect(api.billingPortal).toHaveBeenLastCalledWith({
      action: 'switch',
      plan: 'growth',
      interval: 'month',
    });
    await act(async () => {
      globalThis.dispatchEvent(new Event('pageshow'));
    });
    await click(byId(container, 'change-starter'));
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length === 3);
    expect(api.billingPortal).toHaveBeenLastCalledWith({
      action: 'switch',
      plan: 'starter',
      interval: 'month',
    });
    await act(async () => {
      globalThis.dispatchEvent(new Event('pageshow'));
    });
    await click(byId(container, 'cancel-plan'));
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length === 4);
    expect(api.billingPortal).toHaveBeenLastCalledWith({ action: 'cancel' });
    expect(deps.openUrl).toHaveBeenLastCalledWith('https://billing.stripe.test/p/1');
    expect(api.checkout).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a scheduled change',
      { scheduledChange: { plan: 'starter', interval: 'month', at: PERIOD_END } } as const,
      'Your plan changes to Starter, billed monthly, on December 25, 2026. Until then it cannot be changed here: keep or undo the change under Manage billing.',
    ],
    [
      'a scheduled change to a plan not ours',
      { scheduledChange: { plan: null, interval: 'month', at: PERIOD_END } } as const,
      'Your plan changes on December 25, 2026.',
    ],
    [
      'a pending cancel',
      { cancelAtPeriodEnd: true },
      'Your plan ends on December 25, 2026. Until then it cannot be changed here: undo the cancel under Manage billing.',
    ],
    [
      'a failed payment',
      { status: 'past_due' },
      'A payment failed. Your plan cannot be changed here until it is paid: update your payment method under Manage billing.',
    ],
    [
      'a failed payment and a pending cancel',
      { status: 'past_due', cancelAtPeriodEnd: true },
      'A payment failed.',
    ],
  ])(
    'paying with %s: no card actions, one line and Manage billing',
    async (_name, change, line) => {
      const { container, api } = await mountBilling(
        storeView({ billing: { ...GROWTH_YEARLY, ...change } }),
      );
      expect(cardButtons(container)).toEqual([]);
      expect(actions(container)).toEqual({
        free: '',
        starter: '',
        growth: 'Current plan',
        pro: '',
        scale: '',
        enterprise: 'Contact us',
      });
      expect(byId(container, 'billing-locked').textContent).toContain(line);
      await click(byId(container, 'manage-billing'));
      await settle(() => vi.mocked(api.billingPortal).mock.calls.length === 1);
      // Manage billing opens the portal's home, where the owner undoes or fixes it.
      expect(api.billingPortal).toHaveBeenCalledWith();
    },
  );

  it.each([
    [
      'operator-managed',
      storeView({ billing: { ...GROWTH_YEARLY, operatorManaged: true } }),
      OPERATOR_TEXT,
    ],
    ['suspended', storeView({ status: 'suspended', billing: GROWTH_YEARLY }), SUSPENDED_TEXT],
    [
      'set back to pending by us',
      storeView({ status: 'pending', billing: BILLING_ON }),
      PENDING_CONTACT_TEXT,
    ],
    [
      'billing off, on Free',
      storeView({ tier: { ...FREE_TIER }, billing: BILLING_OFF }),
      PAID_THROUGH_US_TEXT,
    ],
    [
      'billing off, a paid plan',
      storeView({ billing: { ...GROWTH_YEARLY, enabled: false } }),
      PAID_THROUGH_US_TEXT,
    ],
  ])('%s: no buttons, message-us text and the contact line', async (_name, view, text) => {
    const { container } = await mountBilling(view);
    expect(cardButtons(container)).toEqual([]);
    expect(container.querySelector('#billing-locked')).toBeNull();
    const plans = byId(container, 'plans');
    expect(plans.textContent).toContain(text);
    expect(plans.querySelectorAll('.contact-link')).toHaveLength(1);
    expect(actions(container).enterprise).toBe('Contact us');
  });

  it('a paid plan bought and not yet live (checkout open): no buttons, through us', async () => {
    const { container } = await mountBilling(
      storeView({
        billing: { ...BILLING_ON, checkoutAvailable: false, status: 'incomplete', plan: 'pro' },
      }),
    );
    expect(cardButtons(container)).toEqual([]);
    expect(byId(container, 'plans').textContent).toContain('cannot be bought here right now');
  });

  it('Enterprise is always Contact us, to the contact page', async () => {
    for (const view of [CHOOSING, ON_FREE, PAYING]) {
      const { container } = await mountBilling(view);
      const link = byId(container, 'plan-enterprise').querySelector('a');
      expect(link?.textContent).toBe('Contact us');
      expect(link?.getAttribute('href')).toBe(CONTACT_URL);
      await mounted?.unmount();
      mounted = undefined;
    }
  });
});

describe('the Billing tab buttons that leave the page', () => {
  it.each([
    ['checkout', ON_FREE, 'upgrade-starter'],
    ['portal switch', PAYING, 'change-scale'],
    ['portal cancel', PAYING, 'cancel-plan'],
  ] as const)(
    '%s: every card button is busy until the page leaves, and works again on pageshow',
    async (_name, view, id) => {
      const { container, deps } = await mountBilling(view);
      await click(byId(container, id));
      await settle(() => vi.mocked(deps.openUrl).mock.calls.length > 0);
      expect(cardButtons(container).every((button) => button.disabled)).toBe(true);
      expect(byId(container, id).getAttribute('aria-busy')).toBe('true');
      await act(async () => {
        globalThis.dispatchEvent(new Event('pageshow'));
      });
      expect(cardButtons(container).some((button) => button.disabled)).toBe(false);
    },
  );

  it('says a refusal and lets the owner try again', async () => {
    const api = fakeApi({
      billingPortal: vi.fn(async () => Promise.reject(new ApiError(409, 'change_scheduled'))),
    });
    const { container, deps, onIntentDone } = await mountBilling(PAYING, { api });
    await click(byId(container, 'change-pro'));
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already scheduled');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(onIntentDone).not.toHaveBeenCalled();
    expect(byId(container, 'change-pro')).toHaveProperty('disabled', false);
  });
});

describe('the plan cards (D6.2)', () => {
  it('default to yearly, priced as the landing, with blurb, note and features', async () => {
    const { container } = await mountBilling(CHOOSING);
    const growth = byId(container, 'plan-growth');
    expect(growth.textContent).toContain('$79/ month');
    expect(growth.textContent).toContain('Subscription, $948 billed yearly');
    expect(growth.textContent).toContain('For a store that sells every day.');
    expect(byId(container, 'plan-free').textContent).toContain('No payment needed');
    for (const plan of PLANS) {
      const card = byId(container, `plan-${plan.name.toLowerCase()}`);
      const features = [...card.querySelectorAll('ul li')].map((item) => item.textContent);
      expect(features).toEqual(plan.features);
      expect(card.textContent?.includes('Most popular')).toBe(plan.featured);
    }
    expect(container.textContent).toContain('Prices in USD, tax included.');
    await choosePeriod(container, 'month');
    expect(growth.textContent).toContain('$99/ month');
    expect(growth.textContent).toContain('Monthly subscription');
    expect(growth.textContent).not.toContain('billed yearly');
  });

  it('show the current tier limits and Manage billing above them', async () => {
    const { container } = await mountBilling(PAYING);
    const current = byId(container, 'current-plan');
    expect(current.textContent).toContain('Active');
    expect(current.textContent).toContain('renews on December 25, 2026');
    expect(current.textContent).toContain('Up to 100 products');
    expect(current.querySelector('#manage-billing')).not.toBeNull();
  });

  it('badge a live plan by its state', async () => {
    const cases: Array<[Partial<BillingView>, string]> = [
      [{ status: 'past_due' }, 'Payment failed'],
      [{ cancelAtPeriodEnd: true }, 'Canceled'],
      [{ scheduledChange: { plan: 'pro', interval: 'year', at: PERIOD_END } }, 'Change scheduled'],
      [{ status: 'trialing' }, 'Trial'],
    ];
    for (const [change, badge] of cases) {
      const { container } = await mountBilling(
        storeView({ billing: { ...GROWTH_YEARLY, ...change } }),
      );
      expect(byId(container, 'current-plan').querySelector('.badge')?.textContent).toBe(badge);
      await mounted?.unmount();
      mounted = undefined;
    }
  });
});

describe('the billing period switch (W3)', () => {
  async function press(target: HTMLElement, key: string) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  it('is one radio group with one tab stop on the chosen period, and says what yearly saves', async () => {
    const onChange = vi.fn();
    mounted = await mount(<BillingSwitch value="year" onChange={onChange} />);
    const { container } = mounted;
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'Billing period',
    );
    const [monthly, yearly] = radios(container);
    expect(monthly?.textContent).toBe('Monthly');
    expect(monthly?.getAttribute('aria-checked')).toBe('false');
    expect(monthly?.tabIndex).toBe(-1);
    expect(yearly?.getAttribute('aria-checked')).toBe('true');
    expect(yearly?.tabIndex).toBe(0);
    expect(byId(container, 'yearly-saving').textContent).toBe('Save 20%');
  });

  it('moves and chooses with the arrow keys, wrapping at both ends, and moves the focus', async () => {
    const { container } = await mountBilling(CHOOSING);
    const [monthly, yearly] = radios(container);
    if (monthly === undefined || yearly === undefined) {
      throw new Error('no radios');
    }
    yearly.focus();
    await press(yearly, 'ArrowRight');
    expect(monthly.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(monthly);
    expect(monthly.tabIndex).toBe(0);
    expect(yearly.tabIndex).toBe(-1);
    expect(byId(container, 'plan-pro').textContent).toContain('$199/ month');
    await press(monthly, 'ArrowLeft');
    expect(yearly.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(yearly);
    await press(yearly, 'ArrowDown');
    expect(monthly.getAttribute('aria-checked')).toBe('true');
    await press(monthly, 'ArrowUp');
    expect(yearly.getAttribute('aria-checked')).toBe('true');
    // Any other key leaves the choice alone.
    await press(yearly, 'Enter');
    await press(yearly, 'a');
    expect(yearly.getAttribute('aria-checked')).toBe('true');
  });
});

describe('the Billing tab with a plan chosen on the landing (D4)', () => {
  it('can check out: the card stands out, its button reads Continue to checkout and has the focus, nothing is called before the click', async () => {
    const { container, api, deps, onIntentDone } = await mountBilling(ON_FREE, {
      intent: { plan: 'growth', interval: 'month' },
    });
    expect(byId(container, 'plan-growth').getAttribute('data-chosen')).toBe('true');
    expect(container.querySelectorAll('[data-chosen]')).toHaveLength(1);
    const button = byId(container, 'upgrade-growth');
    expect(button.textContent).toBe('Continue to checkout');
    expect(document.activeElement).toBe(button);
    // The period chosen on the landing is the one shown.
    expect(radios(container)[0]?.getAttribute('aria-checked')).toBe('true');
    expect(byId(container, 'upgrade-pro').textContent).toBe('Upgrade');
    expect(api.checkout).not.toHaveBeenCalled();
    await click(button);
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('growth', 'month');
    expect(onIntentDone).toHaveBeenCalledTimes(1);
  });

  it('pending with no plan: the same, on the yearly price chosen', async () => {
    const { container } = await mountBilling(CHOOSING, {
      intent: { plan: 'scale', interval: 'year' },
    });
    const button = byId(container, 'upgrade-scale');
    expect(button.textContent).toBe('Continue to checkout');
    expect(document.activeElement).toBe(button);
    await choosePeriod(container, 'month');
    // Another period than the chosen one is a plain Upgrade.
    expect(button.textContent).toBe('Upgrade');
  });

  it('paying for another plan: the card stands out with its own action, focused', async () => {
    const { container, api } = await mountBilling(PAYING, {
      intent: { plan: 'pro', interval: 'year' },
    });
    expect(byId(container, 'plan-pro').getAttribute('data-chosen')).toBe('true');
    expect(document.activeElement).toBe(byId(container, 'change-pro'));
    expect(byId(container, 'change-pro').textContent).toBe('Upgrade');
    expect(container.textContent).not.toContain('You are already on');
    expect(api.billingPortal).not.toHaveBeenCalled();
  });

  it('paying for the same plan and period: says so, offers nothing, calls nothing', async () => {
    const { container, api } = await mountBilling(PAYING, {
      intent: { plan: 'growth', interval: 'year' },
    });
    expect(container.textContent).toContain('You are already on Growth, billed yearly.');
    expect(actions(container).growth).toBe('Current plan');
    expect(api.checkout).not.toHaveBeenCalled();
    expect(api.billingPortal).not.toHaveBeenCalled();
  });

  it('paying for the same plan, the other period: a switch, and no already-on line', async () => {
    const { container } = await mountBilling(PAYING, {
      intent: { plan: 'growth', interval: 'month' },
    });
    expect(container.textContent).not.toContain('You are already on');
    expect(byId(container, 'change-growth').textContent).toBe('Switch to monthly');
  });

  it('managed by us: the card stands out, read only', async () => {
    const { container } = await mountBilling(
      storeView({ billing: { ...GROWTH_YEARLY, operatorManaged: true } }),
      { intent: { plan: 'pro', interval: 'year' } },
    );
    expect(byId(container, 'plan-pro').getAttribute('data-chosen')).toBe('true');
    expect(cardButtons(container)).toEqual([]);
    expect(byId(container, 'plans').textContent).toContain(OPERATOR_TEXT);
  });

  it('a portal flow opened from Manage billing also acts on the chosen plan', async () => {
    const { container, deps, onIntentDone } = await mountBilling(
      storeView({ billing: { ...GROWTH_YEARLY, status: 'past_due' } }),
      { intent: { plan: 'pro', interval: 'year' } },
    );
    await click(byId(container, 'manage-billing'));
    await settle(() => vi.mocked(deps.openUrl).mock.calls.length > 0);
    expect(onIntentDone).toHaveBeenCalledTimes(1);
  });
});

function radios(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}
