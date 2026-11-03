/**
 * The merchant's plan change as the admin says it (plan `cloud-plan-change.md`
 * 2.6): the server decides every case and every amount (`monthlyCents`, the
 * switch day, the fit and cap words); here they are only put in words. A
 * refusal the server words (`detail`) is shown as it is.
 */
import Decimal from 'decimal.js-light';
import { explainAnswer } from './errors';
import { fieldOf } from './fields';
import { type PlanRequestView, type PlanScheduleView, isTime } from './store-view';

const DAY_SECS = 86400;
const CENTS_PER_DOLLAR = 100;

/** What the sheet needs of the catalog: a plan's name, and its monthly price in cents. */
export interface PlanNames {
  /** The plan's name; its id when the catalog does not name it. */
  name: (tier: string) => string;
  cents: (tier: string) => number | undefined;
}

/** A whole-cent amount in dollars: "$99", "$29.50". */
export function dollarsOf(cents: number): string {
  const dollars = new Decimal(cents).div(CENTS_PER_DOLLAR);
  return `$${dollars.isInteger() ? dollars.toString() : dollars.toFixed(2)}`;
}

/** A day as the sheet writes it: "30 Nov" (UTC). */
export function shownDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** A day and minute: "3 Nov, 14:20 UTC". */
export function shownDayTime(seconds: number): string {
  return `${shownDay(seconds)}, ${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC`;
}

/** How a change happens, as the server decided it (`POST /tenants/:id/plan/preview`). */
export const PLAN_HOWS = ['now', 'scheduled', 'card', 'billing_page'] as const;
export type PlanHow = (typeof PLAN_HOWS)[number];

export interface PlanPreview {
  /** The plan in force. */
  tier: string;
  to: string;
  how: PlanHow;
  /** A scheduled downgrade: when the smaller plan takes over. */
  at: number | undefined;
  /** An upgrade: the end of the paid time the plan in force has left, forfeited. */
  forfeits: number | undefined;
  fitProblems: string[];
  capWords: string | undefined;
}

function isHow(value: unknown): value is PlanHow {
  return PLAN_HOWS.some((how) => how === value);
}

/** A preview from its answer's body, or undefined when any field is not what it must be. */
export function planPreviewOf(body: unknown): PlanPreview | undefined {
  const tier = fieldOf(body, 'tier');
  const to = fieldOf(body, 'to');
  const how = fieldOf(body, 'how');
  const at = fieldOf(body, 'at');
  const forfeits = fieldOf(body, 'forfeits');
  const fitProblems = fieldOf(body, 'fitProblems');
  const capWords = fieldOf(body, 'capWords');
  if (
    typeof tier !== 'string' ||
    typeof to !== 'string' ||
    !isHow(how) ||
    (at !== undefined && !isTime(at)) ||
    (how === 'scheduled') !== isTime(at) ||
    (forfeits !== undefined && !isTime(forfeits)) ||
    !Array.isArray(fitProblems) ||
    !fitProblems.every((problem) => typeof problem === 'string') ||
    (capWords !== undefined && typeof capWords !== 'string')
  ) {
    return undefined;
  }
  return {
    tier,
    to,
    how,
    at: isTime(at) ? at : undefined,
    forfeits: isTime(forfeits) ? forfeits : undefined,
    fitProblems: fitProblems.filter((problem) => typeof problem === 'string'),
    capWords: typeof capWords === 'string' ? capWords : undefined,
  };
}

/** What the sheet's one action does. */
export type SheetAction =
  /** Sends the change (`POST /tenants/:id/plan`), labelled. */
  | { kind: 'confirm'; label: string }
  /** Links to the billing page, where paying the plan's product is the change. */
  | { kind: 'billing_page' }
  /** Goes to a page of the admin where what is over the plan is removed. */
  | { kind: 'page'; page: 'products' | 'settings'; label: string }
  | { kind: 'none' };

export interface SheetLines {
  lines: string[];
  action: SheetAction;
}

/** "The 12 days left on Starter are not carried over." (none when nothing is left). */
function forfeitWords(forfeits: number | undefined, now: number, current: string): string[] {
  if (forfeits === undefined || forfeits <= now) {
    return [];
  }
  const days = Math.floor((forfeits - now) / DAY_SECS);
  if (days === 0) {
    return [`The hours left on ${current} are not carried over.`];
  }
  return days === 1
    ? [`The 1 day left on ${current} is not carried over.`]
    : [`The ${days} days left on ${current} are not carried over.`];
}

/** What a smaller plan would leave over, and this month's orders over its cap: never a refusal. */
function overWords(preview: PlanPreview, to: string): string[] {
  const fit =
    preview.fitProblems.length === 0
      ? []
      : [
          `On ${to}, your store will be over its limits: ${preview.fitProblems.join('; ')}. Nothing is removed: your products stay on sale, but you cannot add new ones until you are within ${to}'s limits.`,
        ];
  return preview.capWords === undefined ? fit : [...fit, preview.capWords];
}

/** "$99 a month", or the plan's monthly price when the catalog does not say it. */
function monthly(cents: number | undefined): string {
  return cents === undefined ? 'its monthly price' : `${dollarsOf(cents)} a month`;
}

