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
import { savedMessage } from '../src/lib/save';
import { npubOf } from '../src/lib/signer';
import { OWNER, overviewProps, storeView } from './fakes';
import { type Mounted, mount } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '');
}

describe('the plan wording (6.5)', () => {
  it("a pending store with no plan is told to choose one below, with one contact line: the picker's", async () => {
    mounted = await mount(
      <Overview
        {...overviewProps()}
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
    expect(text).toContain('No plan yet: choose one under Status.');
    expect(mounted.container.querySelector('#plan-picker')).not.toBeNull();
    expect(mounted.container.querySelectorAll('.contact-link')).toHaveLength(1);
    expect(
      mounted.container.querySelector('#plan-picker .contact-link')?.parentElement?.textContent,
    ).toContain(npubOf(OWNER));
    expect(hrefs(mounted.container)).toContain(CONTACT_URL);
    expect(mounted.container.textContent).not.toContain('Where else to find it');
    expect(mounted.container.querySelector('#upgrade')).toBeNull();
  });

  it('an active store names its plan, how to move to a larger one, and its Store ID', async () => {
    mounted = await mount(
      <Overview
        {...overviewProps()}
        view={storeView()}
        config={undefined}
        configFromServer={false}
      />,
    );
    const upgrade = mounted.container.querySelector('#upgrade');
    expect(mounted.container.textContent).toContain('Plan: base');
    expect(mounted.container.textContent).not.toContain(PENDING_TEXT);
    expect(mounted.container.querySelector('#plan-picker')).toBeNull();
    expect(upgrade?.textContent).toContain(UPGRADE_TEXT);
    expect(upgrade?.textContent).toContain(npubOf(OWNER));
    expect(upgrade?.querySelector('a')?.getAttribute('href')).toBe(CONTACT_URL);
  });

  it('a store the operator set back to pending is told to message us, with no picker and one contact line', async () => {
    const demoted = storeView({ status: 'pending' });
    mounted = await mount(
      <Overview {...overviewProps()} view={demoted} config={undefined} configFromServer />,
    );
    expect(mounted.container.textContent).toContain(PENDING_CONTACT_TEXT);
    expect(mounted.container.textContent).toContain('Plan: base');
    expect(mounted.container.textContent).not.toContain('Save your settings again');
    expect(mounted.container.querySelector('#plan-picker')).toBeNull();
    expect(mounted.container.querySelectorAll('.contact-link')).toHaveLength(1);
    expect(mounted.container.querySelector('.contact-link')?.getAttribute('href')).toBe(
      CONTACT_URL,
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
    expect(mounted.container.querySelector('#plan-picker')).toBeNull();
    expect(mounted.container.textContent).not.toContain(PENDING_TEXT);
  });

  it('says the same in the saved message, the inactive error and the help, with no operator', () => {
    expect(PENDING_TEXT).toBe('Your store has no plan yet. Choose one in Overview to go live.');
    expect(PENDING_OVERVIEW_TEXT).toBe('Your store has no plan yet. Choose one below to go live.');
    expect(PENDING_CONTACT_TEXT).toBe(
      "We manage your store's plan. Message us with your Store ID to make it live.",
    );
    expect(savedMessage({ status: 'pending', tier: null })).toBe(
      'Saved. Choose a plan in Overview to go live.',
    );
    expect(savedMessage({ status: 'pending', tier: storeView().tier })).toBe(
      `Saved. ${PENDING_CONTACT_TEXT}`,
    );
    expect(savedMessage({ status: 'active', tier: storeView().tier })).toBe(
      'Saved. The new settings are published in a moment.',
    );
    const inactive = errorMessage(new ApiError(409, 'inactive'));
    expect(inactive).toBe(
      'Your store is not active yet: products, policies and the connector work once it is. If it has no plan yet, choose one in Overview; otherwise message us with your Store ID.',
    );
    expect(inactive).not.toContain('operator');
    expect(HELP.status.text).toContain(
      'Pending: not live yet; choose a plan in Overview (Free starts at once, a paid plan once it is paid for or set up with us), or message us if we manage your plan.',
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
    ).toBe(
      "The sync failed: 3 products, over the tier's 2. Move to a larger plan: message us with your Store ID.",
    );
    expect(connectorResultSentence({ status: 'error', message: 'The store is gone' })).toBe(
      'The sync failed: The store is gone.',
    );
  });
});
