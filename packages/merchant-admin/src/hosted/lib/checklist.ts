import type { StoreView } from './types';

export type ChecklistState = 'done' | 'todo' | 'unknown';

export interface ChecklistItem {
  id: string;
  label: string;
  state: ChecklistState;
}

/** What a store needs before it sells, read from its view (and its products, when they were read). */
export function checklist(view: StoreView, productOnSale: boolean | undefined): ChecklistItem[] {
  const config = view.config;
  const payouts = config?.draftPayouts ?? [];
  const payto = view.ownerEvents.payto;
  const auth = view.ownerEvents.auth;
  const listSigned = payto !== null && !view.payouts.needsSigning;
  const state = (done: boolean): ChecklistState => (done ? 'done' : 'todo');
  return [
    { id: 'config', label: 'Settings saved', state: state(payouts.length > 0) },
    {
      id: 'payouts',
      label: 'Payout addresses signed by their wallets',
      state: state(payouts.length > 0 && payouts.every((payout) => payout.signature !== undefined)),
    },
    { id: 'payto-signed', label: 'Payout list signed', state: state(listSigned) },
    {
      id: 'payto-published',
      label: 'Payout list published',
      state: state(listSigned && payto.publishedAt !== null),
    },
    { id: 'auth-signed', label: 'PayCore authorized', state: state(auth !== null) },
    {
      id: 'auth-published',
      label: 'Authorization published',
      state: state(auth !== null && auth.publishedAt !== null),
    },
    {
      id: 'product',
      label: 'A product on sale',
      state: productOnSale === undefined ? 'unknown' : state(productOnSale),
    },
  ];
}
