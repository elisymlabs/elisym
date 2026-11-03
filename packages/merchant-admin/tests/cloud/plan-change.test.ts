import { describe, expect, it } from 'vitest';
import {
  type PlanNames,
  type PlanPreview,
  dollarsOf,
  keepRefusalText,
  planPreviewOf,
  planReasonText,
  planRefusalText,
  previewLines,
  refusalLines,
  requestWords,
  scheduledWords,
  shownDay,
  shownDayTime,
} from '../../src/cloud/lib/plan-change';
import { type PlanRequestView, storeViewOf } from '../../src/cloud/lib/store-view';
import { tierCardsFrom } from '../../src/cloud/lib/tiers';
import { FakeStore, readyState, tiersAnswer } from './fake-api';

const DAY = 86400;
const NOW = 1_800_000_000;
/** 30 Nov 2027, 00:00 UTC. */
const SWITCH = Date.UTC(2027, 10, 30) / 1000;
const NAMES: PlanNames = {
  name: (tier) => ({ starter: 'Starter', business: 'Business' })[tier] ?? tier,
  cents: (tier) => ({ starter: 2900, business: 9900 })[tier],
};
const PLANS = { to: 'Business', current: 'Starter' };

function preview(overrides: Partial<PlanPreview>): PlanPreview {
  return {
    tier: 'starter',
    to: 'business',
    how: 'card',
    at: undefined,
    forfeits: undefined,
    fitProblems: [],
    capWords: undefined,
    ...overrides,
  };
}

describe('amounts and days', () => {
  it('writes whole dollars plainly and cents to two places, through Decimal', () => {
    expect(dollarsOf(9900)).toBe('$99');
    expect(dollarsOf(2950)).toBe('$29.50');
    expect(dollarsOf(2901)).toBe('$29.01');
    expect(dollarsOf(0)).toBe('$0');
    expect(dollarsOf(123_456_700)).toBe('$1234567');
  });

  it('writes a day and a minute in UTC', () => {
    expect(shownDay(SWITCH)).toBe('30 Nov');
    expect(shownDay(SWITCH - 1)).toBe('29 Nov');
    expect(shownDayTime(Date.UTC(2027, 10, 3, 14, 20, 59) / 1000)).toBe('3 Nov, 14:20 UTC');
    expect(shownDayTime(Date.UTC(2027, 10, 3, 4, 5) / 1000)).toBe('3 Nov, 04:05 UTC');
  });
});

