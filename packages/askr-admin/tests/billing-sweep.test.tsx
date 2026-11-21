import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingReturnNotice } from '../src/components/BillingReturnNotice';
import { BillingStatus } from '../src/components/BillingStatus';
import { Overview } from '../src/components/Overview';
import { PaidPlans } from '../src/components/PaidPlans';
import { Session } from '../src/components/Session';
import { MANAGE_TEXT, UPGRADE_TEXT } from '../src/lib/activation';
import { AdminApi, ApiError } from '../src/lib/api';
import {
  ACTIVATION_POLL_LIMIT,
  ACTIVATION_POLL_MS,
  billingLine,
  dateOf,
  takeBillingReturn,
} from '../src/lib/billing';
import { createSessionDeps } from '../src/lib/deps';
import { errorMessage } from '../src/lib/errors';
import { HELP } from '../src/lib/help';
import { secretKeySigner } from '../src/lib/signer';
import type { BillingView, StoreView } from '../src/lib/types';
import {
  BILLING_OFF,
  BILLING_ON,
  FREE_TIER,
  OWNER_KEY,
  adminConfig,
  fakeApi,
  fakeReader,
  overviewProps,
  sessionDeps,
  signedConfig,
  storeView,
} from './fakes';
import { type Mounted, byId, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

function upgradeText(container: HTMLElement): string {
  return byId(container, 'upgrade').textContent ?? '';
}

describe('how an active store moves to another plan', () => {
  it('a live paid plan (past due and trialing too) is changed under Manage billing, nothing to buy', async () => {
    for (const status of ['active', 'past_due', 'trialing']) {
      const { container } = await mountOverview(storeView({ billing: { ...LIVE, status } }));
      expect(upgradeText(container), status).toContain(MANAGE_TEXT);
      expect(container.querySelector('#paid-plans'), status).toBeNull();
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('goes through us while billing is off, after a plan ended, or for a plan we manage', async () => {
    for (const billing of [
      { ...LIVE, enabled: false },
      { ...LIVE, status: 'canceled' },
      { ...LIVE, operatorManaged: true },
    ]) {
      const { container } = await mountOverview(storeView({ billing }));
      expect(upgradeText(container)).toContain(UPGRADE_TEXT);
      expect(upgradeText(container)).not.toContain(MANAGE_TEXT);
      await mounted?.unmount();
      mounted = undefined;
    }
  });
});

describe('the plan picker with billing on', () => {
  it('shows the paid plans only as Upgrade cards, never the static ones beside them', async () => {
    const { container } = await mountOverview(
      storeView({ status: 'pending', tier: null, billing: BILLING_ON }),
    );
    const names = [...byId(container, 'plan-picker').querySelectorAll('p')].map(
      (node) => node.textContent,
    );
    expect(names.filter((name) => name === 'Starter')).toHaveLength(1);
    expect(names).not.toContain('Growth / Pro / Scale');
  });

  it('says the prices include tax', async () => {
    mounted = await mount(<PaidPlans deps={{ api: fakeApi(), openUrl: vi.fn() }} />);
    expect(mounted.container.textContent).toContain('Prices in USD, tax included.');
    expect(mounted.container.textContent).not.toContain('added');
  });

  it('marks the chosen billing period as pressed', async () => {
    mounted = await mount(<PaidPlans deps={{ api: fakeApi(), openUrl: vi.fn() }} />);
    const { container } = mounted;
    expect(byId(container, 'interval-month').getAttribute('aria-pressed')).toBe('true');
    expect(byId(container, 'interval-year').getAttribute('aria-pressed')).toBe('false');
    await click(byId(container, 'interval-year'));
    expect(byId(container, 'interval-month').getAttribute('aria-pressed')).toBe('false');
    expect(byId(container, 'interval-year').getAttribute('aria-pressed')).toBe('true');
  });

  it('works again when the page comes back from the browser cache', async () => {
    const openUrl = vi.fn();
    mounted = await mount(<PaidPlans deps={{ api: fakeApi(), openUrl }} />);
    const { container } = mounted;
    await click(byId(container, 'upgrade-pro'));
    await settle(() => openUrl.mock.calls.length > 0);
    expect(byId(container, 'upgrade-pro')).toHaveProperty('disabled', true);
    await act(async () => {
      globalThis.dispatchEvent(new Event('pageshow'));
    });
    expect(byId(container, 'upgrade-pro')).toHaveProperty('disabled', false);
  });
});

describe('Manage billing', () => {
  it('shows only while billing is on and the store has a customer, even with nothing to say', async () => {
    const cases: Array<[BillingView, boolean]> = [
      [{ ...LIVE, enabled: false }, false],
      [{ ...LIVE, manageable: false }, false],
      [{ ...BILLING_ON, manageable: true }, true],
    ];
    for (const [billing, shown] of cases) {
      mounted = await mount(
        <BillingStatus deps={{ api: fakeApi(), openUrl: vi.fn() }} billing={billing} />,
      );
      expect(mounted.container.querySelector('#manage-billing') !== null).toBe(shown);
      await mounted.unmount();
      mounted = undefined;
    }
  });

  it('opens the portal once on a double click, and works again after a refusal or a return', async () => {
    let answer: (value: { url: string }) => void = () => undefined;
    const api = fakeApi({
      billingPortal: vi.fn(
        () =>
          new Promise<{ url: string }>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const openUrl = vi.fn();
    mounted = await mount(<BillingStatus deps={{ api, openUrl }} billing={LIVE} />);
    const button = byId(mounted.container, 'manage-billing');
    await click(button);
    await click(button);
    expect(api.billingPortal).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ url: 'https://billing.stripe.test/p/1' });
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(button).toHaveProperty('disabled', true);
    await act(async () => {
      globalThis.dispatchEvent(new Event('pageshow'));
    });
    expect(button).toHaveProperty('disabled', false);

    vi.mocked(api.billingPortal).mockImplementation(async () =>
      Promise.reject(new ApiError(502, 'billing_failed')),
    );
    await click(button);
    await settle(() => (mounted?.container.textContent ?? '').includes('Stripe did not answer'));
    expect(button).toHaveProperty('disabled', false);
  });
});

describe('the billing line', () => {
  it('says a canceled plan ended, an incomplete one is not complete, in UTC dates', () => {
    expect(billingLine({ ...LIVE, status: 'canceled', cancelAtPeriodEnd: true })).toBe(
      'Your Growth plan ended.',
    );
    expect(billingLine({ ...LIVE, status: 'incomplete' })).toBe(
      'The first payment for your Growth plan is not complete yet.',
    );
  });

  it('writes the UTC date wherever the browser is', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    // 23:50 UTC on 31 December: already 1 January in Tokyo.
    expect(dateOf(Date.UTC(2026, 11, 31, 23, 50) / 1000)).toBe('December 31, 2026');
  });
});

describe('the return from Checkout', () => {
  it('polls every 3 seconds for at most 2 minutes', () => {
    expect(ACTIVATION_POLL_MS).toBe(3_000);
    expect(ACTIVATION_POLL_LIMIT * ACTIVATION_POLL_MS).toBe(120_000);
  });

  it('leaves the address alone when it carries no flag', () => {
    const replaceState = vi.fn();
    expect(
      takeBillingReturn(
        { href: 'https://app.askr.test/admin/?tab=x' },
        { replaceState, state: null },
      ),
    ).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('waits for both a live plan and an active store', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    // Upgrading from Free: active, but the paid plan is not live yet.
    mounted = await mount(
      <BillingReturnNotice
        flag="success"
        view={storeView({ tier: { ...FREE_TIER }, billing: BILLING_ON })}
        refresh={refresh}
      />,
    );
    expect(mounted.container.textContent).toBe('Payment received, activating...');
    // Paid, but the store is not served yet.
    await mounted.rerender(
      <BillingReturnNotice
        flag="success"
        view={storeView({ status: 'pending', tier: null, billing: LIVE })}
        refresh={refresh}
      />,
    );
    expect(mounted.container.textContent).toBe('Payment received, activating...');
  });

  it('never reads the store again after a cancel', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    mounted = await mount(
      <BillingReturnNotice
        flag="canceled"
        view={storeView({ status: 'pending', tier: null, billing: BILLING_ON })}
        refresh={refresh}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('is shown by the signed-in admin', async () => {
    const api = fakeApi({ store: vi.fn(async () => storeView({ billing: BILLING_OFF })) });
    const deps = {
      ...sessionDeps(api, fakeReader([signedConfig(OWNER_KEY, 'Tea Shop', 1_799_999_000)])),
      takeBillingReturn: () => 'canceled' as const,
    };
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    await settle(() => (mounted?.container.textContent ?? '').includes('Nothing was charged'));
  });
});

describe('the session deps', () => {
  it('read the flag only when asked, once, and leave the page through location.assign', () => {
    const assign = vi.fn();
    const replaceState = vi.fn();
    vi.stubGlobal('location', { href: 'https://app.askr.test/admin/?billing=success', assign });
    vi.stubGlobal('history', { replaceState, state: null });
    // A key recovery on the sign-in page makes deps too: it must not use the flag up.
    createSessionDeps(secretKeySigner(OWNER_KEY));
    expect(replaceState).not.toHaveBeenCalled();
    const deps = createSessionDeps(secretKeySigner(OWNER_KEY));
    expect(deps.takeBillingReturn()).toBe('success');
    expect(deps.takeBillingReturn()).toBe('success');
    expect(replaceState).toHaveBeenCalledTimes(1);
    deps.openUrl('https://checkout.stripe.test/c/1');
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/c/1');
  });
});

describe('the API calls', () => {
  it('posts the plan and interval to checkout, nothing to the portal', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const api = new AdminApi({
      signer: secretKeySigner(OWNER_KEY),
      base: 'https://app.askr.test',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return new Response(JSON.stringify({ url: 'https://stripe.test' }), { status: 200 });
      },
    });
    expect(await api.checkout('pro', 'year')).toEqual({ url: 'https://stripe.test' });
    await api.billingPortal();
    expect(calls).toEqual([
      {
        url: 'https://app.askr.test/v1/admin/billing/checkout',
        method: 'POST',
        body: { plan: 'pro', interval: 'year' },
      },
      { url: 'https://app.askr.test/v1/admin/billing/portal', method: 'POST', body: undefined },
    ]);
  });

  it('says what each billing refusal means', () => {
    const said = (code: string) => errorMessage(new ApiError(409, code));
    expect(said('subscription_exists')).toBe(
      'Your store already has a paid plan: change it under Manage billing.',
    );
    expect(said('plan_unavailable')).toBe(
      'Paying here is not available right now. Message us with your Store ID.',
    );
    expect(said('no_customer')).toBe('There is no billing to manage yet.');
    expect(said('suspended')).toBe('Your store is suspended. Message us with your Store ID.');
  });
});

describe('the help texts', () => {
  it('name no Upgrade or checkout, which billing off does not offer', () => {
    for (const help of [HELP.status, HELP.planPicker]) {
      expect(help.text).not.toMatch(/upgrade|checkout/iu);
    }
  });
});
