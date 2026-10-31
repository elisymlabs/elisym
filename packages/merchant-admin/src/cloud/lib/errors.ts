import { fieldOf } from './fields';

/** What the merchant reads for a cloud-api refusal (by its code); anything else names the code. */
const EXPLAINED: Record<string, string> = {
  invalid_invite: 'That invite is not valid: it may be mistyped, used already, or expired.',
  already_activated: 'That store is already activated: its owner key cannot change here.',
  key_owns_a_store:
    'This key already owns a store in elisym Cloud. One key per store: create a new key for this one.',
  forbidden: 'This key cannot be used here.',
  key_is_a_partner:
    'This key is already a partner key. One key per account: create a new key for this one.',
  terms_not_accepted: 'The terms changed meanwhile: read them and accept them again.',
  unreachable: 'Could not reach elisym Cloud: check your connection and try again.',
  bad_tier: 'That plan cannot be bought here.',
  over_limit: 'Your plan takes fewer products: remove some, or contact us to move up.',
  not_on_plan: 'Your plan runs on our RPCs: an own RPC needs a plan that takes one (contact us).',
  rate_limited: 'Too many attempts from your network: try again in an hour.',
  stale: 'Your clock and the server disagree too far: check your device time.',
  not_paid: 'Pay for the store first: it is on sale only while its paid time runs.',
  store_not_set_up: 'Set up the store first: its settings, products and payout list.',
  home_not_ready: 'The store is still being made: try again in a minute.',
  cycle_pending: 'A change to the store is still being applied: try again in a minute.',
  held: 'The store is on hold: contact elisym.',
  operator_activates:
    'The operator activates this store, after confirming your owner key with you.',
  tenant_gone: 'This store was handed over or destroyed.',
  stripe_unavailable: 'Card payments could not be reached just now: try again shortly.',
  card_not_set_up: 'Card payments are not available.',
  no_card_customer: 'There is no card subscription to manage yet.',
  stripe_refused: 'Stripe refused the request: try again, or contact elisym.',
  owner_mismatch: 'This key is no longer the store owner: sign in with the owner key.',
  // A rail that closed since the page was loaded (the view reloads with the reason).
  card_from: 'Your paid time runs for a while yet: switch to card closer to its end.',
  card_subscription_live: 'Your card subscription is running: manage it in the billing portal.',
  card_status_unknown: 'The card subscription could not be read just now: try again shortly.',
  payment_window_closed: 'Payments for this store are closed.',
  no_card_for_tier: 'This plan cannot be paid by card.',
  owner_unconfirmed: 'Card payment opens once the operator has confirmed your owner key.',
  card_subscription_items: 'Your card subscription needs the operator: contact elisym.',
  store_first: 'Save the store settings first: the payouts are signed for them.',
  no_store_key: 'The store key is still being made: try again in a minute.',
  not_activated: 'The store is not activated yet.',
  orders_busy: 'The orders are being read: try again in a moment.',
  ledger_unreadable: 'The orders cannot be read right now: elisym has been told. Try again later.',
  commands_queued: 'Earlier commands are still waiting: try again once they ran.',
  bad_command: 'The store cannot take that command as written.',
  already_withdrawn: 'The store is off sale already.',
  not_withdrawn: 'The store is on sale already.',
  not_resumed: 'The store cannot be resumed now: refresh to see where it stands.',
  resume_unavailable: 'Resume cannot run right now: elisym has been told. Try again later.',
  billing_tenant: 'This store takes elisym Cloud payments: it is never taken off sale.',
  handover_pending: 'The handover is still being packed: try again in a minute.',
  not_exported: 'The store is not exported.',
  archive_missing: 'The handover archive is gone: contact elisym.',
  busy: 'The store is busy: try again in a minute.',
  exporting: 'The store is being exported.',
};

export function explain(code: unknown, status: number): string {
  const explained =
    typeof code === 'string' && Object.hasOwn(EXPLAINED, code) ? EXPLAINED[code] : undefined;
  if (explained !== undefined) {
    return explained;
  }
  return typeof code === 'string'
    ? `The cloud refused it (${code}).`
    : `The cloud did not answer as expected (HTTP ${status}).`;
}

/** What an answer says: the domain check's own reason when there is one, else `explain`. */
export function explainAnswer(body: unknown, status: number): string {
  const code = fieldOf(body, 'error');
  const detail = fieldOf(body, 'detail');
  if (code === 'domain_check' && typeof detail === 'string') {
    return `The domain check failed: ${detail}`;
  }
  return explain(code, status);
}