describe('the sheet, for each way the server decided', () => {
  it('a card upgrade: charged today, a new period, the days left not carried over', () => {
    expect(previewLines(preview({ forfeits: NOW + 12 * DAY + 3600 }), NAMES, NOW)).toEqual({
      lines: [
        'Business starts now at $99 a month, charged to your card today. A new monthly period starts today.',
        'The 12 days left on Starter are not carried over.',
      ],
      action: { kind: 'confirm', label: 'Pay $99 and switch' },
    });
  });

  it('counts the days left on the server clock: one day, hours, none', () => {
    const forfeit = (forfeits: number | undefined) =>
      previewLines(preview({ forfeits }), NAMES, NOW).lines.slice(1);
    expect(forfeit(NOW + 2 * DAY)).toEqual(['The 2 days left on Starter are not carried over.']);
    expect(forfeit(NOW + 2 * DAY - 1)).toEqual(['The 1 day left on Starter is not carried over.']);
    expect(forfeit(NOW + DAY)).toEqual(['The 1 day left on Starter is not carried over.']);
    expect(forfeit(NOW + DAY - 1)).toEqual(['The hours left on Starter are not carried over.']);
    expect(forfeit(NOW + 1)).toEqual(['The hours left on Starter are not carried over.']);
    expect(forfeit(NOW)).toEqual([]);
    expect(forfeit(NOW - DAY)).toEqual([]);
    expect(forfeit(undefined)).toEqual([]);
  });

  it('a plan the catalog gives no price for is never priced here', () => {
    const unpriced: PlanNames = { name: NAMES.name, cents: () => undefined };
    expect(previewLines(preview({}), unpriced, NOW)).toEqual({
      lines: [
        'Business starts now at its monthly price, charged to your card today. A new monthly period starts today.',
      ],
      action: { kind: 'confirm', label: 'Pay and switch' },
    });
  });

  it('a stablecoin upgrade: on the billing page, a full month from the payment', () => {
    expect(
      previewLines(preview({ how: 'billing_page', forfeits: NOW + 12 * DAY }), NAMES, NOW),
    ).toEqual({
      lines: [
        'Business starts when your payment arrives, for a full month.',
        'The 12 days left on Starter are not carried over.',
        'On the billing page, choose Business, one month.',
      ],
      action: { kind: 'billing_page' },
    });
  });

  it('a downgrade: its day, the plan kept until then, its price, what will be over and the cap', () => {
    const capWords =
      'Starter is meant for up to 2,000 paid orders a month; you had 2,340 this month. Orders are never blocked.';
    expect(
      previewLines(
        preview({
          tier: 'business',
          to: 'starter',
          how: 'scheduled',
          at: SWITCH,
          fitProblems: ['240 products, the Starter plan takes up to 100'],
          capWords,
        }),
        NAMES,
        NOW,
      ),
    ).toEqual({
      lines: [
        'Your store moves to Starter on 30 Nov. Until then you keep Business. From then, $29 a month.',
        "On Starter, your store will be over its limits: 240 products, the Starter plan takes up to 100. Nothing is removed: your products stay on sale, but you cannot add new ones until you are within Starter's limits.",
        capWords,
      ],
      action: { kind: 'confirm', label: 'Move to Starter on 30 Nov' },
    });
    // Several problems are said together.
    expect(
      previewLines(
        preview({
          tier: 'business',
          to: 'starter',
          how: 'scheduled',
          at: SWITCH,
          fitProblems: ['a', 'b'],
        }),
        NAMES,
        NOW,
      ).lines[1],
    ).toContain('over its limits: a; b. Nothing is removed');
  });

  it('nothing paid now: at once, and the next payment is the new plan', () => {
    expect(previewLines(preview({ how: 'now' }), NAMES, NOW)).toEqual({
      lines: ['Your store moves to Business now. Your next payment is $99 a month.'],
      action: { kind: 'confirm', label: 'Move to Business now' },
    });
    expect(
      previewLines(
        preview({ tier: 'business', to: 'starter', how: 'now', capWords: 'Over the cap.' }),
        NAMES,
        NOW,
      ).lines,
    ).toEqual([
      'Your store moves to Starter now. Your next payment is $29 a month.',
      'Over the cap.',
    ]);
  });
});

