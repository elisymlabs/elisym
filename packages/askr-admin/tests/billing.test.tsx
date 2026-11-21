import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingReturnNotice } from '../src/components/BillingReturnNotice';
import { BillingStatus } from '../src/components/BillingStatus';
import { Overview } from '../src/components/Overview';
import { ApiError } from '../src/lib/api';
import {
  ACTIVATION_POLL_LIMIT,
  ACTIVATION_POLL_MS,
  billingLine,
  takeBillingReturn,
} from '../src/lib/billing';
import type { BillingView, StoreView } from '../src/lib/types';
import {
  BILLING_OFF,
  BILLING_ON,
  FREE_TIER,
  adminConfig,
  fakeApi,
  overviewProps,
  storeView,
} from './fakes';
import { type Mounted, byId, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 2026-12-25T00:00:00Z */
const PERIOD_END = 1_798_156_800;

const LIVE: BillingView = {
  enabled: true,
  plan: 'growth',
  interval: 'year',
  status: 'active',
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  manageable: true,
  checkoutAvailable: false,
  operatorManaged: false,
};

async function mountOverview(view: StoreView, api = fakeApi()) {
  const props = overviewProps(api);
  mounted = await mount(
    <Overview {...props} view={view} config={adminConfig()} configFromServer={false} />,
  );
  return { container: mounted.container, api, openUrl: props.deps.openUrl };
}

describe('the return from Checkout', () => {
  it('reads the billing flag once and removes it from the address, keeping the rest', () => {
    const replaceState = vi.fn();
    expect(
      takeBillingReturn(
        { href: 'https://app.askr.test/admin/?billing=success&tab=x#top' },
        { replaceState, state: { kept: true } },
      ),
    ).toBe('success');
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, '', '/admin/?tab=x#top');
    expect(
      takeBillingReturn({ href: 'https://app.askr.test/admin/?billing=canceled' }, undefined),
    ).toBe('canceled');
    expect(
      takeBillingReturn(
        { href: 'https://app.askr.test/admin/?billing=paid' },
        { replaceState, state: null },
      ),
    ).toBeUndefined();
    expect(takeBillingReturn({ href: 'https://app.askr.test/admin/' }, undefined)).toBeUndefined();
    expect(takeBillingReturn(undefined, undefined)).toBeUndefined();
  });

  it('says activating and reads the store again until the plan is live, then that it is active', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const pending = storeView({ status: 'pending', tier: null, billing: BILLING_ON });
    mounted = await mount(<BillingReturnNotice flag="success" view={pending} refresh={refresh} />);
    expect(mounted.container.textContent).toBe('Payment received, activating...');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await mounted.rerender(
      <BillingReturnNotice
        flag="success"
        view={storeView({ status: 'active', billing: LIVE })}
        refresh={refresh}
      />,
    );
    expect(mounted.container.textContent).toBe('Payment received. Your plan is active.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_MS * 3);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops after its limit and says it takes longer', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    mounted = await mount(
      <BillingReturnNotice
        flag="success"
        view={storeView({ status: 'pending', tier: null, billing: BILLING_ON })}
        refresh={refresh}
      />,
    );
    for (let read = 0; read < ACTIVATION_POLL_LIMIT + 2; read += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_MS);
      });
    }
    expect(refresh).toHaveBeenCalledTimes(ACTIVATION_POLL_LIMIT);
    expect(mounted.container.textContent).toContain('taking longer than usual');
  });

  it('says nothing was charged after a cancel, and reads nothing', async () => {
    const refresh = vi.fn(async () => undefined);
    mounted = await mount(
      <BillingReturnNotice flag="canceled" view={storeView()} refresh={refresh} />,
    );
    expect(mounted.container.textContent).toBe('Checkout was canceled. Nothing was charged.');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the plan picker with billing on', () => {
  it('gives each paid plan an Upgrade that opens its checkout, monthly or yearly', async () => {
    const { container, api, openUrl } = await mountOverview(
      storeView({ status: 'pending', tier: null, billing: BILLING_ON }),
    );
    const picker = byId(container, 'plan-picker');
    expect(byId(picker, 'start-free').textContent).toBe('Start on Free');
    for (const plan of ['starter', 'growth', 'pro', 'scale']) {
      expect(byId(picker, `upgrade-${plan}`).textContent).toBe('Upgrade');
    }
    expect(picker.textContent).toContain('Starter$29 a month');
    expect(picker.textContent).toContain('For Enterprise, message us with your Store ID.');
    expect(picker.textContent).not.toContain('For a paid plan, message us');
    await click(byId(picker, 'interval-year'));
    expect(picker.textContent).toContain('Pro$159 a month, $1,908 billed yearly');
    await click(byId(picker, 'upgrade-pro'));
    await settle(() => vi.mocked(openUrl).mock.calls.length > 0);
    expect(api.checkout).toHaveBeenCalledWith('pro', 'year');
    expect(openUrl).toHaveBeenCalledWith('https://checkout.stripe.test/c/1');
    // Busy until the page leaves: a second press opens no second checkout.
    expect(byId(picker, 'upgrade-starter')).toHaveProperty('disabled', true);
  });

  it('says why a checkout was refused, and lets the owner try again', async () => {
    const api = fakeApi({
      checkout: vi.fn(async () => Promise.reject(new ApiError(503, 'billing_unavailable'))),
    });
    const { container, openUrl } = await mountOverview(
      storeView({ status: 'pending', tier: null, billing: BILLING_ON }),
      api,
    );
    await click(byId(container, 'upgrade-starter'));
    await settle(() => (container.textContent ?? '').includes('Paying here is not available'));
    expect(openUrl).not.toHaveBeenCalled();
    expect(byId(container, 'upgrade-starter')).toHaveProperty('disabled', false);
  });

  it('keeps the message-us path while billing is off', async () => {
    const { container } = await mountOverview(
      storeView({ status: 'pending', tier: null, billing: BILLING_OFF }),
    );
    expect(container.querySelector('#paid-plans')).toBeNull();
    expect(container.textContent).toContain('For a paid plan, message us with your Store ID');
  });
});

