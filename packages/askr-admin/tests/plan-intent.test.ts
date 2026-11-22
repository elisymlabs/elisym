// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { takeBillingReturn } from '../src/lib/billing';
import { intentShortSummary, intentSummary, takePlanIntent } from '../src/lib/plan-intent';

const ADMIN = 'https://app.askr.test/admin/';

function take(query: string) {
  const replaceState = vi.fn();
  const intent = takePlanIntent({ href: `${ADMIN}${query}` }, { replaceState, state: { kept: 1 } });
  return { intent, replaceState };
}

describe('the plan chosen on the landing (D2)', () => {
  it.each([
    ['?plan=starter&interval=month', { plan: 'starter', interval: 'month' }],
    ['?plan=growth&interval=year', { plan: 'growth', interval: 'year' }],
    ['?interval=year&plan=pro', { plan: 'pro', interval: 'year' }],
    ['?plan=scale&interval=month', { plan: 'scale', interval: 'month' }],
  ])('reads %s', (query, expected) => {
    const { intent, replaceState } = take(query);
    expect(intent).toEqual(expected);
    expect(replaceState).toHaveBeenCalledWith({ kept: 1 }, '', '/admin/');
  });

  it.each([
    '?plan=free&interval=year',
    '?plan=enterprise&interval=year',
    '?plan=platinum&interval=year',
    '?plan=Growth&interval=year',
    '?plan=growth&interval=week',
    '?plan=growth&interval=yearly',
    '?plan=growth',
    '?interval=year',
    '?plan=growth&plan=growth&interval=year',
    '?plan=growth&plan=pro&interval=year',
    '?plan=growth&interval=year&interval=month',
    '?plan=&interval=year',
  ])('reads no plan from %s, and removes its parameters', (query) => {
    const { intent, replaceState } = take(query);
    expect(intent).toBeUndefined();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[2]).toBe('/admin/');
  });

  it('keeps every other parameter and the hash, and leaves the billing flag to its own reader', () => {
    const { intent, replaceState } = take('?billing=success&plan=growth&tab=x&interval=year#top');
    expect(intent).toEqual({ plan: 'growth', interval: 'year' });
    const left = String(replaceState.mock.calls[0]?.[2]);
    expect(left).toBe('/admin/?billing=success&tab=x#top');
    // The billing flag is still there for takeBillingReturn.
    const billingReplace = vi.fn();
    expect(
      takeBillingReturn(
        { href: `https://app.askr.test${left}` },
        { replaceState: billingReplace, state: null },
      ),
    ).toBe('success');
    expect(billingReplace).toHaveBeenCalledWith(null, '', '/admin/?tab=x#top');
  });

  it('touches nothing when the address has neither parameter', () => {
    const { intent, replaceState } = take('?billing=success#top');
    expect(intent).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
    expect(takePlanIntent(undefined, undefined)).toBeUndefined();
  });

  it('reads the plan without a history to strip it from', () => {
    expect(takePlanIntent({ href: `${ADMIN}?plan=pro&interval=month` }, undefined)).toEqual({
      plan: 'pro',
      interval: 'month',
    });
  });
});

describe('the chosen plan in words (D3)', () => {
  it('prices it as its card does, yearly with its total', () => {
    expect(intentSummary({ plan: 'growth', interval: 'year' })).toBe(
      'You chose Growth: $79 a month, billed yearly ($948).',
    );
    expect(intentSummary({ plan: 'growth', interval: 'month' })).toBe(
      'You chose Growth: $99 a month, billed monthly.',
    );
    expect(intentSummary({ plan: 'scale', interval: 'year' })).toBe(
      'You chose Scale: $399 a month, billed yearly ($4,788).',
    );
    expect(intentSummary({ plan: 'starter', interval: 'month' })).toBe(
      'You chose Starter: $29 a month, billed monthly.',
    );
  });
});

describe('the chosen plan in a few words, before sign-in (R4)', () => {
  it('says the monthly price, or the yearly one with its total', () => {
    expect(intentShortSummary({ plan: 'starter', interval: 'month' })).toBe('Starter · $29/month');
    expect(intentShortSummary({ plan: 'growth', interval: 'year' })).toBe(
      'Growth · $79/month, billed yearly ($948/year)',
    );
  });
});
