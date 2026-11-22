import { afterEach, describe, expect, it } from 'vitest';
import { BudgetBanner } from '../src/components/BudgetBanner';
import { budgetNotice, budgetResetDay, nextMonthStart } from '../src/lib/budget';
import { storeView } from './fakes';
import { type Mounted, mount } from './mount';

/** 2026-11-20 19:00:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 19, 0, 0) / 1000;
/** The fake view's plan: $40 a month, its only budget. */
const month = (spent: string) => ({
  usage: { ...storeView().usage, month: { spent } },
});
/** A paid plan billed on the 30th: its period ends 2026-11-30 12:00 UTC, as the server says. */
const PAID_RESET = Date.UTC(2026, 10, 30, 12, 0, 0) / 1000;
const paidPeriod = (spent: string) => ({
  usage: { ...storeView().usage, month: { spent }, budget: { resetsAt: PAID_RESET } },
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('budget notice', () => {
  it('says nothing while the chat answers and the period is under 80%', () => {
    expect(budgetNotice(storeView(month('31.99')), NOW)).toBeUndefined();
  });

  it("warns from 80% of the period, with the server's day it starts again", () => {
    expect(budgetNotice(storeView(paidPeriod('34')), NOW)).toEqual({
      tone: 'warn',
      text: "You have used 85% of this period's budget. When it runs out, the chat stops answering visitors until November 30 (UTC).",
    });
  });

  it("says the chat is paused for the period, until the server's reset day, and that an upgrade lifts it", () => {
    expect(budgetNotice(storeView({ ...paidPeriod('40'), budgetPaused: 'month' }), NOW)).toEqual({
      tone: 'error',
      text: "This period's plan budget is used up: the chat does not answer visitors until November 30 (UTC), or until you upgrade your plan.",
    });
  });

  it('an older server without a reset time: the next calendar month', () => {
    expect(budgetNotice(storeView({ ...month('40'), budgetPaused: 'month' }), NOW)).toEqual({
      tone: 'error',
      text: "This period's plan budget is used up: the chat does not answer visitors until December 1 (UTC), or until you upgrade your plan.",
    });
    expect(budgetNotice(storeView(month('34')), NOW)?.text).toContain('until December 1 (UTC).');
  });

  it("names the reset day in UTC, from the server's reset time", () => {
    // 00:30 UTC on Dec 1 is still November 30 in the Americas: the day shown is UTC's.
    const early = Date.UTC(2026, 11, 1, 0, 30) / 1000;
    const view = storeView({ usage: { ...storeView().usage, budget: { resetsAt: early } } });
    expect(budgetResetDay(view, NOW)).toBe('December 1');
    expect(budgetResetDay(storeView(paidPeriod('1')), NOW)).toBe('November 30');
  });

  it('says nothing for a store that is not active or has no plan', () => {
    expect(
      budgetNotice(storeView({ status: 'pending', budgetPaused: 'month' }), NOW),
    ).toBeUndefined();
    expect(budgetNotice(storeView({ tier: null, ...month('39') }), NOW)).toBeUndefined();
  });

  it('rolls the month over the year', () => {
    expect(nextMonthStart(Date.UTC(2026, 11, 31, 23, 59) / 1000)).toBe('January 1');
  });
});

describe('budget banner', () => {
  it('shows the pause as an alert, with how to move to a larger plan', async () => {
    mounted = await mount(<BudgetBanner view={storeView({ budgetPaused: 'month' })} now={NOW} />);
    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("This period's plan budget is used up");
    expect(alert?.textContent).toContain('To move to a larger plan, open Billing.');
    // Billing shows this store's own way up (checkout, Manage billing, or us), so the banner has no contact links.
    expect(alert?.querySelector('.contact-link')).toBeNull();
  });

  it('renders nothing when there is nothing to say', async () => {
    mounted = await mount(<BudgetBanner view={storeView()} now={NOW} />);
    expect(mounted.container.innerHTML).toBe('');
  });
});
