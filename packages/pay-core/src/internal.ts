/**
 * Internals, for this repository's own tests and tooling - never a promise to
 * anyone outside, and free to change in any release. No shipped code imports
 * this entry; what the SDK needs from the core lives in `./shared`.
 *
 * Every export here is a seam the suites reach for - a cache to reset between
 * rows, a classifier a test asserts on directly. They used to be reachable
 * because the tests and the code shared a package; they are named here so that
 * stays true without widening what `@elisym/pay-core` offers.
 *
 * The package is built with code splitting, so this entry and the root one
 * share a single copy of every module: resetting a cache here resets the cache
 * the root entry reads.
 */

export { classifyRequestUsability } from './payment/acceptor';
export { mergeAccountKeys } from './payment/account-keys';
export {
  degenerateReferenceDerivations,
  resetDegenerateReferenceCache,
} from './payment/degenerate-reference';
export { isReadableTokenRow, readBalance } from './payment/read-balance';
export { describeIssues } from './payment/schema';
