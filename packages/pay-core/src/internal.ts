/**
 * Internals, for this repository's own packages and tests - never a promise to
 * anyone outside, and free to change in any release.
 *
 * Two kinds of export live here. Seams the suites reach for (a cache to reset
 * between rows, a classifier a test asserts on directly), and the few pieces
 * the SDK shares with the core without offering them to its users (the payment
 * bounds it folds into its own `DEFAULTS` and `LIMITS`, two program addresses,
 * the settlement-store signature guard). They used to be reachable because it
 * was all one package; they are named here so that stays true without widening
 * what `@elisym/pay-core` - and, through its re-export, `@elisym/sdk` - offers.
 *
 * The package is built with code splitting, so this entry and the root one
 * share a single copy of every module: resetting a cache here resets the cache
 * the root entry reads.
 */

export {
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  PAYMENT_DEFAULTS,
  PAYMENT_LIMITS,
  SYSTEM_PROGRAM_ADDRESS_STR,
} from './constants';
export { isUsableSignature } from './payment/acceptor';

export { classifyRequestUsability } from './payment/acceptor';
export { mergeAccountKeys } from './payment/account-keys';
export {
  degenerateReferenceDerivations,
  resetDegenerateReferenceCache,
} from './payment/degenerate-reference';
export { isReadableTokenRow, readBalance } from './payment/read-balance';
export { describeIssues } from './payment/schema';
