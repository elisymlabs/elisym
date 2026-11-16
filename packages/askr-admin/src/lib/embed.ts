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
    // detail.variant: the variant ID, when the shopper's pick determines one;
    // detail.options: { "Size": "M", ... }, whenever a choice is made.
    // Put the product in your cart here.
  };
</script>`;

/** Where to paste the embed code on common site builders. */
export const PLATFORM_HINTS: ReadonlyArray<{ platform: string; where: string }> = [
  {
    platform: 'Shopify',
    where:
      'Online Store, Themes, then Edit code in the theme menu: open theme.liquid and paste it before </body>.',
  },
  {
    platform: 'WordPress and WooCommerce',
    where: 'a plugin that adds code to every page (such as WPCode), set to the footer.',
  },
  {
    platform: 'Wix',
    where:
      'Settings, Custom Code, on all pages (a paid plan with a connected domain). Not the Embed HTML element: it runs on another address, where the chat does not answer.',
  },
  {
    platform: 'Squarespace',
    where:
      'Settings, Code Injection, in the footer (a Core plan or higher). A code block on a page shows the chat on that page only.',
  },
  {
    platform: 'Other site builders',
    where: 'the site-wide custom code setting, never a block on one page.',
  },
];
