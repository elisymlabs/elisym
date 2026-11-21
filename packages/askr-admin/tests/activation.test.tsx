import { afterEach, describe, expect, it } from 'vitest';
import { Overview } from '../src/components/Overview';
import { CONTACT_URL } from '../src/constants';
import {
  PENDING_CONTACT_TEXT,
  PENDING_OVERVIEW_TEXT,
  PENDING_TEXT,
  UPGRADE_TEXT,
  pendingTextOf,
} from '../src/lib/activation';
import { ApiError } from '../src/lib/api';
import { connectorResultSentence } from '../src/lib/connector';
import { errorMessage } from '../src/lib/errors';
import { HELP } from '../src/lib/help';
import { planSummaryOf } from '../src/lib/plan-actions';
import { savedMessage } from '../src/lib/save';
import { npubOf } from '../src/lib/signer';
import { BILLING_ON, FREE_TIER, OWNER, overviewProps, storeView } from './fakes';
import { type Mounted, byId, click, mount } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the plan wording (6.5)', () => {
  it('a pending store with no plan is told to choose one, with a button that opens Billing, and no picker of its own', async () => {
    const props = overviewProps();
    mounted = await mount(
      <Overview
        {...props}
        view={storeView({ status: 'pending', tier: null })}
        config={undefined}
        configFromServer={false}
      />,
    );
    const text = mounted.container.textContent ?? '';
    expect(text).toContain(PENDING_OVERVIEW_TEXT);
    expect(text).not.toContain(PENDING_TEXT);
    expect(text).not.toContain('operator');
    expect(text).not.toContain(UPGRADE_TEXT);
    expect(text).toContain('No plan yet: choose one in Billing.');
    expect(mounted.container.querySelector('#plan-summary')?.textContent).toBe('No plan yet.');
    expect(mounted.container.querySelector('#plans')).toBeNull();
    expect(mounted.container.querySelector('#start-free')).toBeNull();
    expect(mounted.container.querySelectorAll('.contact-link')).toHaveLength(0);
    const open = byId(mounted.container, 'open-billing');
    expect(open.textContent).toBe('Choose a plan');
    await click(open);
    expect(props.onOpenBilling).toHaveBeenCalledTimes(1);
  });

  it('an active store names its plan in one line, with the way to Billing', async () => {
    const props = overviewProps();
    mounted = await mount(
      <Overview {...props} view={storeView()} config={undefined} configFromServer={false} />,
    );
    expect(mounted.container.textContent).toContain('Plan: base');
    expect(mounted.container.textContent).not.toContain(PENDING_TEXT);
    expect(byId(mounted.container, 'plan-summary').textContent).toBe('Your plan: base.');
    expect(mounted.container.querySelector('#upgrade')).toBeNull();
    expect(mounted.container.querySelector('#manage-billing')).toBeNull();
    const open = byId(mounted.container, 'open-billing');
    expect(open.textContent).toBe('Billing');
    await click(open);
    expect(props.onOpenBilling).toHaveBeenCalledTimes(1);
  });

  it('names a paid plan and its period, and Free, in the one line', async () => {
    const live = {
      ...BILLING_ON,
      checkoutAvailable: false,
      plan: 'growth' as const,
      interval: 'year' as const,
      status: 'active',
      manageable: true,
    };
    expect(planSummaryOf(storeView({ billing: live }))).toBe('Your plan: Growth, billed yearly.');
    expect(planSummaryOf(storeView({ billing: { ...live, interval: 'month' } }))).toBe(
      'Your plan: Growth, billed monthly.',
    );
    expect(planSummaryOf(storeView({ tier: { ...FREE_TIER } }))).toBe('Your plan: Free.');
    // A plan that ended is not named: the store's tier is.
    expect(planSummaryOf(storeView({ billing: { ...live, status: 'canceled' } }))).toBe(
      'Your plan: base.',
    );
  });

  it('a store the operator set back to pending is told to message us, with one contact line', async () => {
    const demoted = storeView({ status: 'pending' });
    mounted = await mount(
      <Overview {...overviewProps()} view={demoted} config={undefined} configFromServer />,
    );
    expect(mounted.container.textContent).toContain(PENDING_CONTACT_TEXT);
    expect(mounted.container.textContent).toContain('Plan: base');
    expect(mounted.container.textContent).not.toContain('Save your settings again');
    expect(byId(mounted.container, 'open-billing').textContent).toBe('Billing');
    expect(mounted.container.querySelectorAll('.contact-link')).toHaveLength(1);
    expect(mounted.container.querySelector('.contact-link')?.getAttribute('href')).toBe(
      CONTACT_URL,
    );
    expect(mounted.container.querySelector('.contact-link')?.parentElement?.textContent).toContain(
      npubOf(OWNER),
    );
    expect(pendingTextOf(demoted)).toBe(PENDING_CONTACT_TEXT);
    expect(pendingTextOf(demoted, 'overview')).toBe(PENDING_CONTACT_TEXT);
    expect(pendingTextOf(storeView({ status: 'pending', tier: null }))).toBe(PENDING_TEXT);
    expect(pendingTextOf(storeView({ status: 'pending', tier: null }), 'overview')).toBe(
      PENDING_OVERVIEW_TEXT,
    );
  });

  it('a suspended store shows no upgrade line and no picker', async () => {
    mounted = await mount(
      <Overview
        {...overviewProps()}
        view={storeView({ status: 'suspended' })}
        config={undefined}
        configFromServer
      />,
    );
    expect(mounted.container.querySelector('#upgrade')).toBeNull();
    expect(mounted.container.querySelector('#start-free')).toBeNull();
    expect(mounted.container.textContent).not.toContain(PENDING_TEXT);
  });

  it('says the same in the saved message, the inactive error and the help, with no operator', () => {
    expect(PENDING_TEXT).toBe('Your store has no plan yet. Choose one in Billing to go live.');
    expect(PENDING_OVERVIEW_TEXT).toBe('Your store has no plan yet. Choose one to go live.');
    expect(PENDING_CONTACT_TEXT).toBe(
      "We manage your store's plan. Message us with your Store ID to make it live.",
    );
    expect(savedMessage({ status: 'pending', tier: null })).toBe(
      'Saved. Choose a plan in Billing to go live.',
    );
    expect(savedMessage({ status: 'pending', tier: storeView().tier })).toBe(
      `Saved. ${PENDING_CONTACT_TEXT}`,
    );
    expect(savedMessage({ status: 'active', tier: storeView().tier })).toBe(
      'Saved. The new settings are published in a moment.',
    );
    const inactive = errorMessage(new ApiError(409, 'inactive'));
    expect(inactive).toBe(
      'Your store is not active yet: products, policies and the connector work once it is. If it has no plan yet, choose one in Billing; otherwise message us with your Store ID.',
    );
    expect(inactive).not.toContain('operator');
    expect(HELP.status.text).toContain(
      'Pending: not live yet; choose a plan in Billing (Free starts at once, a paid plan once it is paid for or set up with us), or message us if we manage your plan.',
    );
    expect(HELP.status.text.length).toBeLessThan(400);
    expect(HELP.planPicker.anchor).toBe('choose-a-plan');
    expect(HELP.waiting.text).not.toContain('activated');
  });

  it('points to the contact the CLI and the landing link to', () => {
    expect(CONTACT_URL).toBe('https://askr.elisym.network/contact');
  });
});

describe('a connector over the plan (6.1a)', () => {
  it('names the way to a larger plan, and only for that reason', () => {
    expect(
      connectorResultSentence({
        status: 'error',
        reason: 'too_many_products',
        count: 3,
        max: 2,
        message: "3 products, over the tier's 2",
      }),
    ).toBe("The sync failed: 3 products, over the tier's 2. Move to a larger plan: open Billing.");
    expect(connectorResultSentence({ status: 'error', message: 'The store is gone' })).toBe(
      'The sync failed: The store is gone.',
    );
  });
});
