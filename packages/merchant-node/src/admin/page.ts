/**
 * The admin page: the merchant pastes the store key, the page reads the store
 * and its order messages from the relays and shows them. The key lives in this
 * module's memory only: never stored, never sent (it signs NIP-42 AUTH only).
 */
import { type UnwrappedOrderMessage, unwrapOrderMessage } from '@elisym/commerce';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { NostrEvent } from 'nostr-tools';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { buildHistory } from './history';
import { type StoreKey, parseStoreKey } from './key';
import { WrapReader, type LoadResult, type WrapPool } from './reader';
import { renderHistory } from './render';
import { type StoreView, keepWhatWasRead, readStore } from './store';

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  let busy = false;

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

  const showLoad = (
    result: LoadResult,
    reader: WrapReader,
    loaded: StoreView,
    base: readonly string[],
  ) => {
    renderHistory(doc, buildHistory(reader.messages, loaded.store), targets);
    moreRow.hidden = !result.more;
    status.textContent = `Read ${reader.messages.length} order messages from ${loaded.relays.length} relays.`;
    const partial =
      result.partial.length === 0
        ? []
        : [
            `Partial: these relays were not read through (no answer in time, or a broken relay): ${result.partial.join(', ')}.`,
          ];
    setWarnings([...base, ...partial]);
  };

  const run = async (task: () => Promise<void>) => {
    if (busy) {
      return;
    }
    busy = true;
    refreshButton.disabled = true;
    moreButton.disabled = true;
    try {
      await task();
    } catch (error) {
      status.textContent = `Could not read: ${errorText(error)}`;
    } finally {
      busy = false;
      refreshButton.disabled = false;
      moreButton.disabled = false;
    }
  };

  /** What to tell the merchant about the store's own events. */
  const storeWarnings = (loaded: StoreView): string[] => {
    const base: string[] = [];
    if (loaded.noInboxList) {
      base.push(
        'No inbox list (kind 10050) found, or the relays did not answer: reading the default relays instead.',
      );
    }
    if (loaded.listings.length === 0) {
      base.push(
        'No listing found for this store, or the relays did not answer: no order can be matched to a product. Refresh to try again.',
      );
    } else if (loaded.listings.length > 1) {
      base.push(
        `This store published several listings (${loaded.listings.join(', ')}): orders for any of them are shown.`,
      );
    }
    return base;
  };

  const sameRelays = (first: readonly string[], second: readonly string[]) =>
    first.length === second.length && first.every((relay) => second.includes(relay));

  const open = async (storeKey: StoreKey) => {
    element('login').hidden = true;
    element('dashboard').hidden = false;
    element('store-pubkey').textContent = storeKey.pubkey;
    const unwrap = deps.unwrap ?? unwrapOrderMessage;
    const newReader = (relays: readonly string[]) =>
      new WrapReader({
        pool: deps.pool,
        relays,
        storePubkey: storeKey.pubkey,
        auth: async (template: EventTemplate) => finalizeEvent(template, storeKey.secretKey),
        unwrap: (wrap) => unwrap(wrap, storeKey.secretKey),
        now: deps.now,
      });
    const readView = () => {
      status.textContent = 'Reading the store...';
      return readStore(deps.client, storeKey.pubkey, deps.now());
    };
    const showName = (view: StoreView) => {
      element('store-name').textContent = view.name ?? '(no profile name)';
    };
    /** Kept from an earlier read, because the relays did not answer this one. */
    let stale = false;
    const warningsFor = (view: StoreView) => [
      ...storeWarnings(view),
      ...(stale
        ? [
            'The relays did not answer for the store this time: its listings and inbox relays are the ones read before.',
          ]
        : []),
    ];

    let loaded = await readView();
    let reader = newReader(loaded.relays);
    status.textContent = 'Reading orders...';
    // Refresh reads the store again too: its listings, payout list or inbox
    // relays may have changed, or not have answered the first time.
    refreshButton.onclick = () =>
      void run(async () => {
        const kept = keepWhatWasRead(loaded, await readView());
        stale = kept.stale;
        const fresh = kept.view;
        showName(fresh);
        if (sameRelays(fresh.relays, loaded.relays)) {
          loaded = fresh;
          showLoad(await reader.refresh(), reader, loaded, warningsFor(loaded));
          return;
        }
        loaded = fresh;
        reader = newReader(loaded.relays);
        showLoad(await reader.load(), reader, loaded, warningsFor(loaded));
      });
    moreButton.onclick = () =>
      void run(async () => showLoad(await reader.load(), reader, loaded, warningsFor(loaded)));
    showName(loaded);
    showLoad(await reader.load(), reader, loaded, warningsFor(loaded));
  };

  const submit = () => {
    const storeKey = parseStoreKey(keyInput.value);
    keyInput.value = '';
    if (storeKey === undefined) {
      loginError.textContent = 'That is not a secret key: paste an nsec or 64 hex characters.';
      return;
    }
    loginError.textContent = '';
    void run(() => open(storeKey));
  };

  openButton.onclick = submit;
  keyInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      submit();
    }
  };
  button('forget').onclick = () => deps.forget();
}
