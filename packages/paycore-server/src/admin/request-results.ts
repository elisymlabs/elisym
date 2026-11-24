/**
 * A request's result as the merchant sees it (A15): a whitelisted shape, never
 * the raw text the holder recorded. A failure's `problem` (an error message:
 * it may name an operator RPC URL with its key) becomes a fixed `code`; the
 * admin maps codes to its own sentences. The raw text stays in the row, the
 * logs and the operator's alerts.
 */
import { PRODUCT_D_RE } from '@merchant-node/product-rules';
import type { RequestKind } from './requests';

/** The codes a failed or refused request result may carry. */
export const RESULT_CODES = [
  'setup_failed',
  'no_owner_event',
  'bad_request',
  'already_answered',
  'order_paid',
  'no_order',
  'bad_refund_tx',
  'bad_refund_amount',
  'bad_refund_asset',
  'failed',
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

const BOOLEAN_KEYS = [
  'done',
  'rerun',
  'payoutListOut',
  'recorded',
  'restarted',
  'suspending',
  'entered',
] as const;
const COUNT_KEYS = ['taken', 'copyTaken', 'relays'] as const;
/** A request id (`coveredBy`) or an owner event id (`replacedBy`). */
const ID_KEYS = ['coveredBy', 'replacedBy'] as const;
const ID_RE = /^[0-9a-f]{1,64}$/;
const SETUP_VALUES = new Set(['done', 'no_payout_list']);
const LISTING_VALUES = new Set(['out', 'unchanged', 'failed']);
/** What a setup pass names an event it published by: `the payout list`, `products/<d>`, `kind <n>`. */
const EVENT_NAME_RE = /^[A-Za-z0-9 ._/-]{1,80}$/;

/**
 * The hand-answer refusals of `planHandAnswer` (merchant-node `hand.ts`), by
 * their fixed wording: anchored at the start or the end, since the middle may
 * hold the buyer-chosen order id.
 */
const HAND_PROBLEMS: readonly [RegExp, ResultCode][] = [
  [/^not a hand answer$/, 'bad_request'],
  [/^no order .* in the ledger$/su, 'no_order'],
  [/^the refund tx is /, 'bad_refund_tx'],
  [/^the refund amount /, 'bad_refund_amount'],
  [/^the store has several payouts: /, 'bad_refund_asset'],
  [/ is not <buyer>:<orderId>$/, 'bad_request'],
  [/ was already answered as [a-z]+: the other answer is refused$/, 'already_answered'],
  [
    / is paid: the node completes it itself \(a refund of a paid order is not handled here\)$/,
    'order_paid',
  ],
  [/ is refused$|is not an asset this node knows$/, 'bad_refund_asset'],
];

/** The fixed code of a recorded `problem` text. */
export function problemCode(kind: RequestKind, problem: string): ResultCode {
  if (kind === 'hand_answer') {
    return HAND_PROBLEMS.find(([pattern]) => pattern.test(problem))?.[1] ?? 'failed';
  }
  if (kind === 'record_owner_event' && problem === 'no such owner event') {
    return 'no_owner_event';
  }
  return kind === 'setup' || kind === 'record_owner_event' ? 'setup_failed' : 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listingsOf(value: unknown): { d: string; listing: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.d === 'string' &&
    PRODUCT_D_RE.test(entry.d) &&
    typeof entry.listing === 'string' &&
    LISTING_VALUES.has(entry.listing)
      ? [{ d: entry.d, listing: entry.listing }]
      : [],
  );
}

/**
 * The merchant's view of a request result: only known keys of the expected
 * types; a `problem` text becomes its `code`. Null when there is none.
 */
export function merchantResult(kind: RequestKind, result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) {
    return null;
  }
  const view: Record<string, unknown> = {};
  if (typeof result.problem === 'string') {
    view.code = problemCode(kind, result.problem);
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof result[key] === 'boolean') {
      view[key] = result[key];
    }
  }
  for (const key of COUNT_KEYS) {
    const value = result[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      view[key] = value;
    }
  }
  for (const key of ID_KEYS) {
    const value = result[key];
    if (typeof value === 'string' && ID_RE.test(value)) {
      view[key] = value;
    }
  }
  if (typeof result.setup === 'string' && SETUP_VALUES.has(result.setup)) {
    view.setup = result.setup;
  }
  if (typeof result.authorizationOut === 'boolean' || result.authorizationOut === null) {
    view.authorizationOut = result.authorizationOut;
  }
  const listings = listingsOf(result.listings);
  if (listings !== undefined) {
    view.listings = listings;
  }
  if (Array.isArray(result.missedDefaults)) {
    view.missedDefaults = result.missedDefaults.filter(
      (name): name is string => typeof name === 'string' && EVENT_NAME_RE.test(name),
    );
  }
  return Object.keys(view).length === 0 ? null : view;
}
