/**
 * The payment rails as the merchant reads them (plan section 4b): what each
 * refusal means, and where the console may send the merchant to pay.
 */
import { type RailRefusal, shownTime } from './store-view';

/** Why the card (Stripe) step is not open, in the merchant's words. */
export function cardRefusalText(refusal: RailRefusal): string {
  switch (refusal.code) {
    case 'rail_off':
      return 'Card payments are not available.';
    case 'no_card_for_tier':
      return 'This plan cannot be paid by card.';
    case 'payment_window_closed':
      return 'Payments for this store are closed.';
    case 'card_from':
      return refusal.from === undefined
        ? 'Your paid time runs for a while yet: switch to card closer to its end.'
        : `Your paid time runs for a while yet: switch to card from ${shownTime(refusal.from)}.`;
    case 'card_subscription_live':
      return 'Your card subscription is running: manage it in the billing portal.';
    case 'card_status_unknown':
      return 'The card subscription could not be read just now: try again shortly.';
    case 'owner_unconfirmed':
      return 'Card payment opens once the operator has confirmed your access key.';
    case 'tenant_gone':
      return 'This store was handed over or destroyed.';
    case 'card_subscription_items':
      return 'Your card subscription needs the operator: contact elisym.';
    default:
      return `Card payment is not open (${refusal.code}).`;
  }
}

/** Why the crypto (Pay Core) step is not open, in the merchant's words. */
export function cryptoRefusalText(refusal: RailRefusal): string {
  switch (refusal.code) {
    case 'rail_off':
      return 'Crypto payments are not available.';
    case 'payment_window_closed':
      return 'Payments for this store are closed.';
    case 'card_subscription_live':
      return 'A card subscription is running: set it to end in the billing portal before paying by crypto.';
    case 'card_status_unknown':
      return 'The card subscription could not be read just now: try again shortly.';
    case 'tenant_gone':
      return 'This store was handed over or destroyed.';
    default:
      return `Crypto payment is not open (${refusal.code}).`;
  }
}

/** Stripe's hosts a Checkout or Portal session lives on: the console navigates nowhere else. */
const STRIPE_HOSTS = ['checkout.stripe.com', 'billing.stripe.com'];
/** The host of an invoice's hosted page (a card plan change waiting for the merchant to pay it). */
const STRIPE_INVOICE_HOST = 'invoice.stripe.com';

/** `value` when it is an https URL on one of `hosts`, with no credentials in it. */
function httpsOn(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  return url.protocol === 'https:' &&
    hosts.includes(url.hostname) &&
    url.username === '' &&
    url.password === ''
    ? url.href
    : undefined;
}

/** A Checkout or Portal URL from cloud-api, if it is one: https on Stripe's own hosts. */
export function stripeSessionUrl(value: unknown): string | undefined {
  return httpsOn(value, STRIPE_HOSTS);
}

/**
 * A plan request's `payUrl` from cloud-api, if it is one: https on Stripe's
 * invoice host only. It is linked as given, never built here.
 */
export function stripeInvoiceUrl(value: unknown): string | undefined {
  return httpsOn(value, [STRIPE_INVOICE_HOST]);
}

/**
 * The billing page's link for this store (Pay Core): `customer_ref` is the
 * owner-bound reference the store view carries (a payment through it may
 * change the plan), else the store's id (a plain id only adds time).
 */
export function billingPageUrl(
  billingUrl: string,
  tenantId: string,
  billingRef: string | undefined,
): string {
  const url = new URL(billingUrl);
  url.searchParams.set('customer_ref', billingRef ?? tenantId);
  return url.href;
}
