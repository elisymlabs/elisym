/** The hosted store admin: its own origin, never this page's (it holds the store key). */
export const ADMIN_URL = 'https://admin.elisym.network';

export const DOCS = {
  quickstart: 'https://docs.elisym.network/commerce/quickstart',
  widget: 'https://docs.elisym.network/commerce/widget',
  creditAnAccount: 'https://docs.elisym.network/commerce/credit-an-account',
};

/** Makes a mainnet store: its home, a product to edit, and its keys. */
export const INIT_COMMAND = 'npx @elisym/merchant-node init --network mainnet';

/** Serves the store admin on the merchant's own machine. */
export const LOCAL_ADMIN_COMMAND = 'npx @elisym/merchant-node admin';

export const GITHUB_URL = 'https://github.com/elisymlabs/elisym';
export const X_URL = 'https://x.com/elisymlabs';

export interface DemoProduct {
  /** The product's `naddr1...`. It must sell on this page's origin: a store no domain vouches for (level C). */
  product: string;
  network: 'mainnet' | 'devnet';
  /** What the wallet is asked for, as shown next to the button. */
  price: string;
}

/** The live demo's product; without one the demo shows the snippet only. */
export const DEMO_PRODUCT: DemoProduct | undefined = undefined;
