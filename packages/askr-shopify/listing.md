# Shopify App Store listing (draft)

Drafted for the Partner dashboard's listing form. Shopify's limits are in brackets; every text here
fits them. Screenshots and the demo video are made on the development store once it exists.

## App name [30]

Askr: AI Shopping Assistant

## App icon

The Askr mark on its brand background, 1200 x 1200 PNG (from `packages/askr-landing` brand assets).

## App introduction [100]

An AI shopping assistant that answers shoppers from your own products and policies, on every page.

## App details [500]

Askr adds a chat assistant to your storefront. It answers shoppers' questions from your own
catalog and policies, recommends products, shows product cards with your real prices and
availability, and adds to the cart with one tap. Prices come from your catalog, never from the AI.
Askr reads your products and refund, shipping, privacy and terms pages from Shopify and keeps them
in sync. It reads no customer or order data. Turn it on in the theme editor: no code.

## Feature list [80 each]

- Answers from your own products and policies, never invented prices
- Product cards with your catalog's prices, variants and one-tap add to cart
- Syncs products and policies from Shopify automatically
- Turns on in the theme editor as an app embed, no code
- Speaks your shoppers' language and follows your brand voice
- Reads no customer or order data; chats expire within 24 hours

## Pricing

- Free plan, chosen in the app (no Shopify charge).
- Paid plans through Shopify billing come in a later version; until then the listing shows Free
  only.

## Category and search terms

- Category: Store design > Chat, or Customer support > Chatbots (as the dashboard offers).
- Search terms: ai shopping assistant, product chat, ai chatbot, product recommendations, faq bot.

## URLs

- Privacy policy: https://askr.elisym.network/privacy
- Terms of service: https://askr.elisym.network/terms-of-service
- Support and FAQ: https://docs.elisym.network/askr/shopify
- Contact: https://askr.elisym.network/contact

## Testing instructions for the reviewer

1. Install the app on the review store and open Askr from the Shopify admin.
2. Press **Set up Askr**, then **Download key file** (or copy the key), tick **I saved my owner key
   somewhere safe** and press **Finish setup**. The key is made in the browser and never sent to
   our server.
3. In **Overview**, press **Start on Free**. The first product import starts at once; refresh
   Overview after a minute to see the sync time.
4. Press **Open the theme editor**, turn on **Askr assistant** under App embeds and save.
5. Open the storefront: an **Ask AI** button appears. Ask about a product: the answer shows product
   cards with the store's prices, and **Add to cart** adds the variant to the Shopify cart.
6. Uninstall the app: the button disappears from the storefront on the next page load, and the
   store's data is erased 48 hours later when Shopify sends `shop/redact` (a store its owner took
   over with the owner key is only unlinked).

The app needs no account or login beyond Shopify. It requests only `read_products` and
`read_legal_policies`.

## Before submitting (from the plan's phase 0 and 4)

- `client_id` in `shopify.app.toml`, then `shopify app deploy`.
- Lighthouse on the dev store's home, product and collection pages, with and without the embed:
  the drop must stay within 10 points; otherwise add the `launcher.js` entry (plan 4).
- Confirm the App Bridge URL and the CSP it needs, the `read_locales` question, and
  `onlineStoreUrl` on a password-protected development store.
- Screenshots: the chat with product cards on a storefront, the onboarding backup step, Overview,
  Settings, the theme editor with the embed on.
