/**
 * The plans the Billing tab shows: names, order, prices, what each includes and how each
 * starts, as the landing's `PLANS` (`packages/askr-landing/src/constants.ts`), which the admin
 * does not import. A test keeps the two equal. Every amount is written out: no arithmetic.
 */
export interface PlanChoice {
  name: string;
  /** The monthly price as the landing writes it, e.g. `$29`. */
  monthly: string;
  /** Billed yearly: the price a month and the total once a year (flat plans only). */
  yearlyPerMonth?: string;
  yearlyTotal?: string;
  /** One line under the name. */
  blurb: string;
  /** What the plan includes, as the landing lists it. */
  features: readonly string[];
  /** `admin`: self-serve here (Free); `choose`: a paid plan (checkout, or through us); `contact`: by agreement. */
  start: 'admin' | 'choose' | 'contact';
  /** The landing marks it "Most popular". */
  featured: boolean;
  /** The landing shows the `sizes` plans as one card with a size switch. */
  group?: 'sizes';
  /** The price is a floor ("from $1,500"), not a list price. */
  from?: boolean;
}

/** What paying yearly takes off, as the landing writes it (its `YEARLY_DISCOUNT_LABEL`). */
export const YEARLY_DISCOUNT_LABEL = '20%';

const POWERED_BY = 'Shows "Powered by Askr"';
const NO_BRANDING = '"Powered by Askr" can be removed';
const SITES = 'Up to 20 sites';

export const PLANS: readonly PlanChoice[] = [
  {
    name: 'Free',
    monthly: '$0',
    yearlyPerMonth: '$0',
    yearlyTotal: '$0',
    blurb: 'Try it on your own store.',
    features: [
      'About 50 conversations a month',
      'Up to 100 products',
      'Syncs with your shop once a day',
      POWERED_BY,
      SITES,
    ],
    start: 'admin',
    featured: false,
  },
  {
    name: 'Starter',
    monthly: '$29',
    yearlyPerMonth: '$23',
    yearlyTotal: '$276',
    blurb: 'For a small store getting going.',
    features: [
      'About 250 conversations a month',
      'Up to 1,000 products',
      'Syncs every 6 hours',
      POWERED_BY,
      SITES,
    ],
    start: 'choose',
    featured: false,
  },
  {
    name: 'Growth',
    monthly: '$99',
    yearlyPerMonth: '$79',
    yearlyTotal: '$948',
    blurb: 'For a store that sells every day.',
    features: [
      'About 1,000 conversations a month',
      'Up to 5,000 products',
      'Syncs every hour',
      POWERED_BY,
      SITES,
    ],
    start: 'choose',
    featured: true,
    group: 'sizes',
  },
  {
    name: 'Pro',
    monthly: '$199',
    yearlyPerMonth: '$159',
    yearlyTotal: '$1,908',
    blurb: 'For a busy store with a big catalog.',
    features: [
      'About 1,900 conversations a month',
      'Up to 10,000 products',
      'Syncs every 30 minutes',
      POWERED_BY,
      SITES,
    ],
    start: 'choose',
    featured: false,
    group: 'sizes',
  },
  {
    name: 'Scale',
    monthly: '$499',
    yearlyPerMonth: '$399',
    yearlyTotal: '$4,788',
    blurb: 'For heavy traffic and large catalogs.',
    features: [
      'About 5,000 conversations a month',
      'Up to 20,000 products',
      'Syncs every 15 minutes',
      POWERED_BY,
      SITES,
    ],
    start: 'choose',
    featured: false,
    group: 'sizes',
  },
  {
    name: 'Enterprise',
    monthly: '$1,500',
    blurb: 'For large stores and store groups.',
    features: [
      'From 15,000 conversations a month',
      'Catalog size and sync by agreement',
      'An SLA',
      NO_BRANDING,
    ],
    start: 'contact',
    featured: false,
    from: true,
  },
];
