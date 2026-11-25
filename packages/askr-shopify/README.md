# @elisym/askr-shopify

Askr's Shopify app: the app configuration (`shopify.app.toml`) and the theme app extension that
puts the assistant on a storefront. Private; deployed with the Shopify CLI, never published to npm.

- `shopify.app.toml`: scopes `read_products,read_legal_policies`, the embedded admin at
  `https://app.askr.elisym.network/shopify/`, and the webhooks the server works off
  (`app/uninstalled`, `shop/update`, and the compliance topics).
- `extensions/askr-widget/blocks/app-embed.liquid`: an app embed (`target: body`) that loads
  `widget.js` with the store id the server writes to the app installation metafield `askr.store`
  at setup. The merchant turns it on from the deep link in the app.

Deploy: set `client_id` from the Partner dashboard, then `shopify app deploy`.
