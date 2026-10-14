import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardHeader } from '../src/components/DashboardHeader';
import { SignIn } from '../src/components/SignIn';
import { LOCAL_ADMIN_COMMAND, PAGE_FRAME } from '../src/constants';
import { type Mounted, byId, mount } from './mount';

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function classesOf(element: Element | null): string[] {
  return (element?.getAttribute('class') ?? '').split(/\s+/);
}

describe('the sign-in page', () => {
  it('says what the page is, that the wallet stays the merchant’s, and what the key can do', async () => {
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const text = mounted.container.textContent ?? '';
    expect(text).not.toContain('Before you paste');
    expect(text).toContain('A view of your store');
    expect(text).toContain('Your wallet stays yours');
    expect(text).toContain('Buyers pay straight into your wallet.');
    expect(text).toContain('Nobody, neither elisym nor this page, can reach your wallet');
    expect(text).toContain(
      'Pay Core never asks for a wallet’s secret key or seed phrase, so never paste one, here or anywhere else.',
    );
    expect(text).toContain('Keep the store key like a password');
    expect(text).toContain('including the payout address new buyers pay to');
  });

  it('folds the security details until asked, with every note inside', async () => {
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const details = byId(mounted.container, 'security-details');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    if (!(details instanceof HTMLDetailsElement)) {
      return;
    }
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary');
    expect(summary?.textContent).toBe('Security details');
    const notes = details.querySelector('ul')?.textContent ?? '';
    expect(notes).toContain('The key stays in this tab’s memory only: never stored, never sent.');
    expect(notes).toContain('Browser extensions can read what you type into any page.');
    expect(notes).toContain(LOCAL_ADMIN_COMMAND);
    expect(notes).toContain('This page’s code is served by elisym on each visit');
    // The notes live only in the fold, not again outside it.
    const outside = (mounted.container.textContent ?? '').replace(details.textContent ?? '', '');
    expect(outside).not.toContain('Browser extensions');
    await act(async () => {
      summary?.click();
    });
    expect(details.open).toBe(true);
  });
});

describe('the page frame', () => {
  it('holds the sign-in header and the dashboard header', async () => {
    const tokens = PAGE_FRAME.split(' ');
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const header = classesOf(mounted.container.querySelector('header'));
    expect(header).toEqual(expect.arrayContaining([...tokens, 'h-64']));
    await mounted.unmount();

    mounted = await mount(
      <DashboardHeader
        pubkey={'a'.repeat(64)}
        status="Read"
        busy={false}
        onRefresh={() => undefined}
        onLogOut={() => undefined}
      />,
    );
    const bar = classesOf(mounted.container.firstElementChild);
    expect(bar).toEqual(expect.arrayContaining([...tokens, 'min-h-64']));
  });
});
