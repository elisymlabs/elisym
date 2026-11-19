import { WIDGET_SRC } from './constants';

/** The tag a merchant pastes into their pages, naming the store by its owner npub. */
export function embedSnippet(store = 'npub1...'): string {
  return `<script src="${WIDGET_SRC}" data-store="${store}" async></script>`;
}
