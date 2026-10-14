/** The product's name, everywhere a page names it. */
export const PRODUCT_NAME = 'Pay Core';

/** The hosted store admin: its own origin, never this page's (it holds the store key). */
export const ADMIN_URL = 'https://admin.elisym.network';

export const DOCS = {
  quickstart: 'https://docs.elisym.network/commerce/quickstart',
  widget: 'https://docs.elisym.network/commerce/widget',
  creditAnAccount: 'https://docs.elisym.network/commerce/credit-an-account',
};

/** The quickstart as plain markdown: what a coding agent reads. */
export const AGENT_DOCS_URL = `${DOCS.quickstart}.md`;

/** What the merchant pastes into a coding agent to set the store up. */
export const AGENT_PROMPT = [
  `Add a Pay Core checkout to my website. Read ${AGENT_DOCS_URL} and follow it step by step:`,
  'create my store node, publish my products, start the node and add the Buy button to my pages.',
  "Before you start, ask me for my store's name, my Solana wallet address, my Solana RPC URL, my Tempo wallet address if I also want USDC.e payments on Tempo (then add the Tempo payout as the guide says), and each product with its name, price and description.",
  'When you are done, tell me where the store home and its passphrase file are, how to start the node again after a restart, the commands to see my orders and to add a product, and how to make a small test purchase.',
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
