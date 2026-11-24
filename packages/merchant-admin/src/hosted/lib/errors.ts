/**
 * What the merchant reads when something fails: fixed sentences by code
 * (A15). No text the server sent is ever shown: an unknown code, alert kind
 * or request result gets the generic sentence.
 */
import { ApiError } from './api';

export const GENERIC_ERROR = 'Something went wrong. Retry in a moment.';
export const GENERIC_REQUEST_FAILURE = 'The change could not be applied. Retry, or message us.';

/** Why the server refused an authorization (`paycore-server/src/admin/nip98.ts`, plus replay). */
const UNAUTHORIZED_REASONS: Readonly<Record<string, string>> = {
  missing: 'The request was not signed. Sign in again and retry.',
  malformed: 'The request signature could not be read. Sign in again and retry.',
  signature: 'The request signature is not valid. Sign in again and retry.',
  stale:
    "Your computer's clock is off by more than a minute, so the server did not accept the request. Set the clock to the correct time and retry.",
  url: 'The request was signed for another address than this server. Reload the page and retry.',
  method: 'The request was signed for another action. Retry.',
  payload: 'The request content does not match its signature. Retry.',
  replay: 'This exact request was already sent once. Retry.',
};

/** The server's refusal codes (`paycore-server/src/admin/api.ts`, `state/stores.ts`, `owner-events.ts`). */
const CODES: Readonly<Record<string, string>> = {
  network: 'The PayCore server could not be reached. Check your connection and retry.',
  unexpected: 'The PayCore server gave an unexpected answer. Retry in a moment.',
  no_store: 'There is no store for this owner key yet.',
  not_found: 'That was not found. Refresh and retry.',
  bad_request: 'The server could not read the request. Check the fields and retry.',
  rate_limited: 'Too many new stores from this address. Try again in an hour.',
  suspended: 'Your store is suspended or being suspended: it takes no more changes.',
  inactive: 'Your store is not active, so this cannot be done now.',
  product_cap: 'Your store has as many products on sale as its plan allows.',
  bad_product: 'Some product fields are not valid. Check them and retry.',
  bad_price: 'A price is not valid. Enter a USD amount above 0, such as 49 or 0.50.',
  bad_config: 'Some settings are not valid. Check them and retry.',
  stale_config:
    'Your settings were changed elsewhere since this page read them. Refresh to see them, then make your change again.',
  no_payouts: 'Add a payout address and save your settings first.',
  unsigned_payout: 'A payout address has no wallet signature. Sign it with its wallet first.',
  bad_payouts:
    'Your saved payouts cannot be published as a payout list. Check each address and its wallet signature, save them again, then retry.',
  no_draft: 'The change to sign expired. Retry.',
  expired: 'The change to sign expired. Retry.',
  mismatch: 'The change you signed is no longer the one waiting. Retry.',
  stale: 'A newer signed change is already published. Refresh and retry.',
  clock: "Your computer's clock is off. Set it to the correct time and retry.",
  malformed: 'The signed change could not be read. Retry.',
  signature: 'The signed change is not signed by this owner key. Sign in again and retry.',
  author: 'The signed change is not signed by this owner key. Sign in again and retry.',
};

/** Open alert kinds (`paycore-server/src/alerts.ts`), as the merchant reads them. */
const ALERTS: Readonly<Record<string, string>> = {
  start_refused:
    'Your store could not start with its current settings. Check your payouts, products and webhook.',
  start_failed: 'Your store failed to start several times. We are looking into it.',
  node_stopped: 'Your store stopped. We are looking into it.',
  offer_mismatch:
    'What buyers see on the relays differs from your store. Publish your payout list again.',
  rail_unavailable: 'One of your payout coins cannot be paid right now. The others still work.',
  webhook_secret_missing:
    'Your webhook has no secret, so nothing is sent to it. Generate a secret in Settings.',
  drift: 'The relays serve a store profile or payout list this server did not make.',
  setup_failed: 'A change to your store could not be applied. Retry it, or message us.',
  inbox_relays_refused: 'Some of your inbox relays are not allowed. Choose them again in Settings.',
};

/** What a failed request's whitelisted `{ code }` means (`paycore-server/src/admin/request-results.ts`). */
const REQUEST_RESULTS: Readonly<Record<string, string>> = {
  setup_failed: 'Your store could not apply the change. Retry, or message us if this stays.',
  no_owner_event: 'The signed change was not found on the server. Sign it again.',
  bad_request: 'The server could not read the request. Check the fields and retry.',
  already_answered: 'This order was already answered by hand.',
  order_paid: 'This order is paid: your store completes it itself.',
  no_order: 'This order is not in your store.',
  bad_refund_tx: 'The refund transaction is not valid. Check it and retry.',
  bad_refund_amount: 'The refund amount is not valid. Check it and retry.',
  bad_refund_asset: 'Choose the coin the refund was paid in.',
  failed: GENERIC_REQUEST_FAILURE,
};

export const GENERIC_ALERT = 'Your store needs attention. Message us if this stays.';

/** The table's own sentence for `key`: never one inherited (`constructor`, `__proto__`). */
function sentence(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A plain sentence for any error hosted mode shows: never a text the server sent. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return GENERIC_ERROR;
  }
  if (error.code === 'unauthorized') {
    return (
      sentence(UNAUTHORIZED_REASONS, error.reason ?? '') ??
      'The server did not accept your signature. Sign in again and retry.'
    );
  }
  return sentence(CODES, error.code) ?? GENERIC_ERROR;
}

/** One open alert kind, in a sentence. */
export function alertMessage(kind: string): string {
  return sentence(ALERTS, kind) ?? GENERIC_ALERT;
}

/** A failed request's outcome, in a sentence. */
export function requestFailureMessage(result: unknown): string {
  const code =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'code') : undefined;
  return typeof code === 'string'
    ? (sentence(REQUEST_RESULTS, code) ?? GENERIC_REQUEST_FAILURE)
    : GENERIC_REQUEST_FAILURE;
}
