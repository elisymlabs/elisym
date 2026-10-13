/**
 * The admin read code shared with merchant-node's local admin page, as source.
 * Every import of it goes through this file: a structure test pins the set.
 */
export { type StoreKey, parseStoreKey } from '@merchant-admin-core/key';
export {
  type ClaimCheck,
  type Credit,
  type History,
  type NodeAmount,
  type OrderRow,
  type OrderState,
  wholeUnits,
} from '@merchant-admin-core/history';
export {
  CLAIM_LABELS,
  STATE_LABELS,
  amountText,
  dateText,
  short,
} from '@merchant-admin-core/labels';
export {
  AdminSession,
  type Outcome,
  type SessionDeps,
  type Snapshot,
} from '@merchant-admin-core/session';
export type { ProductLine, StoreView } from '@merchant-admin-core/store';
