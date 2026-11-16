import { ASKR_API_BASE, ASKR_RELAYS } from '@elisym/askr';
import { WIDGET_ELEMENT, WIDGET_SCRIPT_URL } from '../constants';
import type { PinnedWidget } from './types';

/** The one-line embed: the script mounts the chat for the store it names. */
export function scriptSnippet(npub: string): string {
  return `<script src="${WIDGET_SCRIPT_URL}" data-store="${npub}" async></script>`;
}

const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;',
};

/** A value safe inside a double-quoted HTML attribute (the values are checked already; this is depth). */
function attributeValue(value: string): string {
  return value.replace(/[&"<>]/g, (character) => ATTRIBUTE_ESCAPES[character] ?? character);
}

/**
 * The pinned embed (6): one exact bundle by its content-addressed path, which
 * the browser runs only if it matches `integrity`. It never changes under the
 * site, so fixes reach it only when the merchant pastes a newer one.
 */
export function pinnedScriptSnippet(npub: string, widget: PinnedWidget): string {
  const src = attributeValue(widget.src);
  const integrity = attributeValue(widget.integrity);
  return `<script src="${src}" integrity="${integrity}" crossorigin="anonymous" data-store="${attributeValue(npub)}" async></script>`;
}

/** The element form, for a host that places the chat itself. */
export function elementSnippet(npub: string): string {
  return `<${WIDGET_ELEMENT} store="${npub}"></${WIDGET_ELEMENT}>\n<script src="${WIDGET_SCRIPT_URL}" async></script>`;
}

export interface CspSource {
  directive: string;
  sources: string[];
  why: string;
}

/** The sources a site with a Content-Security-Policy must allow (6). */
export function cspSources(): CspSource[] {
  // The widget reads and writes only the compiled-in Askr relay (K20).
  const relayOrigins = ASKR_RELAYS.map((relay) => new URL(relay).origin);
  return [
    { directive: 'script-src', sources: [ASKR_API_BASE], why: 'loads widget.js' },
    {
      directive: 'connect-src',
      sources: [ASKR_API_BASE, ...relayOrigins],
      why: 'the chat itself and its connection to the assistant',
    },
    {
      directive: 'img-src',
      sources: ['https:'],
      why: 'product images and the avatar live on any https host',
    },
  ];
}

/** A page's hook for the add-to-cart button, for a site without a native cart. */
export const ADD_TO_CART_SNIPPET = `<script>
  window.Askr = window.Askr || {};
  window.Askr.onAddToCart = function (detail) {
    // detail.d: the product ID; detail.sku: its SKU, if it has one;
    // detail.variant and detail.options: the size, color and so on the shopper picked.
    // Put the product in your cart here.
  };
</script>`;

/** Where to paste the embed code on common site builders. */
export const PLATFORM_HINTS: ReadonlyArray<{ platform: string; where: string }> = [
  {
    platform: 'Shopify',
    where: 'Online Store, Themes, Edit code: open theme.liquid and paste it before </body>.',
  },
  {
    platform: 'WordPress and WooCommerce',
    where: 'a plugin that adds code to the footer (such as WPCode), or your theme footer.',
  },
  {
    platform: 'Wix, Squarespace, Tilda and others',
    where: 'the custom code or HTML block in the site settings, set to load on every page.',
  },
];