describe('a refusal in the sheet', () => {
  it("shows the server's own words when it sends them", () => {
    const detail = 'Starter takes up to 100 products, your store has 300: remove 200 first';
    expect(refusalLines({ error: 'remove_products_first', detail }, 409, PLANS)).toEqual({
      lines: [detail],
      action: { kind: 'page', page: 'products', label: 'Go to Products' },
    });
    expect(
      refusalLines(
        {
          error: 'remove_own_rpc_first',
          detail: 'Starter runs on our RPCs: remove your own RPC first',
        },
        409,
        PLANS,
      ),
    ).toEqual({
      lines: ['Starter runs on our RPCs: remove your own RPC first'],
      action: { kind: 'page', page: 'settings', label: 'Go to Settings' },
    });
    expect(planRefusalText({ error: 'keep_refused', detail: 'Kept words.' }, 409, PLANS)).toBe(
      'Kept words.',
    );
    // An empty detail is none.
    expect(planRefusalText({ error: 'same_tier', detail: '' }, 409, PLANS)).toBe(
      'Your store is on this plan already.',
    );
  });

  it('a store that paid before pays for the bigger plan: on the billing page', () => {
    expect(refusalLines({ error: 'pay_for_upgrade' }, 409, PLANS)).toEqual({
      lines: [
        'Pay for Business to move to it: on the billing page choose Business, or pay by card.',
      ],
      action: { kind: 'billing_page' },
    });
    expect(refusalLines({ error: 'pay_on_billing_page' }, 409, PLANS)).toEqual({
      lines: [
        'Business starts when your payment arrives, for a full month.',
        'On the billing page, choose Business, one month.',
      ],
      action: { kind: 'billing_page' },
    });
  });

  it('words every code the plan routes refuse with', () => {
    const said: Record<string, string> = {
      change_in_flight: 'A plan change is already on its way: finish or cancel it first.',
      card_not_active: 'Your card subscription is not active: fix it in the billing portal first.',
      invoice_pending: 'Your monthly payment is being taken right now: try again in an hour.',
      downgrade_scheduled: 'Keep Starter first.',
      card_prices_unchecked: 'Card plan changes are not open just now: try again later.',
      owner_unconfirmed:
        'A card plan change opens once the operator has confirmed your access key.',
      card_status_unknown: 'The card subscription could not be read just now: try again shortly.',
      card_session_open: 'A card checkout is still open: try again in a minute.',
      same_tier: 'Your store is on this plan already.',
      state_changed: 'Your store changed meanwhile: look at it again, then try once more.',
      not_self_serve: 'To change this plan, contact elisym.',
      partner: 'Your partner manages your plan.',
      exported: 'This store left the cloud: its plan cannot change.',
      billing_tenant: 'To change this plan, contact elisym.',
      payments_closed: 'Payments for this store are closed: contact elisym.',
      nothing_scheduled: 'No change of plan is scheduled any more.',
      no_such_request: 'That plan change is no longer there: refresh to see where it stands.',
      not_cancellable: 'Only a payment waiting for your confirmation can be cancelled.',
      no_card_for_tier: 'This plan cannot be paid by card.',
      card_subscription_items: 'Your card subscription needs the operator: contact elisym.',
      stripe_unavailable: 'Card payments could not be reached just now: try again shortly.',
      unreachable: 'Could not reach our cloud: check your connection and try again.',
    };
    for (const [code, words] of Object.entries(said)) {
      expect(refusalLines({ error: code }, 409, PLANS), code).toEqual({
        lines: [words],
        action: { kind: 'none' },
      });
    }
    expect(planRefusalText({ error: 'brand_new' }, 409, PLANS)).toBe(
      'The cloud refused it (brand_new).',
    );
    expect(planRefusalText('not json', 502, PLANS)).toBe(
      'The cloud did not answer as expected (HTTP 502).',
    );
    // A code that only looks like one of the table's is not.
    expect(planRefusalText({ error: 'toString' }, 409, PLANS)).toBe(
      'The cloud refused it (toString).',
    );
  });

  it('why the plan cannot change here', () => {
    expect(planReasonText('partner')).toBe('Your partner manages your plan.');
    for (const reason of [
      'not_self_serve',
      'billing_tenant',
      'exported',
      'payments_closed',
      undefined,
    ]) {
      expect(planReasonText(reason), String(reason)).toBe('To change this plan, contact elisym.');
    }
  });
});

