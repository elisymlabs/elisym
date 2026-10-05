/** The states the checkout reports through `elisym-status` (the v3 loader's list). */
export const CHECKOUT_STATES = [
  'ready',
  'ordered',
  'paying',
  'paid',
  'completed',
  'refunded',
  'ended',
  'refused',
] as const;

export type CheckoutState = (typeof CHECKOUT_STATES)[number];

export function isCheckoutState(value: unknown): value is CheckoutState {
  return CHECKOUT_STATES.some((state) => state === value);
}
