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
      return 'Card payment opens once the operator has confirmed your owner key.';
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

/** A Checkout or Portal URL from cloud-api, if it is one: https on Stripe's own hosts. */
export function stripeSessionUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  return url.protocol === 'https:' && STRIPE_HOSTS.includes(url.hostname) && url.username === ''
    ? url.href
    : undefined;
}

/** The billing page's link for this store (Pay Core, `customer_ref` = the store's id). */
export function billingPageUrl(billingUrl: string, tenantId: string): string {
  const url = new URL(billingUrl);
  url.searchParams.set('customer_ref', tenantId);
  return url.href;
}