describe('the rows of a change on its way, or scheduled', () => {
  const request = (overrides: Partial<PlanRequestView>): PlanRequestView => ({
    id: `pr_${'0'.repeat(24)}`,
    to: 'business',
    status: 'charging',
    payUrl: undefined,
    expiresAt: undefined,
    endedAt: undefined,
    ...overrides,
  });

  it('words each status, none for one that applied', () => {
    const expiresAt = Date.UTC(2027, 10, 3, 14, 20) / 1000;
    expect(requestWords(request({}), NAMES)).toBe('Your payment is being processed.');
    expect(requestWords(request({ status: 'awaiting_confirmation', expiresAt }), NAMES)).toBe(
      'Your card needs you to confirm the payment of $99 by 3 Nov, 14:20 UTC. Until then nothing changes.',
    );
    expect(requestWords(request({ status: 'awaiting_confirmation' }), NAMES)).toBe(
      'Your card needs you to confirm the payment of $99. Until then nothing changes.',
    );
    expect(
      requestWords(request({ status: 'awaiting_confirmation', expiresAt }), {
        name: NAMES.name,
        cents: () => undefined,
      }),
    ).toBe(
      'Your card needs you to confirm the payment for Business by 3 Nov, 14:20 UTC. Until then nothing changes.',
    );
    expect(requestWords(request({ status: 'expired' }), NAMES)).toBe(
      'The payment for Business was not completed in time: nothing changed.',
    );
    expect(requestWords(request({ status: 'cancelled' }), NAMES)).toBe(
      'You cancelled the change to Business: nothing changed.',
    );
    expect(requestWords(request({ status: 'failed' }), NAMES)).toBe(
      'Business could not be started: nothing changed. Try again.',
    );
    expect(requestWords(request({ status: 'unknown' }), NAMES)).toBe(
      'Your plan change needs us: we will contact you.',
    );
    expect(requestWords(request({ status: 'done' }), NAMES)).toBeUndefined();
  });

  it('a scheduled downgrade, and Keep refused in the words the server sent', () => {
    const scheduled = {
      tier: 'starter',
      at: SWITCH,
      keepRefusal: undefined,
      keepWords: undefined,
    };
    expect(scheduledWords(scheduled, NAMES)).toBe('Moves to Starter on 30 Nov');
    expect(keepRefusalText(scheduled)).toBeUndefined();
    expect(keepRefusalText({ ...scheduled, keepRefusal: 'due_soon', keepWords: 'Soon.' })).toBe(
      'Soon.',
    );
    expect(keepRefusalText({ ...scheduled, keepRefusal: 'paid' })).toBe(
      'Keep is not open now: refresh to see where it stands.',
    );
  });
});

