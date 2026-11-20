import { afterEach, describe, expect, it } from 'vitest';
import { Overview } from '../src/components/Overview';
import { CONTACT_URL, FIND_STORE_ID_URL } from '../src/constants';
import {
  PENDING_CONTACT_TEXT,
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
import { OWNER, storeView } from './fakes';
import { type Mounted, mount } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '');
}

describe('the activation wording (6.4)', () => {
  it('a pending store is waiting: save again or message us, with the contact and Store ID links', async () => {
    mounted = await mount(
      <Overview
        view={storeView({ status: 'pending', tier: null })}
        config={undefined}
        configFromServer={false}
      />,
    );
    const text = mounted.container.textContent ?? '';
    expect(text).toContain(PENDING_TEXT);
    expect(text).not.toContain('operator');
    expect(text).not.toContain(UPGRADE_TEXT);
    expect(hrefs(mounted.container)).toEqual(
      expect.arrayContaining([CONTACT_URL, FIND_STORE_ID_URL]),
    );
    expect(mounted.container.querySelector('.contact-link')?.parentElement?.textContent).toContain(
      npubOf(OWNER),
    );
    expect(mounted.container.querySelector('#upgrade')).toBeNull();
  });

  it('an active store names its plan, how to move to a larger one, and its Store ID', async () => {
    mounted = await mount(
      <Overview view={storeView()} config={undefined} configFromServer={false} />,
    );
    const upgrade = mounted.container.querySelector('#upgrade');
    expect(mounted.container.textContent).toContain('Plan: base');
    expect(mounted.container.textContent).not.toContain(PENDING_TEXT);
    expect(upgrade?.textContent).toContain(UPGRADE_TEXT);
    expect(upgrade?.textContent).toContain(npubOf(OWNER));
    expect(upgrade?.querySelector('a')?.getAttribute('href')).toBe(CONTACT_URL);
  });

  it('a store the operator set back to pending is told to message us, not to save again', async () => {
    const demoted = storeView({ status: 'pending' });
    mounted = await mount(<Overview view={demoted} config={undefined} configFromServer />);
    expect(mounted.container.textContent).toContain(PENDING_CONTACT_TEXT);
    expect(mounted.container.textContent).not.toContain('Save your settings again');
    expect(mounted.container.querySelector('.contact-link')?.getAttribute('href')).toBe(
      CONTACT_URL,
    );
    expect(pendingTextOf(demoted)).toBe(PENDING_CONTACT_TEXT);
    expect(pendingTextOf(storeView({ status: 'pending', tier: null }))).toBe(PENDING_TEXT);
  });

  it('a suspended store shows no upgrade line', async () => {
    mounted = await mount(
      <Overview view={storeView({ status: 'suspended' })} config={undefined} configFromServer />,
    );
    expect(mounted.container.querySelector('#upgrade')).toBeNull();
    expect(mounted.container.textContent).not.toContain(PENDING_TEXT);
  });

  it('says the same in the saved message, the inactive error and the help, with no operator', () => {
    expect(savedMessage({ status: 'pending', tier: null })).toBe(`Saved. ${PENDING_TEXT}`);
    expect(savedMessage({ status: 'pending', tier: null, activation: 'capacity_reached' })).toBe(
      `Saved. ${PENDING_TEXT}`,
    );
    expect(savedMessage({ status: 'pending', tier: storeView().tier })).toBe(
      `Saved. ${PENDING_CONTACT_TEXT}`,
    );
    for (const activation of ['disabled', 'no_tier'] as const) {
      expect(savedMessage({ status: 'pending', tier: null, activation })).toBe(
        `Saved. ${PENDING_CONTACT_TEXT}`,
      );
    }
    const inactive = errorMessage(new ApiError(409, 'inactive'));
    expect(inactive).toContain('Save your settings again to retry');
    expect(inactive).not.toContain('operator');
    expect(HELP.status.text).toContain('save your settings again to retry');
    expect(HELP.waiting.text).not.toContain('activated');
  });

  it('points to the contact and the docs section the CLI and the landing link to', () => {
    expect(CONTACT_URL).toBe('https://askr.elisym.network/contact');
    expect(FIND_STORE_ID_URL).toBe('https://docs.elisym.network/askr/overview#find-your-store-id');
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
