/**
 * The plans the picker shows (6.5): names, order, monthly prices and how each
 * starts, as the landing's `PLANS` (`packages/askr-landing/src/constants.ts`),
 * which the admin cannot import. A test keeps the two equal.
 */
export interface PlanChoice {
  name: string;
  /** The monthly price as the landing writes it, e.g. `$29`. */
  monthly: string;
  /** `admin`: self-serve here (Free); `choose`: a paid plan through us; `contact`: by agreement. */
  start: 'admin' | 'choose' | 'contact';
  /** The landing shows the `sizes` plans as one card with a size switch. */
  group?: 'sizes';
  /** The price is a floor ("from $1,500"), not a list price. */
  from?: boolean;
}

export const PLANS: readonly PlanChoice[] = [
  { name: 'Free', monthly: '$0', start: 'admin' },
  { name: 'Starter', monthly: '$29', start: 'choose' },
  { name: 'Growth', monthly: '$99', start: 'choose', group: 'sizes' },
  { name: 'Pro', monthly: '$199', start: 'choose', group: 'sizes' },
  { name: 'Scale', monthly: '$499', start: 'choose', group: 'sizes' },
  { name: 'Enterprise', monthly: '$1,500', start: 'contact', from: true },
];
