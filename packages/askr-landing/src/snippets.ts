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
