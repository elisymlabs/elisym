import { afterEach, describe, expect, it } from 'vitest';
import { BudgetBanner } from '../src/components/BudgetBanner';
import { budgetNotice, nextMonthStart, untilMidnight } from '../src/lib/budget';
import { storeView } from './fakes';
import { type Mounted, mount } from './mount';

/** 2026-11-20 19:00:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 19, 0, 0) / 1000;
/** The fake view's plan: $2 a day, $40 a month. */
const month = (spent: string) => ({
  usage: { ...storeView().usage, month: { spent } },
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('budget notice', () => {
  it('says nothing while the chat answers and the month is under 80%', () => {
    expect(budgetNotice(storeView(month('31.99')), NOW)).toBeUndefined();
  });

  it('warns from 80% of the month, with the day it starts again', () => {
    expect(budgetNotice(storeView(month('34')), NOW)).toEqual({
      tone: 'warn',
      text: "You have used 85% of this month's budget. When it runs out, the chat stops answering visitors until December 1.",
    });
  });

  it('says the chat is paused for the day, and until when', () => {
    expect(budgetNotice(storeView({ budgetPaused: 'day' }), NOW)).toEqual({
      tone: 'error',
      text: "Today's budget is used up: the chat does not answer visitors until 00:00 UTC, in about 5 hours.",
    });
  });

  it('says the chat is paused for the month, which a full day does not hide', () => {
    expect(budgetNotice(storeView({ ...month('40'), budgetPaused: 'month' }), NOW)).toEqual({
      tone: 'error',
      text: "This month's budget is used up: the chat does not answer visitors until December 1 (UTC).",
    });
  });

  it('says nothing for a store that is not active or has no plan', () => {
    expect(
      budgetNotice(storeView({ status: 'pending', budgetPaused: 'day' }), NOW),
    ).toBeUndefined();
    expect(budgetNotice(storeView({ tier: null, ...month('39') }), NOW)).toBeUndefined();
  });

  it('counts down to UTC midnight and rolls the month over the year', () => {
    expect(untilMidnight(Date.UTC(2026, 10, 20, 23, 30) / 1000)).toBe('less than an hour');
    expect(untilMidnight(Date.UTC(2026, 10, 20, 22, 30) / 1000)).toBe('about 1 hour');
    expect(nextMonthStart(Date.UTC(2026, 11, 31, 23, 59) / 1000)).toBe('January 1');
  });
});

describe('budget banner', () => {
  it('shows the pause as an alert, with how to move to a larger plan', async () => {
    mounted = await mount(<BudgetBanner view={storeView({ budgetPaused: 'day' })} now={NOW} />);
    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Today's budget is used up");
    expect(alert?.textContent).toContain('larger plan');
    expect(alert?.querySelector('.contact-link')).not.toBeNull();
  });

  it('renders nothing when there is nothing to say', async () => {
    mounted = await mount(<BudgetBanner view={storeView()} now={NOW} />);
    expect(mounted.container.innerHTML).toBe('');
  });
});
