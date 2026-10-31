import { act } from 'react';
import { type Root as ReactRoot, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiAnswer } from '../src/cloud/lib/api';
import { catalogPaidBy, tierCardsFrom } from '../src/cloud/lib/tiers';
import { EntryPage } from '../src/components/EntryPage';
import { CLOUD_DOCS_URL, PRICING_URL, STORE_KEY_COMMAND, TERMS_URL } from '../src/constants';
import { tiersAnswer } from './cloud/fake-api';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let mounted: { root: ReactRoot; host: HTMLElement } | undefined;

async function unmount() {
  await act(async () => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = undefined;
}

afterEach(unmount);

/** The catalog with each self-serve plan's ways to pay set. */
function catalog(payable: { card: boolean; crypto: boolean }): unknown {
  const body = JSON.parse(JSON.stringify(tiersAnswer())) as { tiers: Record<string, unknown>[] };
  for (const tier of body.tiers) {
    tier.payable = tier.selfServe === true ? payable : { card: false, crypto: false };
  }
  return body;
}

async function page(
  loadTiers: () => Promise<ApiAnswer>,
  handlers: { onCreate?: () => void; onSignIn?: () => void } = {},
  termsUrl: string | undefined = undefined,
) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () =>
    root.render(
      <EntryPage
        onCreate={handlers.onCreate ?? (() => undefined)}
        onSignIn={handlers.onSignIn ?? (() => undefined)}
        loadTiers={loadTiers}
        termsUrl={termsUrl}
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

function text(host: HTMLElement, selector: string): string {
  return host.querySelector(selector)?.textContent ?? '';
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((each) => each.textContent === label);
  if (found === undefined) {
    throw new Error(`no button ${label}`);
  }
  return found;
}

const answered = (body: unknown) => () => Promise.resolve({ status: 200, body });

describe('the front page', () => {
  it('says what it does, the steps, what is needed and the questions, in that order', async () => {
    const host = await page(answered(catalog({ card: true, crypto: true })));
    expect(host.querySelector('h1')?.textContent).toBe('Take crypto payments on your site');
    expect(text(host, '#entry-hero')).toContain(
      'Buyers pay in stablecoins straight to your wallet. We run the payment server for you.',
    );
    expect([...host.querySelectorAll('section')].map((section) => section.id)).toEqual([
      'entry-hero',
      'entry-steps',
      'entry-needs',
      'entry-questions',
    ]);
    const steps = [...host.querySelectorAll('#entry-steps li')].map((step) => step.textContent);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('Choose a plan.');
    expect(steps[1]).toContain('Save your access key.');
    expect(steps[1]).toContain('cannot restore it');
    expect(steps[2]).toContain('Pay the first month.');
    expect(steps[3]).toContain('Set up and go live.');
    expect(text(host, '#entry-needs')).toContain('A stablecoin wallet on Solana or Tempo');
    expect(text(host, '#entry-needs')).toContain('one line of HTML');
  });

  it('opens the two ways in: Create a store and Sign in', async () => {
    const onCreate = vi.fn();
    const onSignIn = vi.fn();
    const host = await page(answered(catalog({ card: true, crypto: true })), {
      onCreate,
      onSignIn,
    });
    expect(text(host, '#entry-hero')).toContain('Already have a store? Sign in');
    await act(async () => button(host, 'Create a store').click());
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
    await act(async () => button(host, 'Sign in').click());
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('uses no word a newcomer would not know above the questions', async () => {
    const host = await page(answered(catalog({ card: true, crypto: true })));
    for (const id of ['entry-hero', 'entry-steps', 'entry-needs']) {
      expect(text(host, `#${id}`), id).not.toMatch(/\b(nsec|relay|node|tenant)s?\b/i);
    }
  });

  it('answers the questions folded, each a details with its summary', async () => {
    const host = await page(answered(catalog({ card: true, crypto: true })));
    const questions = [...host.querySelectorAll('#entry-questions details')];
    expect(questions.map((each) => each.querySelector('summary')?.textContent)).toEqual([
      'Do you hold my money?',
      'What is the access key?',
      'What if I lose it?',
      'Can I leave?',
      'I run Pay Core myself',
    ]);
    expect(questions.every((each) => !(each as HTMLDetailsElement).open)).toBe(true);
    expect(questions[0]?.textContent).toContain('refunds are sent by you from it');
    expect(questions[0]?.textContent).toContain('We can pause the store itself');
    expect(questions[4]?.textContent).toContain(STORE_KEY_COMMAND);
  });

  it('links the terms, the prices and the docs', async () => {
    const host = await page(answered(catalog({ card: true, crypto: true })));
    const links = [...host.querySelectorAll('footer a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
      link.getAttribute('rel'),
    ]);
    expect(links).toEqual([
      ['Terms', TERMS_URL, 'noopener noreferrer'],
      ['Pricing', PRICING_URL, 'noopener noreferrer'],
      ['Docs', CLOUD_DOCS_URL, 'noopener noreferrer'],
    ]);
    await unmount();
    const other = await page(
      answered(catalog({ card: true, crypto: true })),
      {},
      'https://t.test/x',
    );
    expect(other.querySelector('footer a')?.getAttribute('href')).toBe('https://t.test/x');
  });
});

describe('how the first step says plans are paid', () => {
  it('names only the ways a plan that can start offers', async () => {
    const cases: [{ card: boolean; crypto: boolean }, string][] = [
      [{ card: true, crypto: true }, 'Monthly, paid by card or in stablecoins.'],
      [{ card: true, crypto: false }, 'Monthly, paid by card.'],
      [{ card: false, crypto: true }, 'Monthly, paid in stablecoins.'],
      [{ card: false, crypto: false }, 'Monthly.'],
    ];
    for (const [payable, said] of cases) {
      const host = await page(answered(catalog(payable)));
      expect(text(host, '#entry-paid-by'), JSON.stringify(payable)).toBe(said);
      await unmount();
    }
  });

  it('says "monthly" before the catalog is read, and when it cannot be', async () => {
    const pending = await page(() => new Promise<ApiAnswer>(() => undefined));
    expect(text(pending, '#entry-paid-by')).toBe('Monthly.');
    await unmount();
    for (const answer of [
      { status: 0, body: { error: 'unreachable' } },
      { status: 502, body: 'down' },
      // Only a 200 is the catalog, whatever the body of another answer says.
      { status: 503, body: catalog({ card: true, crypto: true }) },
      { status: 200, body: { tiers: 'nope' } },
    ]) {
      const host = await page(() => Promise.resolve(answer));
      expect(text(host, '#entry-paid-by'), JSON.stringify(answer)).toBe('Monthly.');
      await unmount();
    }
  });

  it('counts a plan that is not self-serve for nothing, even payable', () => {
    const body = JSON.parse(JSON.stringify(tiersAnswer())) as {
      tiers: Record<string, unknown>[];
    };
    for (const tier of body.tiers) {
      tier.payable =
        tier.selfServe === true ? { card: false, crypto: false } : { card: true, crypto: true };
    }
    expect(catalogPaidBy(tierCardsFrom(body))).toBeUndefined();
    expect(catalogPaidBy(undefined)).toBeUndefined();
  });
});
