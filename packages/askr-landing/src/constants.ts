/** The product's name, everywhere a page names it. */
export const PRODUCT_NAME = 'Askr';

/** The Askr server: it serves the widget, the chat sessions and the admin. */
export const API_ORIGIN = 'https://api.askr.elisym.network';

/** The merchant admin: its own origin, never this page's (it holds the owner key). */
export const ADMIN_URL = `${API_ORIGIN}/admin/`;

/** The script a store's pages load. */
export const WIDGET_SRC = `${API_ORIGIN}/widget.js`;

export const DOCS = {
  overview: 'https://docs.elisym.network/askr/overview',
  embed: 'https://docs.elisym.network/askr/embed',
  catalogFromAnAgent: 'https://docs.elisym.network/askr/catalog-from-an-agent',
};

/** Gives an agent a catalog key for one store; prints only the key's npub. */
export const ASKR_KEY_COMMAND = 'npx @elisym/cli askr-key my-agent --store npub1...';

/** The MCP tools an agent with a catalog key has, with what each one does. */
export const MCP_TOOLS: readonly { name: string; body: string }[] = [
  {
    name: 'askr_upsert_products',
    body: 'Publishes or updates the given products and leaves every other one as it is.',
  },
  { name: 'askr_hide_products', body: 'Hides products by their ids.' },
  {
    name: 'askr_preview_diff',
    body: 'Reports what would be created, updated and hidden. Publishes nothing.',
  },
  {
    name: 'askr_set_policy',
    body: 'Publishes a policy the assistant can quote: returns, shipping, warranty or FAQ.',
  },
];

/**
 * What the default model did on the Askr evals (`packages/askr-agent/evals`),
 * rounded for the page: 90 scenarios, 95.6% passed, about $0.0013 per passing
 * conversation. The cost is shown only as "a fraction of a cent".
 */
export const EVALS = {
  scenarios: '90',
  passed: '95.6%',
};

export interface Plan {
  name: string;
  /** The monthly price as shown, or `undefined` for a plan priced per store. */
  price: string | undefined;
  blurb: string;
  features: readonly string[];
  /** Free starts in the admin; every other plan is set up with us. */
  start: 'admin' | 'contact';
  featured: boolean;
}

/**
 * TEST VALUES: prices and limits are placeholders until the tiers are decided.
 * Replace them here; nothing else on the page restates them.
 */
export const PLANS: readonly Plan[] = [
  {
    name: 'Free',
    price: '$0',
    blurb: 'Try it on your own site.',
    features: [
      '100 conversations a month',
      'Up to 100 products',
      'CSV import and the admin editor',
      `The "by ${PRODUCT_NAME}" label`,
    ],
    start: 'admin',
    featured: false,
  },
  {
    name: 'Starter',
    price: '$29',
    blurb: 'For a small store with steady traffic.',
    features: [
      '1,000 conversations a month',
      'Up to 1,000 products',
      'Every product source',
      'Connectors sync daily',
    ],
    start: 'contact',
    featured: false,
  },
  {
    name: 'Growth',
    price: '$99',
    blurb: 'For a store that sells every day.',
    features: [
      '5,000 conversations a month',
      'Up to 10,000 products',
      'Connectors sync hourly',
      `Remove the "by ${PRODUCT_NAME}" label`,
    ],
    start: 'contact',
    featured: true,
  },
  {
    name: 'Scale',
    price: '$499',
    blurb: 'For a large catalog and heavy traffic.',
    features: [
      '30,000 conversations a month',
      'Up to 100,000 products',
      'Connectors sync every 15 minutes',
      'Priority support',
    ],
    start: 'contact',
    featured: false,
  },
  {
    name: 'Enterprise',
    price: undefined,
    blurb: 'For big stores and store groups.',
    features: [
      'Limits set for your traffic',
      'Several stores under one plan',
      'A direct line to the team',
      'Help with your catalog setup',
    ],
    start: 'contact',
    featured: false,
  },
];

export const GITHUB_URL = 'https://github.com/elisymlabs/elisym';
export const X_URL = 'https://x.com/elisymlabs';
export const ELISYM_URL = 'https://elisym.network';
