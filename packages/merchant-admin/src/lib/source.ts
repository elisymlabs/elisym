/**
 * Whose numbers the shared views show: a store the merchant runs (its node
 * credits payments) or a store in our cloud (the store credits them; no node
 * is the merchant's to name).
 */
export type Source = 'self-hosted' | 'cloud';

/** What credits and names payments, as the views say it. */
export const CREDITOR: Readonly<Record<Source, string>> = {
  'self-hosted': 'your node',
  cloud: 'your store',
};
