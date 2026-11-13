/**
 * Which pages of a cloud store open, from the store's state (plan
 * `admin-onboarding.md` 2.5, the lock table): a page that would only fail
 * says why instead. Overview (the checklist) and Help always open.
 */
import type { StoreStatus } from './status';

export type CloudPage =
  | 'overview'
  | 'orders'
  | 'products'
  | 'payouts'
  | 'install'
  | 'settings'
  | 'billing'
  | 'help';

export const PAY_FIRST = 'Pay the first month to open this';
export const PREPARING_PAID = 'Paid. Preparing your store: this takes a minute';
export const PREPARING = 'We are preparing your store: this takes a minute';
export const NAME_FIRST = 'Name your store first';
export const READING = 'Reading your store...';

/** The pages a store with no store key yet shows: what it can do before it exists. */
const BEFORE_THE_KEY: readonly CloudPage[] = ['overview', 'billing', 'help'];
/** An invited (or partner-paid) store has no pay step: only what explains it opens. */
const INVITED_BEFORE_THE_KEY: readonly CloudPage[] = ['overview', 'help'];
const PAGES: readonly CloudPage[] = [
  'overview',
  'orders',
  'products',
  'payouts',
  'install',
  'settings',
  'billing',
  'help',
];

function lockAllBut(
  open: readonly CloudPage[],
  reason: string,
): Partial<Record<CloudPage, string>> {
  return Object.fromEntries(
    PAGES.filter((page) => !open.includes(page)).map((page) => [page, reason]),
  );
}

/**
 * Each locked page with its reason. `invited`: the operator set the store up
 * (it has no plan or pay step, and a partner's stores are among these).
 */
export function pageLocks(input: {
  launched: boolean;
  invited: boolean;
  /** The store's status; undefined while it is first read (or the read failed). */
  status: StoreStatus | undefined;
}): Partial<Record<CloudPage, string>> {
  const { launched, invited, status } = input;
  if (launched) {
    return {};
  }
  if (status === undefined) {
    return lockAllBut(BEFORE_THE_KEY, READING);
  }
  if (status.storePubkey === undefined) {
    if (invited) {
      return lockAllBut(INVITED_BEFORE_THE_KEY, PREPARING);
    }
    return lockAllBut(
      BEFORE_THE_KEY,
      status.effectivePaidUntil === undefined ? PAY_FIRST : PREPARING_PAID,
    );
  }
  return status.kept.name === undefined ? { payouts: NAME_FIRST } : {};
}
