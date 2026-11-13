import { WIDGET_SRC } from './constants';

/** The tag a merchant pastes into their pages, naming the store by its owner npub. */
export function embedSnippet(store = 'npub1...'): string {
  return `<script src="${WIDGET_SRC}" data-store="${store}" async></script>`;
}

/** A page's own add-to-cart hook: the widget calls it before any native add-to-cart. */
export const CART_HOOK_SNIPPET = [
  '<script>',
  '  window.Askr = window.Askr || {};',
  '  window.Askr.onAddToCart = function (detail) {',
  '    // put detail.d (or detail.sku, detail.variant) with detail.options',
  '    // into your cart',
  '  };',
  '</script>',
].join('\n');

/** The pinned tag the admin shows under Embed: the browser runs the bundle only if it matches. */
export const PINNED_SNIPPET = [
  '<script',
  `  src="${WIDGET_SRC.replace('/widget.js', '/widget/<id>.js')}"`,
  '  integrity="sha384-..."',
  '  crossorigin="anonymous"',
  '  data-store="npub1..."',
  '  async',
  '></script>',
].join('\n');
