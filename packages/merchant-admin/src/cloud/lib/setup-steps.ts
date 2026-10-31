/**
 * The guided flow's steps (plan `cloud-pricing-and-onboarding.md` 3), read
 * from the store's status alone: progress is never stored, so a reload
 * resumes where the data says.
 */
import type { StoreStatus } from './status';

export type SetupStepKey =
  | 'plan'
  | 'key'
  | 'pay'
  | 'name'
  | 'payouts'
  | 'products'
  | 'install'
  | 'launch';

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  state: 'done' | 'current' | 'next';
  /** Cannot be opened yet: the store it sets up does not exist (not paid, or its key not made). */
  locked: boolean;
}

/** The digest of an empty product set: nothing kept yet. */
export const EMPTY_PRODUCTS_DIGEST =
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

const LABELS: Record<SetupStepKey, string> = {
  plan: 'Plan',
  key: 'Your key',
  pay: 'Pay',
  name: 'Name your store',
  payouts: 'Get paid to',
  products: 'Products',
  install: 'Install',
  launch: 'Launch',
};

/**
 * The steps and which is current. `invited`: a store the operator set up
 * (no plan or pay step, and the operator launches it). The plan and key are
 * done once the store exists; pay once its store key is made (the first
 * credited payment makes it); a save once the store keeps it; install once
 * there is a product to sell. Once the store key is made any step opens, in
 * any order; before it, only the plan, key and pay steps.
 */
export function setupSteps(status: StoreStatus, invited: boolean): SetupStep[] {
  const done: Record<SetupStepKey, boolean> = {
    plan: true,
    key: true,
    pay: status.storePubkey !== undefined,
    name: status.kept.name !== undefined,
    payouts: status.kept.payoutList !== undefined,
    products: status.kept.productsDigest !== EMPTY_PRODUCTS_DIGEST,
    install: status.kept.productsDigest !== EMPTY_PRODUCTS_DIGEST,
    launch: status.runState !== 'not_launched',
  };
  const keys: SetupStepKey[] = invited
    ? ['key', 'name', 'payouts', 'products', 'install', 'launch']
    : ['plan', 'key', 'pay', 'name', 'payouts', 'products', 'install', 'launch'];
  const current = keys.find((key) => !done[key]);
  const before: readonly SetupStepKey[] = ['plan', 'key', 'pay'];
  const stateOf = (key: SetupStepKey): SetupStep['state'] => {
    if (done[key]) {
      return 'done';
    }
    return key === current ? 'current' : 'next';
  };
  return keys.map((key) => ({
    key,
    label: LABELS[key],
    state: stateOf(key),
    locked: status.storePubkey === undefined && !before.includes(key),
  }));
}
