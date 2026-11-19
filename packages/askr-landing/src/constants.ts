/** The product's name, everywhere a page names it. */
export const PRODUCT_NAME = 'Askr';

/** The Askr server: it serves the widget, the chat sessions and the admin. */
export const API_ORIGIN = 'https://app.askr.elisym.network';

/** The merchant admin: its own origin, never this page's (it holds the store's secret key). */
export const ADMIN_URL = `${API_ORIGIN}/admin/`;

/** The script a store's pages load. */
export const WIDGET_SRC = `${API_ORIGIN}/widget.js`;

export const DOCS = {
  overview: 'https://docs.elisym.network/askr/overview',
  embed: 'https://docs.elisym.network/askr/embed',
  catalogFromAnAgent: 'https://docs.elisym.network/askr/catalog-from-an-agent',
};

/** What a plan costs, as shown: every amount written out, no arithmetic on the page. */
export type PlanPrice =
  | {
      kind: 'flat';
      /** Billed monthly, per month. */
      monthly: string;
      /** Billed yearly: the price per month, and the total billed once a year. */
      yearlyPerMonth: string;
      yearlyTotal: string;
    }
  | {
      /** Priced by contract, from this much a month; the billing switch does not apply. */
      kind: 'from';
      monthly: string;
    };

export interface Plan {
  name: string;
  price: PlanPrice;
  blurb: string;
  features: readonly string[];
  /** Free starts in the admin, Enterprise is a conversation, the rest are set up with us. */
  start: 'admin' | 'choose' | 'contact';
  featured: boolean;
  /**
   * Plans sharing a group are one card with a size switch, in table order; the featured one is
   * shown first.
   */
  group?: 'sizes';
}

/** What paying yearly takes off the monthly price, in basis points (2000 = 20%). */
export const YEARLY_DISCOUNT_BPS = 2000;

/** The same discount as the page writes it; a test keeps it equal to `YEARLY_DISCOUNT_BPS`. */
export const YEARLY_DISCOUNT_LABEL = '20%';

/** A plan with a flat price, billed monthly or yearly. */
export type FlatPlan = Plan & { price: Extract<PlanPrice, { kind: 'flat' }> };

/** A plan priced by contract, from a floor. */
export type ContractPlan = Plan & { price: Extract<PlanPrice, { kind: 'from' }> };

export function isFlatPlan(plan: Plan): plan is FlatPlan {
  return plan.price.kind === 'flat';
}

export function isContractPlan(plan: Plan): plan is ContractPlan {
  return plan.price.kind === 'from';
}

/** How a conversation is counted, as the pricing's small print says it. */
export const CONVERSATION_DEFINITION =
  "A conversation is one visitor's chat, up to 24 hours from their first message, that got at least one answer.";

const POWERED_BY = `Shows "Powered by ${PRODUCT_NAME}"`;
const NO_BRANDING = `"Powered by ${PRODUCT_NAME}" can be removed`;
const SITES = 'Up to 20 sites';

/**
 * The plans, in one table to edit: change them here, nothing else on the page restates them.
 * Conversations are approximate: each plan has a monthly spend cap, and heavy use pauses the
 * chat rather than cost more. Up to 20 sites is the protocol's `LIMITS.MAX_ORIGINS`.
 */
export const PLANS: readonly Plan[] = [
  {
    name: 'Free',
    price: { kind: 'flat', monthly: '$0', yearlyPerMonth: '$0', yearlyTotal: '$0' },
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
    price: { kind: 'flat', monthly: '$29', yearlyPerMonth: '$23', yearlyTotal: '$276' },
    blurb: 'For a small store getting going.',
    features: [
      'About 500 conversations a month',
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
    price: { kind: 'flat', monthly: '$99', yearlyPerMonth: '$79', yearlyTotal: '$948' },
    blurb: 'For a store that sells every day.',
    features: [
      'About 2,000 conversations a month',
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
    price: { kind: 'flat', monthly: '$199', yearlyPerMonth: '$159', yearlyTotal: '$1,908' },
    blurb: 'For a busy store with a big catalog.',
    features: [
      'About 6,000 conversations a month',
      'Up to 10,000 products',
      'Syncs every 30 minutes',
      NO_BRANDING,
      SITES,
    ],
    start: 'choose',
    featured: false,
    group: 'sizes',
  },
  {
    name: 'Scale',
    price: { kind: 'flat', monthly: '$499', yearlyPerMonth: '$399', yearlyTotal: '$4,788' },
    blurb: 'For heavy traffic and large catalogs.',
    features: [
      'About 15,000 conversations a month',
      'Up to 20,000 products',
      'Syncs every 15 minutes',
      NO_BRANDING,
      SITES,
    ],
    start: 'choose',
    featured: false,
    group: 'sizes',
  },
  {
    name: 'Enterprise',
    price: { kind: 'from', monthly: '$1,500' },
    blurb: 'For large stores and store groups.',
    features: [
      'From 25,000 conversations a month',
      'Catalog size and sync by agreement',
      'An SLA',
      NO_BRANDING,
    ],
    start: 'contact',
    featured: false,
  },
];

/**
 * The page's main call to action. It promises a free start, so it holds only while the first
 * plan is free (a test checks it).
 */
export const START_LABEL = 'Start free';

export const GITHUB_URL = 'https://github.com/elisymlabs/elisym';
export const X_URL = 'https://x.com/elisymlabs';

/** Where a store asks for a paid plan or Enterprise: our Telegram. */
export const CONTACT_URL = 'https://t.me/new_acc_nata';
export const ELISYM_URL = 'https://elisym.network';
