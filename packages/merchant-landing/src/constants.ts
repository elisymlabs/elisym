/** The product's name, everywhere a page names it. */
export const PRODUCT_NAME = 'Pay Core';

/** The hosted store admin: its own origin, never this page's (it holds the store key). */
export const ADMIN_URL = 'https://admin.elisym.network';

export const DOCS = {
  quickstart: 'https://docs.elisym.network/commerce/quickstart',
  widget: 'https://docs.elisym.network/commerce/widget',
  creditAnAccount: 'https://docs.elisym.network/commerce/credit-an-account',
  cloudAgents: 'https://docs.elisym.network/commerce/cloud-agents',
};

/** The quickstart as plain markdown: what a coding agent reads. */
export const AGENT_DOCS_URL = `${DOCS.quickstart}.md`;

/** What the merchant pastes into a coding agent to set the store up. */
export const AGENT_PROMPT = [
  `Add a Pay Core checkout to my website. Read ${AGENT_DOCS_URL} and follow it step by step:`,
  'create my store node, publish my products, start the node and add the Buy button to my pages.',
  "Before you start, ask me for my store's name, my Solana wallet address and Solana RPC URL, my Tempo wallet address, my wallet address for USDC on Ethereum, Arbitrum and Base with an RPC URL of each of those chains I want, and each product with its name, price and description. I must give a Solana or a Tempo wallet, and may leave any other wallet empty, the one for Ethereum, Arbitrum and Base too: add a payout only for each wallet I give, as the guide says, ask for no Solana RPC URL without a Solana wallet, and list an Ethereum, Arbitrum or Base payout after a Solana or Tempo one.",
  'When you are done, tell me where the store home and its passphrase file are, how to start the node again after a restart, the commands to see my orders and to add a product, and how to make a small test purchase.',
].join(' ');

/** The cloud runbook as plain markdown: what a coding agent reads to set up a cloud store. */
export const CLOUD_AGENT_DOCS_URL = `${DOCS.cloudAgents}.md`;

/** What the merchant pastes into a coding agent to set up a store in our cloud. */
export const CLOUD_AGENT_PROMPT = [
  `Set up my Pay Core store in elisym Cloud. Read ${CLOUD_AGENT_DOCS_URL} and follow it step by step.`,
  "Make my owner key and save it to a file for me, let me pick a plan, and sign up only after I agree to the terms. Give me the payment link, then ask me for my store's name, the wallets I want to be paid to and my products.",
  'When the store is live, give me the Buy button snippet for my page and tell me where my key file is.',
].join(' ');

/** Makes a mainnet store: its home, a product to edit, and its keys. */
export const INIT_COMMAND = 'npx @elisym/merchant-node init --network mainnet';

/** Serves the store admin on the merchant's own machine. */
export const LOCAL_ADMIN_COMMAND = 'npx @elisym/merchant-node admin';

export const GITHUB_URL = 'https://github.com/elisymlabs/elisym';
export const X_URL = 'https://x.com/elisymlabs';
export const ELISYM_URL = 'https://elisym.network';

export interface DemoProduct {
  /** The product's `naddr1...`. It must sell on this page's origin: a store no domain vouches for (level C). */
  product: string;
  network: 'mainnet' | 'devnet';
  /** What the wallet is asked for, as shown next to the button. */
  price: string;
}

/** The live demo's product; without one the demo shows the snippet only. */
export const DEMO_PRODUCT: DemoProduct | undefined = undefined;

/**
 * The cloud console: its own origin, never this page's (it makes the owner key).
 * The landing only links to it; it holds no session and sends nothing.
 */
export const CLOUD_CONSOLE_URL = 'https://cloud.elisym.network';

/** Where Enterprise and White-label merchants reach us (operator-provisioned, no self-serve start). */
export const CONTACT_URL = X_URL;

/**
 * A plan as the pricing section shows it: a hand copy of cloud-api's tier
 * catalog (ids, names, prices, limits and display strings), which a test in
 * the cloud repo compares with the catalog it ships.
 */
export interface CloudTier {
  /** The catalog's tier id: the console's `/start?tier=` takes it for a self-serve tier. */
  id: string;
  name: string;
  audience: string;
  /** As the catalog writes it ("$29/mo", "from $499/mo", "Let's talk"). */
  price: string;
  limits: { products: number; ordersPerMonth?: number };
  /** Shown instead of a limit's number ("No cap"). */
  display: { products?: string; ordersPerMonth?: string };
  features: string[];
  /** Self-serve: a Start link to the console. Otherwise "Contact us". */
  selfServe: boolean;
  /** The plan the section points at. */
  highlighted?: boolean;
}

export const CLOUD_TIERS: CloudTier[] = [
  {
    id: 'starter',
    name: 'Starter',
    audience: 'For a first store',
    price: '$29/mo',
    limits: { products: 100, ordersPerMonth: 2000 },
    display: {},
    features: [
      'Solana, Base, Arbitrum, Ethereum and Tempo',
      'Signed order webhooks to your backend',
      'Monthly, by card or stablecoins',
    ],
    selfServe: true,
  },
  {
    id: 'business',
    name: 'Business',
    audience: 'For a store with steady sales',
    price: '$99/mo',
    limits: { products: 1000 },
    display: { ordersPerMonth: 'No cap' },
    features: ['Everything in Starter', 'Your own RPC on any network, if you want one'],
    selfServe: true,
    highlighted: true,
  },
  {
    id: 'high-risk',
    name: 'Enterprise',
    audience: 'For deposits matched to player or customer accounts',
    price: 'from $499/mo',
    limits: { products: 1200 },
    display: { products: 'No cap', ordersPerMonth: 'No cap' },
    features: [
      'Each deposit matched to an account, for your backend to credit',
      'Deposits only: no payouts to players',
      'Reviewed before launch',
    ],
    selfServe: false,
  },
  {
    id: 'white-label',
    name: 'White-label',
    audience: 'For platforms that onboard merchants',
    price: "Let's talk",
    limits: { products: 1200 },
    display: { products: 'No cap', ordersPerMonth: 'No cap' },
    features: [
      'Priced by the number of stores you run',
      'Checkout on your own domain',
      'Your brand, no "by Elisym"',
      'Optionally, a dedicated relay for your stores',
    ],
    selfServe: false,
  },
];

/** A tier's Start link: the console's own page, which makes the key and takes the first payment. */
export function cloudStartUrl(tier: string): string {
  return `${CLOUD_CONSOLE_URL}/start?tier=${tier}`;
}
