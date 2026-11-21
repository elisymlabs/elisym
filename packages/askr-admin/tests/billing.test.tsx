import { StrictMode, act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingReturnNotice } from '../src/components/BillingReturnNotice';
import { BillingStatus } from '../src/components/BillingStatus';
import { Session } from '../src/components/Session';
import { ApiError } from '../src/lib/api';
import {
  ACTIVATION_POLL_LIMIT,
  ACTIVATION_POLL_MS,
  ACTIVE_ONBOARDING_TEXT,
  ACTIVE_TEXT,
  UPDATED_TEXT,
  billingLine,
  takeBillingReturn,
} from '../src/lib/billing';
import type { BillingReturn } from '../src/lib/billing';
import type { BillingView } from '../src/lib/types';
import {
  BILLING_ON,
  FREE_TIER,
  OWNER_KEY,
  fakeApi,
  fakeReader,
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
      takeBillingReturn({ href: 'https://app.askr.test/admin/?billing=updated' }, undefined),
    ).toBe('updated');
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

describe('the return from the billing portal (D8)', () => {
  it('reads the store once and says the change may take a minute to show', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    mounted = await mount(
      <BillingReturnNotice flag="updated" view={storeView({ billing: LIVE })} refresh={refresh} />,
    );
    expect(mounted.container.textContent).toBe(UPDATED_TEXT);
    expect(UPDATED_TEXT).toBe(
      'Your plan change is saved. It can take a minute to show here; refresh the page to see it.',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    // No poll: a read once, whatever the view says after it.
    await mounted.rerender(
      <BillingReturnNotice
        flag="updated"
        view={storeView({ billing: BILLING_ON })}
        refresh={refresh}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_MS * 5);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).toBe(UPDATED_TEXT);
  });

  it('reads once under StrictMode too', async () => {
    const refresh = vi.fn(async () => undefined);
    mounted = await mount(
      <StrictMode>
        <BillingReturnNotice flag="updated" view={storeView({ billing: LIVE })} refresh={refresh} />
      </StrictMode>,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a checkout return reads nothing at once', async () => {
    const refresh = vi.fn(async () => undefined);
    mounted = await mount(
      <BillingReturnNotice flag="success" view={storeView({ billing: LIVE })} refresh={refresh} />,
    );
    expect(mounted.container.textContent).toBe(ACTIVE_TEXT);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the return notice in the session (D5)', () => {
  function sessionWith(
    flag: BillingReturn,
    store: () => Promise<ReturnType<typeof storeView>>,
    relay = fakeReader([]),
  ) {
    const api = fakeApi({ store: vi.fn(store) });
    const deps = { ...sessionDeps(api, relay), takeBillingReturn: () => flag };
    return { api, deps };
  }

  it('a store paid for before its settings sees the activation above Onboarding, then what is left', async () => {
    let view = storeView({ status: 'pending', tier: null, billing: BILLING_ON });
    const { deps } = sessionWith('success', async () => view);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Set up your assistant'));
    expect(container.textContent).toContain('Payment received, activating...');
    // Stripe's event made the plan live: the store is active, its settings still to write.
    view = storeView({ billing: LIVE, tier: { ...FREE_TIER, name: 'growth' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_MS);
    });
    await settle(() => (container.textContent ?? '').includes(ACTIVE_ONBOARDING_TEXT));
    expect(ACTIVE_ONBOARDING_TEXT).toBe('Your plan is active: describe your store to finish.');
    expect(container.textContent).toContain('2. Describe your store');
    expect(container.textContent).not.toContain(ACTIVE_TEXT);
  });

  it('a portal return reads the store once more and says so on the dashboard', async () => {
    const { api, deps } = sessionWith(
      'updated',
      async () => storeView({ billing: LIVE }),
      fakeReader([signedConfig(OWNER_KEY, 'Tea Shop', 1_799_999_000)]),
    );
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes(UPDATED_TEXT));
    await settle(() => vi.mocked(api.store).mock.calls.length === 2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The first read, then the notice's one.
    expect(api.store).toHaveBeenCalledTimes(2);
  });

  it('says nothing without a flag', async () => {
    const { deps } = sessionWith('canceled', async () =>
      storeView({ status: 'pending', tier: null }),
    );
    mounted = await mount(
      <Session
        deps={{ ...deps, takeBillingReturn: () => undefined }}
        onSignOut={() => undefined}
        onReplaceKey={() => undefined}
      />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Set up your assistant'));
    expect(container.textContent).not.toMatch(/Payment received|Checkout was canceled/u);
  });

  it('shows a canceled checkout above Onboarding too', async () => {
    const { deps } = sessionWith('canceled', async () =>
      storeView({ status: 'pending', tier: null }),
    );
    mounted = await mount(
      <Session deps={deps} onSignOut={() => undefined} onReplaceKey={() => undefined} />,
    );
    const { container } = mounted;
    await settle(() => (container.textContent ?? '').includes('Set up your assistant'));
    expect(container.textContent).toContain('Checkout was canceled. Nothing was charged.');
  });
});

describe('the billing line', () => {
  it('says a scheduled change, ours or not, and ignores one an older server does not send', () => {
    expect(
      billingLine({
        ...LIVE,
        scheduledChange: { plan: 'starter', interval: 'month', at: PERIOD_END },
      }),
    ).toBe(
      'Your Growth plan is billed yearly and changes to Starter, billed monthly, on December 25, 2026.',
    );
    expect(
      billingLine({ ...LIVE, scheduledChange: { plan: null, interval: 'month', at: PERIOD_END } }),
    ).toBe('Your Growth plan is billed yearly and changes to another plan on December 25, 2026.');
    expect(billingLine({ ...LIVE, scheduledChange: null })).toBe(
      'Your Growth plan is billed yearly and renews on December 25, 2026.',
    );
    expect(billingLine(LIVE)).toBe(
      'Your Growth plan is billed yearly and renews on December 25, 2026.',
    );
  });

  it('says a refused portal call', async () => {
    const api = fakeApi({
      billingPortal: vi.fn(async () => Promise.reject(new ApiError(502, 'billing_failed'))),
    });
    mounted = await mount(<BillingStatus deps={{ api, openUrl: vi.fn() }} billing={LIVE} />);
    await click(byId(mounted.container, 'manage-billing'));
    await settle(() => (mounted?.container.textContent ?? '').includes('Stripe did not answer'));
  });
});
