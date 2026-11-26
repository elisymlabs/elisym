import type { CatalogItem, CatalogPayable } from '@elisym/askr';

/**
 * Buy on a PayCore card (C4, C5). The widget never loads or bundles the checkout: Buy is
 * offered only when the page itself loaded checkout v4, whose global `PayCore.open` shows the
 * checkout in its own iframe. The widget passes the listing's naddr and network, nothing else,
 * and learns only the state names the checkout reports.
 */

/** What Buy tells the chat: once per milestone per checkout. Never sent to the assistant. */
export type BuyNote = 'busy' | 'open-failed' | 'paid' | 'completed' | 'refused' | 'error';

export interface PagePayCore {
  open: (options: { product: string; network: CatalogPayable['network'] }) => unknown;
}

/**
 * The page's checkout v4, or none: `window.PayCore` with `version: 'v4'` and an `open`
 * function. Read at render time, so a script that loads after the card still counts.
 */
export function pagePayCore(scope: object = globalThis): PagePayCore | undefined {
  try {
    const payCore: unknown = Reflect.get(scope, 'PayCore');
    if (typeof payCore !== 'object' || payCore === null) {
      return undefined;
    }
    const open: unknown = Reflect.get(payCore, 'open');
    if (Reflect.get(payCore, 'version') !== 'v4' || typeof open !== 'function') {
      return undefined;
    }
    return { open: (options) => Reflect.apply(open, payCore, [options]) };
  } catch {
    return undefined;
  }
}

/** Whether a card offers Buy: payable (a live 30490) and on sale, not pre-order or sold out. */
export function buyable(item: CatalogItem): item is CatalogItem & { payable: CatalogPayable } {
  return item.payable !== undefined && item.visibility === 'on-sale';
}

let hinted = false;

/** Tell the page's developer once why payable cards show no Buy. */
export function hintMissingCheckout(log: (message: string) => void = console.info): void {
  if (hinted) {
    return;
  }
  hinted = true;
  log('Askr: add the PayCore checkout v4 script to this page to show Buy on PayCore products.');
}

export interface BuyHooks {
  note: (note: BuyNote) => void;
  /** The checkout opened. */
  opened: () => void;
  /** The checkout reported the payment: once per checkout. */
  paid: () => void;
}

function stateOf(event: Event): unknown {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  return typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'state') : undefined;
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'busy';
}

/**
 * Open the page's checkout for a payable listing. Every throw is caught: `busy` (a payment is
 * already open) or anything else (bad options, a page-defined host, a replacement race). Each
 * milestone the checkout reports is told at most once; an `error` event claims no cause.
 */
export function startBuy(payCore: PagePayCore, payable: CatalogPayable, hooks: BuyHooks): void {
  let checkout: unknown;
  try {
    checkout = payCore.open({ product: payable.naddr, network: payable.network });
  } catch (error) {
    hooks.note(isBusy(error) ? 'busy' : 'open-failed');
    return;
  }
  if (!(checkout instanceof EventTarget)) {
    hooks.note('open-failed');
    return;
  }
  hooks.opened();
  const told = new Set<BuyNote>();
  const tell = (note: BuyNote): void => {
    if (!told.has(note)) {
      told.add(note);
      hooks.note(note);
    }
  };
  let paid = false;
  const markPaid = (): void => {
    if (!paid) {
      paid = true;
      hooks.paid();
    }
  };
  checkout.addEventListener('status', (event) => {
    const state = stateOf(event);
    if (state === 'paid') {
      markPaid();
      tell('paid');
    } else if (state === 'completed') {
      // A checkout may report completed without a separate paid first.
      markPaid();
      tell('completed');
    } else if (state === 'refused') {
      tell('refused');
    }
  });
  checkout.addEventListener('error', () => tell('error'));
}
