import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dashboard } from '../src/components/Dashboard';
import { DashboardHeader } from '../src/components/DashboardHeader';
import { SignIn } from '../src/components/SignIn';
import { HEADER_BAR, LOCAL_ADMIN_COMMAND, PAGE_FRAME } from '../src/constants';
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
  it('says the wallet stays the merchant’s and what the key can do, with no card singled out', async () => {
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const text = mounted.container.textContent ?? '';
    expect(text).not.toContain('Before you paste');
    expect(text).not.toContain('A view of your store');
    expect(text).toContain('Your wallet stays yours');
    expect(text).toContain('Buyers pay straight into your wallet.');
    expect(text).toContain('Nobody, neither elisym nor this page, can reach your wallet');
    expect(text).toContain(
      'Pay Core never asks for a wallet’s secret key or seed phrase, so never paste one, here or anywhere else.',
    );
    expect(text).toContain('Keep the store key like a password');
    expect(text).toContain(
      'It signs your store’s profile, which decides where new buyers’ payments go.',
    );
    const panel = mounted.container.querySelector('aside');
    expect(panel?.querySelectorAll(':scope > div')).toHaveLength(2);
    expect(panel?.querySelector('.bg-accent-soft')).toBeNull();
    const cards = [...(panel?.querySelectorAll(':scope > div') ?? [])];
    expect(new Set(cards.map((card) => card.className)).size).toBe(1);
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
    expect(notes).toContain('This page’s code is served by Elisym on each visit');
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
    const header = classesOf(mounted.container.querySelector('header > div'));
    expect(header).toEqual(expect.arrayContaining([...tokens, 'h-64']));
    // Pinned to the top: opening the security details never moves the form.
    expect(classesOf(mounted.container.querySelector('main'))).not.toContain('sm:items-center');
    expect(classesOf(mounted.container.querySelector('main > div'))).toContain('items-start');
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
    // One line high, so the header row stays 64 and the logo sits where the landing's does.
    expect(classesOf(byId(mounted.container, 'store-pubkey').parentElement)).toContain('h-18');
    expect(classesOf(mounted.container.querySelector('[title="Pay Core"]'))).toContain('gap-10');
  });
});

describe('the sign-in header', () => {
  it('links only home, the landing, in this tab with a leave-the-page icon, and no Sign in', async () => {
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const links = [...mounted.container.querySelectorAll('header a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Home', 'https://paycore.elisym.network'],
    ]);
    expect(links[0]?.getAttribute('target')).toBeNull();
    expect(links[0]?.closest('nav')?.getAttribute('aria-label')).toBe('Pay Core');
    expect(links[0]?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(mounted.container.querySelector('header')?.textContent).not.toContain('Sign in');
    expect(mounted.container.querySelector('header')?.textContent).toContain('Admin');
  });
});

describe('one bar from the landing to the dashboard', () => {
  it('draws the landing bar on the sign-in page and on the dashboard, with the line at 64', async () => {
    const bar = HEADER_BAR.split(' ');
    mounted = await mount(<SignIn onKey={() => undefined} />);
    expect(classesOf(mounted.container.querySelector('header'))).toEqual(bar);
    await mounted.unmount();
    mounted = await mount(
      <Dashboard
        state={{ pubkey: 'a'.repeat(64), status: 'Reading', busy: true }}
        onRefresh={() => undefined}
        onMore={() => undefined}
        onLogOut={() => undefined}
      />,
    );
    const header = mounted.container.querySelector('header');
    expect(classesOf(header)).toEqual(bar);
    expect(classesOf(header?.firstElementChild ?? null)).toEqual(['border-line/60', 'border-b']);
    expect(classesOf(header?.firstElementChild?.firstElementChild ?? null)).toEqual(
      expect.arrayContaining(['min-h-64', 'md:py-0']),
    );
  });
});

describe('a key typed but not opened', () => {
  it('is cleared when the page is left, so the back/forward cache never brings it back', async () => {
    mounted = await mount(<SignIn onKey={() => undefined} />);
    const field = byId(mounted.container, 'store-key');
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('no key field');
    }
    field.value = 'a'.repeat(64);
    window.dispatchEvent(new Event('pagehide'));
    expect(field.value).toBe('');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
  });
});
