/**
 * The admin page: the merchant pastes the store key, the page reads the store
 * and its order messages from the relays and shows them. The key lives in the
 * session's memory only: never stored, never sent (it signs NIP-42 AUTH only).
 */
import type { UnwrappedOrderMessage } from '@elisym/commerce';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { NostrEvent } from 'nostr-tools';
import { parseStoreKey } from './key';
import type { WrapPool } from './reader';
import { renderHistory, renderProducts } from './render';
import { AdminSession, type Outcome } from './session';

export interface AdminDeps {
  client: RelayClient;
  pool: WrapPool;
  now: () => number;
  /** Drops the key: reloads the page. */
  forget: () => void;
  unwrap?: (wrap: NostrEvent, secretKey: Uint8Array) => UnwrappedOrderMessage | undefined;
}

function byId<T extends HTMLElement>(doc: Document, id: string, type: { new (): T }): T {
  const found = doc.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`the admin page has no #${id}`);
  }
  return found;
}

/** Wire the page in `doc`. */
export function startAdmin(doc: Document, deps: AdminDeps): void {
  const view = doc.defaultView;
  if (view === null) {
    throw new Error('the admin page needs a window');
  }
  const element = (id: string) => byId(doc, id, view.HTMLElement);
  const button = (id: string) => byId(doc, id, view.HTMLButtonElement);
  const keyInput = byId(doc, 'store-key', view.HTMLInputElement);
  const openButton = button('open');
  const refreshButton = button('refresh');
  const moreButton = button('more');
  const loginError = element('login-error');
  const status = element('status');
  const warnings = element('warnings');
  const moreRow = element('more-row');
  const targets = {
    body: element('orders'),
    totals: element('totals'),
    empty: element('no-orders'),
  };
  const productList = element('products');

  let session: AdminSession | undefined;

  const setWarnings = (texts: readonly string[]) => {
    warnings.replaceChildren(
      ...texts.map((text) => {
        const item = doc.createElement('li');
        item.className = 'warn';
        item.textContent = text;
        return item;
      }),
    );
  };

  const run = async (task: (current: AdminSession) => Promise<Outcome>) => {
    if (session === undefined) {
      return;
    }
    refreshButton.disabled = true;
    moreButton.disabled = true;
    const outcome = await task(session);
    if (outcome === 'busy') {
      // Another run holds the buttons.
      return;
    }
    try {
      if (outcome.ok) {
        const { snapshot } = outcome;
        renderHistory(doc, snapshot.history, targets);
        renderProducts(doc, snapshot.products, productList);
        moreRow.hidden = !snapshot.more;
        setWarnings(snapshot.warnings);
      }
    } catch (error) {
      status.textContent = `Could not read: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      refreshButton.disabled = false;
      moreButton.disabled = false;
    }
  };

  refreshButton.onclick = () => void run((current) => current.refresh());
  moreButton.onclick = () => void run((current) => current.more());

  const submit = () => {
    const storeKey = parseStoreKey(keyInput.value);
    keyInput.value = '';
    if (storeKey === undefined) {
      loginError.textContent = 'That is not a secret key: paste an nsec or 64 hex characters.';
      return;
    }
    if (session !== undefined) {
      return;
    }
    loginError.textContent = '';
    element('login').hidden = true;
    element('dashboard').hidden = false;
    element('store-pubkey').textContent = storeKey.pubkey;
    session = new AdminSession(
      deps,
      storeKey,
      { readAllListings: false },
      (text) => {
        status.textContent = text;
      },
      (store) => {
        element('store-name').textContent = store.name ?? '(no profile name)';
      },
    );
    void run((current) => current.open());
  };

  openButton.onclick = submit;
  keyInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      submit();
    }
  };
  button('forget').onclick = () => deps.forget();
}