describe('the preview answer as the admin reads it', () => {
  const answer = {
    tenantId: 'aaaaaaaaaaaa',
    tier: 'business',
    to: 'starter',
    how: 'scheduled',
    at: SWITCH,
    fitProblems: ['x'],
    capWords: 'cap',
  };

  it('takes each way, with its fields', () => {
    expect(planPreviewOf(answer)).toEqual({
      tier: 'business',
      to: 'starter',
      how: 'scheduled',
      at: SWITCH,
      forfeits: undefined,
      fitProblems: ['x'],
      capWords: 'cap',
    });
    for (const how of ['now', 'card', 'billing_page']) {
      expect(
        planPreviewOf({ tier: 'starter', to: 'business', how, forfeits: NOW, fitProblems: [] }),
        how,
      ).toEqual({
        tier: 'starter',
        to: 'business',
        how,
        at: undefined,
        forfeits: NOW,
        fitProblems: [],
        capWords: undefined,
      });
    }
  });

  it('refuses a malformed one whole', () => {
    const { at: _at, ...noDay } = answer;
    for (const bad of [
      { ...answer, how: 'later' },
      noDay,
      { ...answer, how: 'now' },
      { ...answer, at: -1 },
      { ...answer, at: 1.5 },
      { ...answer, forfeits: 'soon' },
      { ...answer, fitProblems: 'x' },
      { ...answer, fitProblems: [1] },
      { ...answer, capWords: 3 },
      { ...answer, tier: 1 },
      { ...answer, to: null },
      null,
      'text',
    ]) {
      expect(planPreviewOf(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("the owner view's plan", () => {
  const body = new FakeStore(readyState()).view();

  it('reads the plan, each request status and the schedule', () => {
    expect(storeViewOf(body)?.plan).toEqual({
      canChange: true,
      reason: undefined,
      card: undefined,
      scheduled: undefined,
      request: undefined,
    });
    for (const status of [
      'charging',
      'awaiting_confirmation',
      'unknown',
      'done',
      'expired',
      'cancelled',
      'failed',
    ]) {
      expect(
        storeViewOf({
          ...body,
          plan: { canChange: true, request: { id: 'pr_1', to: 'business', status } },
        })?.plan?.request,
        status,
      ).toEqual({
        id: 'pr_1',
        to: 'business',
        status,
        payUrl: undefined,
        expiresAt: undefined,
        endedAt: undefined,
      });
    }
    expect(
      storeViewOf({
        ...body,
        plan: {
          canChange: false,
          reason: 'partner',
          card: { open: false, reason: 'invoice_pending' },
          scheduled: { tier: 'starter', at: SWITCH, keepRefusal: 'paid', keepWords: 'Paid.' },
          request: {
            id: 'pr_1',
            to: 'business',
            status: 'awaiting_confirmation',
            payUrl: 'https://invoice.stripe.com/i/x',
            expiresAt: NOW,
            endedAt: NOW,
          },
        },
      })?.plan,
    ).toEqual({
      canChange: false,
      reason: 'partner',
      card: { open: false, reason: 'invoice_pending' },
      scheduled: { tier: 'starter', at: SWITCH, keepRefusal: 'paid', keepWords: 'Paid.' },
      request: {
        id: 'pr_1',
        to: 'business',
        status: 'awaiting_confirmation',
        payUrl: 'https://invoice.stripe.com/i/x',
        expiresAt: NOW,
        endedAt: NOW,
      },
    });
  });

  it('a cloud that sends no plan or reference: none, the rest of the view read', () => {
    const { plan: _plan, billingRef: _ref, ...older } = body;
    const view = storeViewOf(older);
    expect(view?.plan).toBeUndefined();
    expect(view?.billingRef).toBeUndefined();
    expect(view?.tier).toBe('starter');
    expect(storeViewOf({ ...body, billingRef: null })?.billingRef).toBeUndefined();
    expect(storeViewOf(body)?.billingRef).toBe(body.billingRef);
  });

  it('a malformed plan or reference is a malformed view', () => {
    for (const plan of [
      null,
      'yes',
      {},
      { canChange: 'yes' },
      { canChange: true, reason: 3 },
      { canChange: true, reason: '' },
      { canChange: true, card: { reason: 'x' } },
      { canChange: true, card: { open: true, reason: 1 } },
      { canChange: true, scheduled: { tier: 'starter' } },
      { canChange: true, scheduled: { tier: 1, at: SWITCH } },
      { canChange: true, scheduled: { tier: 'starter', at: SWITCH, keepRefusal: 2 } },
      { canChange: true, scheduled: { tier: 'starter', at: SWITCH, keepWords: '' } },
      { canChange: true, request: { id: 'pr_1', to: 'business', status: 'paid' } },
      { canChange: true, request: { id: 1, to: 'business', status: 'charging' } },
      { canChange: true, request: { id: 'pr_1', to: 2, status: 'charging' } },
      { canChange: true, request: { id: 'pr_1', to: 'b', status: 'charging', payUrl: 7 } },
      { canChange: true, request: { id: 'pr_1', to: 'b', status: 'charging', expiresAt: -1 } },
      { canChange: true, request: { id: 'pr_1', to: 'b', status: 'charging', endedAt: 'x' } },
    ]) {
      expect(storeViewOf({ ...body, plan }), JSON.stringify(plan)).toBeUndefined();
    }
    for (const billingRef of ['', 'a b', 'x'.repeat(129), 'a/b', 5]) {
      expect(storeViewOf({ ...body, billingRef }), String(billingRef)).toBeUndefined();
    }
    expect(storeViewOf({ ...body, billingRef: 'x'.repeat(128) })?.billingRef).toBe('x'.repeat(128));
  });
});

describe('the catalog prices', () => {
  it("reads each self-serve plan's monthly cents, none for the others; a bad one refuses the catalog", () => {
    const cards = tierCardsFrom(tiersAnswer());
    expect(cards?.map((card) => [card.id, card.monthlyCents])).toEqual([
      ['starter', 2900],
      ['business', 9900],
      ['high-risk', undefined],
      ['white-label', undefined],
    ]);
    for (const monthlyCents of [-1, 1.5, '2900', null]) {
      const tiers = tiersAnswer();
      const list = Array.isArray(tiers.tiers) ? tiers.tiers : [];
      expect(
        tierCardsFrom({ tiers: [{ ...list[0], monthlyCents }] }),
        String(monthlyCents),
      ).toBeUndefined();
    }
  });
});
