import { LIMITS } from '@elisym/askr';
import { ADMIN_DOCS_URL } from '../constants';

/** What an info button says about a field or a group, and where the guide says more. */
export interface Help {
  text: string;
  /** The heading of the guide's section on it, as the guide's link anchor. */
  anchor: string;
}

/** The guide's page for this section. */
export function helpUrl(help: Help): string {
  return `${ADMIN_DOCS_URL}#${help.anchor}`;
}

/**
 * Every info button in the admin. Each anchor is a heading of the admin guide
 * (`packages/docs/pages/askr/admin.mdx`): a test keeps the two in step.
 */
export const HELP = {
  // Overview
  status: {
    text: 'Pending: not live yet; choose a plan in Billing (Free starts at once, a paid plan once it is paid for or set up with us), or message us if we manage your plan. Active: it answers on your sites. Suspended: it does not answer; contact the operator.',
    anchor: 'status',
  },
  usage: {
    text: 'What the assistant spent against your plan this month, in US dollars. When the month’s budget runs out the chat says it is unavailable until the next month, or until you upgrade your plan. Conversations are visitors’ chats that got at least one answer.',
    anchor: 'usage',
  },
  productClicks: {
    text: 'For each product: how often a visitor opened its page from a card in the chat, and how often they pressed its add to cart button. Counted as the visitor’s browser reports them, so take them as a guide.',
    anchor: 'product-clicks',
  },
  activity: {
    text: 'What the chat did each day over the last 30 days: conversations started, questions answered, product pages opened and add to cart presses from its cards. Days are UTC; clicks are counted as the visitor’s browser reports them.',
    anchor: 'last-30-days',
  },
  contactEmail: {
    text: 'Where the Askr operator writes to you: when your plan’s budget runs out, about plan changes, and about your account. It is kept on the Askr server only, never published with your settings.',
    anchor: 'contact-email',
  },
  waiting: {
    text: 'Changes you signed that the server has not published to the relay yet. A store that is not active keeps them here until it is.',
    anchor: 'waiting-to-publish',
  },
  productSync: {
    text: 'The last time products were published from the admin: when, and how many were new, changed, removed or unchanged. A connector shows its own syncs on the Connector page.',
    anchor: 'product-sync',
  },

  // Billing
  currentPlan: {
    text: 'Your plan, how it is billed and when it renews or ends. Manage billing opens the Stripe billing portal: your payment method, your invoices, and undoing a cancel. A scheduled change is undone there if the portal offers that; otherwise message us with your Store ID.',
    anchor: 'your-paid-plan',
  },
  planPicker: {
    text: 'Start on Free puts your store live at once, within Free’s limits; save your settings first. A paid plan goes live once it is paid for, or once we set it up when you message us: the cards say which. Moving down or canceling takes effect when the period you paid for ends. For Enterprise, message us with your Store ID.',
    anchor: 'choose-a-plan',
  },

  // Settings: store
  storeName: {
    text: 'Your store’s name, as visitors know it. The assistant introduces the store by it, and the chat header shows it unless you set an assistant name.',
    anchor: 'store-name',
  },
  catalogLanguage: {
    text: 'The language your products and policies are written in, as a tag like en, de or pt-BR. The assistant searches the catalog in this language and answers each visitor in their own.',
    anchor: 'catalog-language',
  },
  currency: {
    text: 'The three-letter code of the currency your prices are in, like USD or EUR. Products priced in another currency are left out of the assistant’s catalog.',
    anchor: 'currency',
  },
  allowedOrigins: {
    text: `The sites the chat runs on, one per line, each a host like shop.example (https:// is added for you), with no path. The chat answers only on these, and product links may point to them or to your link origins. Up to ${LIMITS.MAX_ORIGINS}.`,
    anchor: 'allowed-origins',
  },
  linkOrigins: {
    text: 'Other sites a product card may link to, one per line: for example a separate shop domain your product pages live on. The chat does not run on them.',
    anchor: 'link-origins',
  },

  // Settings: assistant
  assistantName: {
    text: 'The name in the chat header. Leave it empty for your store name followed by "assistant".',
    anchor: 'assistant-name',
  },
  greeting: {
    text: `The first message a visitor sees when the chat opens, up to ${LIMITS.GREETING_CHARS} characters. It is shown as you write it, in any language. Leave it empty for a short greeting in the visitor’s language.`,
    anchor: 'greeting',
  },
  contact: {
    text: 'A page where visitors reach a person, such as your contact form, as an https address. The chat links to it when the assistant is unavailable, for example when the budget is used up or the visitor reached the day\u2019s question limit.',
    anchor: 'contact-url',
  },

  // Settings: products
  productSource: {
    text: 'Where the assistant reads your products and policies from. Here in the admin: you edit them here or import a CSV. My own catalog key: your backend, the SDK or an MCP server publishes them. My online shop or product feed: a connector imports them on a schedule.',
    anchor: 'where-your-products-come-from',
  },
  platform: {
    text: 'Which shop the connector reads: Shopify or WooCommerce through their public product pages, or a Google product feed file. Shopify and WooCommerce also get add to cart on your shop’s own site.',
    anchor: 'platform',
  },
  shopUrl: {
    text: 'Your shop’s address, like https://shop.example. It must be one of your allowed sites, so the chat can fill the shop’s cart there.',
    anchor: 'shop-address',
  },
  feedUrl: {
    text: 'The https address of your Google product feed (an XML file). Every site its products link to must be one of your allowed or link origins and show your Store ID.',
    anchor: 'feed-address',
  },
  currencyOverride: {
    text: 'For Shopify only: the currency of your prices, when the shop does not say it or says another one than it sells in. Leave it empty otherwise. WooCommerce and Google feeds give the currency with each price.',
    anchor: 'currency-override',
  },
  importPolicies: {
    text: 'Imports your Shopify refund, shipping, privacy and terms pages as policies. Each sync puts the shop’s version back, so edit those in Shopify.',
    anchor: 'import-policies',
  },
  catalogKey: {
    text: 'The public key (npub1...) your backend, SDK or MCP server signs your products and policies with. Saving authorizes it to publish for your store; you can revoke it under Advanced.',
    anchor: 'your-catalog-key',
  },

  // Settings: private instructions
  privateInstructions: {
    text: 'Encrypted so only your assistant can read them. Visitors never see them, and the assistant never quotes them.',
    anchor: 'private-instructions',
  },
  voice: {
    text: `How the assistant should sound: friendly, brief, formal and so on. Up to ${LIMITS.CONFIG_VOICE_CHARS} characters.`,
    anchor: 'voice',
  },
  instructions: {
    text: `What the assistant should do or prefer, such as which products to suggest first. It follows them within its own rules: it never makes up prices or promises. Up to ${LIMITS.CONFIG_INSTRUCTIONS_CHARS} characters.`,
    anchor: 'instructions',
  },
  notes: {
    text: `Background the assistant may use but never repeats word for word: stock coming soon, how your sizes run, what to say about delivery delays. Up to ${LIMITS.CONFIG_NOTES_CHARS} characters.`,
    anchor: 'notes',
  },

  // Products
  catalog: {
    text: 'The products the assistant recommends from. Saving a product publishes it at once; removing one deletes it for good.',
    anchor: 'catalog',
  },
  productId: {
    text: 'A short ID that never changes, such as your SKU: letters, digits and . _ : -. Saving the same ID again updates that product.',
    anchor: 'product-id',
  },
  productTitle: {
    text: 'The product’s name, as shown on its card in the chat.',
    anchor: 'product-title',
  },
  productPrice: {
    text: 'The price as a number, like 19.90. The assistant only quotes prices from here, never its own. With variants, it is the lowest in-stock variant price, or the lowest of all when none is in stock.',
    anchor: 'product-price',
  },
  productCurrency: {
    text: 'The price’s currency. It must be the store’s currency for the product to be offered.',
    anchor: 'product-currency',
  },
  productBilling: {
    text: 'One-time price, or a subscription price per hour, day, week, month or year.',
    anchor: 'billing',
  },
  productSummary: {
    text: 'One short line about the product. The assistant\u2019s search matches its words, as it does the title, description, topics and attributes.',
    anchor: 'summary',
  },
  productDescription: {
    text: 'Everything a shopper might ask about: materials, sizes, care, what is in the box. The assistant reads it when a visitor asks about this product, and its search matches its words.',
    anchor: 'description',
  },
  productPage: {
    text: 'The product’s page on your site. The card links to it; it must be on one of your allowed sites or link sites.',
    anchor: 'product-page',
  },
  productImages: {
    text: `Image addresses (https), one per line, up to ${LIMITS.MAX_IMAGES}. The first is shown on the card.`,
    anchor: 'image-urls',
  },
  productTopics: {
    text: `Words shoppers might search by, separated by commas, like tents, camping. Up to ${LIMITS.MAX_TOPICS}.`,
    anchor: 'topics',
  },
  productSku: {
    text: 'Your stock keeping unit. It is passed to your add to cart hook, never shown to visitors.',
    anchor: 'sku',
  },
  productAttributes: {
    text: `Facts as name and value, like Material: wool. The assistant filters and compares by them. Up to ${LIMITS.MAX_ATTRS}.`,
    anchor: 'attributes',
  },
  productOptions: {
    text: `Choices a shopper makes, like Size or Color, each with its values. Up to ${LIMITS.MAX_OPTIONS} options of ${LIMITS.MAX_OPTION_VALUES} values each.`,
    anchor: 'options',
  },
  productVariants: {
    text: `One row per combination of option values, with its own ID, price and stock if they differ. Up to ${LIMITS.MAX_VARIANTS}.`,
    anchor: 'variants',
  },
  productAvailability: {
    text: 'On sale and pre order: offered. Sold out: shown as sold out. Hidden: kept in your list but not offered, so you can show it again later.',
    anchor: 'availability',
  },
  lastPublish: {
    text: 'When your products were last published and what changed.',
    anchor: 'last-publish',
  },
  csvImport: {
    text: 'Add products from a spreadsheet saved as CSV, or replace all of them. Importing publishes at once. File format lists the columns; the example file is a good start.',
    anchor: 'import-from-a-csv-file',
  },

  // Policies
  policies: {
    text: `Shipping, returns, sizing and other answers the assistant may quote. Up to ${LIMITS.MAX_POLICIES} per store.`,
    anchor: 'policies-and-faq',
  },
  policySlug: {
    text: 'A short name that never changes, like returns or shipping: lowercase letters, digits and hyphens.',
    anchor: 'policy-short-name',
  },
  policyTitle: {
    text: 'The policy’s heading, as the assistant names it.',
    anchor: 'policy-title',
  },
  policyText: {
    text: 'The policy itself, in plain words. The assistant quotes from it, so write what you want visitors to read.',
    anchor: 'policy-text',
  },

  // Connector
  connector: {
    text: 'Imports your products from Shopify, WooCommerce or a Google feed on your plan’s schedule. Askr reads only what the shop shows the public.',
    anchor: 'connector',
  },
  siteProof: {
    text: 'A tag on your home page, or a file at /.well-known/askr, naming your Store ID. It proves the shop is yours; every sync checks it.',
    anchor: 'prove-the-site-is-yours',
  },
  sync: {
    text: 'Turn on syncing checks your shop first and turns on only if it can be read and fits your plan.',
    anchor: 'sync',
  },

  // Embed
  embedCode: {
    text: 'Paste this once before </body> on every page that should show the chat. It always loads the current version of the chat.',
    anchor: 'add-the-chat-to-your-site',
  },
  addToCart: {
    text: 'Whether product cards get an add to cart button: from a Shopify or WooCommerce connector on your shop’s own site, or from a hook your developer adds.',
    anchor: 'add-to-cart',
  },
  llmsTxt: {
    text: 'Put this file at your site’s root as /llms.txt, so AI agents learn your store uses Askr and read your products and policies without using your chat’s budget. Already have one? Add the Shopping assistant part to it.',
    anchor: 'llmstxt-for-ai-agents',
  },

  // Advanced
  secretKey: {
    text: 'Your secret key is your store. If someone else may have it, replace it: you prove the store is yours through your site, and the old key stops working.',
    anchor: 'secret-key',
  },
  catalogKeys: {
    text: 'Keys allowed to publish your products and policies. The server’s own key is one; authorize yours to publish from your backend, the SDK or an MCP server.',
    anchor: 'catalog-keys',
  },
  assistantKey: {
    text: 'The key your assistant answers with. Rotate it if you think it leaked: your settings are signed again for the new key.',
    anchor: 'assistant-key',
  },

  // Sign in
  rememberKey: {
    text: 'Keeps your secret key encrypted in this browser so you sign in with one press next time. Anyone who can use this browser can then sign in as your store: clear it on a shared computer.',
    anchor: 'remember-my-key-on-this-device',
  },
} as const satisfies Record<string, Help>;

export type HelpId = keyof typeof HELP;