describe('billing in Overview', () => {
  it('offers an active Free store the paid plans', async () => {
    const { container, api } = await mountOverview(
      storeView({ tier: { ...FREE_TIER }, billing: BILLING_ON }),
    );
    const upgrade = byId(container, 'upgrade');
    expect(upgrade.textContent).toContain('Move to a paid plan');
    await click(byId(upgrade, 'upgrade-growth'));
    expect(api.checkout).toHaveBeenCalledWith('growth', 'month');
    expect(container.querySelector('#manage-billing')).toBeNull();
  });

  it('shows when a paid plan renews and opens the portal from Manage billing', async () => {
    const { container, api, openUrl } = await mountOverview(
      storeView({ tier: { ...FREE_TIER, name: 'growth' }, billing: LIVE }),
    );
    expect(byId(container, 'billing-status').textContent).toContain(
      'Your Growth plan is billed yearly and renews on December 25, 2026.',
    );
    expect(byId(container, 'upgrade').textContent).toContain('use Manage billing under Status');
    expect(container.querySelector('#paid-plans')).toBeNull();
    await click(byId(container, 'manage-billing'));
    await settle(() => vi.mocked(openUrl).mock.calls.length > 0);
    expect(api.billingPortal).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://billing.stripe.test/p/1');
  });

  it('warns while a payment is retried, and says when a canceled plan ends', async () => {
    const { container } = await mountOverview(
      storeView({ billing: { ...LIVE, status: 'past_due' } }),
    );
    expect(
      byId(container, 'billing-status').querySelector('[role="status"]')?.textContent,
    ).toContain('failed and is being retried');
    expect(billingLine({ ...LIVE, cancelAtPeriodEnd: true })).toContain(
      'is canceled and ends on December 25, 2026',
    );
    expect(billingLine({ ...LIVE, status: 'canceled' })).toBe('Your Growth plan ended.');
    expect(billingLine({ ...LIVE, interval: 'month' })).toContain('billed monthly');
    expect(billingLine(BILLING_ON)).toBe('');
  });

  it('says a refused portal call', async () => {
    const api = fakeApi({
      billingPortal: vi.fn(async () => Promise.reject(new ApiError(502, 'billing_failed'))),
    });
    mounted = await mount(<BillingStatus deps={{ api, openUrl: vi.fn() }} billing={LIVE} />);
    await click(byId(mounted.container, 'manage-billing'));
    await settle(() => (mounted?.container.textContent ?? '').includes('Stripe did not answer'));
  });

  it('shows nothing for a store that never had billing', async () => {
    const { container } = await mountOverview(storeView({ billing: BILLING_ON }));
    expect(container.querySelector('#billing-status')).toBeNull();
  });
});