/** The sheet's words and action for a change the server would take (plan 2.6). */
export function previewLines(preview: PlanPreview, names: PlanNames, now: number): SheetLines {
  const to = names.name(preview.to);
  const current = names.name(preview.tier);
  const cents = names.cents(preview.to);
  switch (preview.how) {
    case 'card':
      return {
        lines: [
          `${to} starts now at ${monthly(cents)}, charged to your card today. A new monthly period starts today.`,
          ...forfeitWords(preview.forfeits, now, current),
        ],
        action: {
          kind: 'confirm',
          label: cents === undefined ? 'Pay and switch' : `Pay ${dollarsOf(cents)} and switch`,
        },
      };
    case 'billing_page':
      return billingPageLines(to, forfeitWords(preview.forfeits, now, current));
    case 'scheduled': {
      const day = preview.at === undefined ? 'the end of your paid time' : shownDay(preview.at);
      return {
        lines: [
          `Your store moves to ${to} on ${day}. Until then you keep ${current}. From then, ${monthly(cents)}.`,
          ...overWords(preview, to),
        ],
        action: { kind: 'confirm', label: `Move to ${to} on ${day}` },
      };
    }
    case 'now':
      return {
        lines: [
          `Your store moves to ${to} now. Your next payment is ${monthly(cents)}.`,
          ...overWords(preview, to),
        ],
        action: { kind: 'confirm', label: `Move to ${to} now` },
      };
  }
}

function billingPageLines(to: string, forfeit: string[]): SheetLines {
  return {
    lines: [
      `${to} starts when your payment arrives, for a full month.`,
      ...forfeit,
      `On the billing page, choose ${to}, one month.`,
    ],
    action: { kind: 'billing_page' },
  };
}

/** A plan refusal's words where the server sends none (each code of `plan-switch.ts`, `card-upgrade.ts`). */
export const PLAN_REFUSALS: Readonly<Record<string, string>> = {
  change_in_flight: 'A plan change is already on its way: finish or cancel it first.',
  card_not_active: 'Your card subscription is not active: fix it in the billing portal first.',
  invoice_pending: 'Your monthly payment is being taken right now: try again in an hour.',
  card_prices_unchecked: 'Card plan changes are not open just now: try again later.',
  owner_unconfirmed: 'A card plan change opens once the operator has confirmed your access key.',
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
};

/**
 * Why a plan request, its preview, Keep, Check again or Cancel was refused:
 * the server's own words when it sends them (`detail`), else the words of its
 * code, else what any refusal says. `to` and `current` name the plans.
 */
export function planRefusalText(
  body: unknown,
  status: number,
  plans: { to: string; current: string },
): string {
  const code = fieldOf(body, 'error');
  const detail = fieldOf(body, 'detail');
  if (typeof detail === 'string' && detail !== '') {
    return detail;
  }
  if (code === 'pay_for_upgrade') {
    return `Pay for ${plans.to} to move to it: on the billing page choose ${plans.to}, or pay by card.`;
  }
  if (code === 'downgrade_scheduled') {
    return `Keep ${plans.current} first.`;
  }
  return typeof code === 'string' && Object.hasOwn(PLAN_REFUSALS, code)
    ? (PLAN_REFUSALS[code] ?? explainAnswer(body, status))
    : explainAnswer(body, status);
}

/**
 * The sheet's words and action for a change the server refused: the refusal's
 * words, with the way on where there is one (the billing page to pay for the
 * bigger plan; the page where what is over a smaller plan is removed).
 */
export function refusalLines(
  body: unknown,
  status: number,
  plans: { to: string; current: string },
): SheetLines {
  const code = fieldOf(body, 'error');
  if (code === 'pay_on_billing_page') {
    return billingPageLines(plans.to, []);
  }
  const lines = [planRefusalText(body, status, plans)];
  switch (code) {
    case 'pay_for_upgrade':
      return { lines, action: { kind: 'billing_page' } };
    case 'remove_products_first':
      return { lines, action: { kind: 'page', page: 'products', label: 'Go to Products' } };
    case 'remove_own_rpc_first':
      return { lines, action: { kind: 'page', page: 'settings', label: 'Go to Settings' } };
    default:
      return { lines, action: { kind: 'none' } };
  }
}

/** Why the merchant may not change the plan here, in words (plan 2.6). */
export function planReasonText(reason: string | undefined): string {
  return reason === 'partner'
    ? 'Your partner manages your plan.'
    : 'To change this plan, contact elisym.';
}

/** What a card plan request row says (plan 2.6); undefined for one that applied. */
export function requestWords(request: PlanRequestView, names: PlanNames): string | undefined {
  const to = names.name(request.to);
  switch (request.status) {
    case 'charging':
      return 'Your payment is being processed.';
    case 'awaiting_confirmation': {
      const cents = names.cents(request.to);
      const payment =
        cents === undefined ? `the payment for ${to}` : `the payment of ${dollarsOf(cents)}`;
      const by = request.expiresAt === undefined ? '' : ` by ${shownDayTime(request.expiresAt)}`;
      return `Your card needs you to confirm ${payment}${by}. Until then nothing changes.`;
    }
    case 'expired':
      return `The payment for ${to} was not completed in time: nothing changed.`;
    case 'cancelled':
      return `You cancelled the change to ${to}: nothing changed.`;
    case 'failed':
      return `${to} could not be started: nothing changed. Try again.`;
    case 'unknown':
      return 'Your plan change needs us: we will contact you.';
    case 'done':
      return undefined;
  }
}

/** The scheduled downgrade's row: "Moves to Starter on 30 Nov". */
export function scheduledWords(scheduled: PlanScheduleView, names: PlanNames): string {
  return `Moves to ${names.name(scheduled.tier)} on ${shownDay(scheduled.at)}`;
}

/** Why Keep is not open: the server's words, else the code's. */
export function keepRefusalText(scheduled: PlanScheduleView): string | undefined {
  if (scheduled.keepRefusal === undefined) {
    return undefined;
  }
  return scheduled.keepWords ?? 'Keep is not open now: refresh to see where it stands.';
}

/** What a step that applied the change says once it is done. */
export function switchedWords(to: string): string {
  return `Your payment went through: you are on ${to}.`;
}
