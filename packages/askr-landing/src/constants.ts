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

export const GITHUB_URL = 'https://github.com/elisymlabs/elisym';
export const X_URL = 'https://x.com/elisymlabs';
export const ELISYM_URL = 'https://elisym.network';
