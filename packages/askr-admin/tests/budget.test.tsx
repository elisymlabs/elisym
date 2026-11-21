import { afterEach, describe, expect, it } from 'vitest';
import { BudgetBanner } from '../src/components/BudgetBanner';
import { budgetNotice, nextMonthStart } from '../src/lib/budget';
import { storeView } from './fakes';
import { type Mounted, mount } from './mount';

/** 2026-11-20 19:00:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 19, 0, 0) / 1000;
/** The fake view's plan: $40 a month, its only budget. */
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

  it('says the chat is paused for the month, until when, and that an upgrade lifts it', () => {
    expect(budgetNotice(storeView({ ...month('40'), budgetPaused: 'month' }), NOW)).toEqual({
      tone: 'error',
      text: "This month's plan budget is used up: the chat does not answer visitors until December 1 (UTC), or until you upgrade your plan.",
    });
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
    expect(alert?.textContent).toContain("This month's plan budget is used up");
    expect(alert?.textContent).toContain('larger plan');
    expect(alert?.querySelector('.contact-link')).not.toBeNull();
  });

  it('renders nothing when there is nothing to say', async () => {
    mounted = await mount(<BudgetBanner view={storeView()} now={NOW} />);
    expect(mounted.container.innerHTML).toBe('');
  });
});
