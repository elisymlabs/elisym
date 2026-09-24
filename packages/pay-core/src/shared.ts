/**
 * What elisym's own packages share with the payment core without offering it to
 * their users: the payment bounds the SDK folds into its own `DEFAULTS` and
 * `LIMITS`, two program addresses, and the guard a settlement store keys on -
 * plus the protocol's identity (tag and program ids, also on the root), so a
 * reader of constants alone never has to load the root entry.
 *
 * A separate entry, not the root, because `@elisym/sdk` re-exports the root
 * whole and these must not become SDK API. Unlike `./internal` this entry is
 * covered by semver like the root: an SDK already installed loads it, so a
 * name here is not removed or changed outside a minor release.
 *
 * It is also light on purpose: constants and one pure function, no Solana
 * libraries, so a consumer that only needs the bounds (the SDK's agent store)
 * does not load the payment rail.
 */

export {
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  ELISYM_PROTOCOL_TAG,
  getProtocolProgramId,
  PAYMENT_DEFAULTS,
  PAYMENT_LIMITS,
  PROTOCOL_PROGRAM_ID_DEVNET,
  PROTOCOL_PROGRAM_ID_MAINNET,
  SYSTEM_PROGRAM_ADDRESS_STR,
  type ProtocolCluster,
} from './constants';
export { MIN_SETTLEMENT_RETENTION_MS, isUsableSignature } from './payment/settlement-claim';
