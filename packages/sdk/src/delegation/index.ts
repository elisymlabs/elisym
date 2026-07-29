/**
 * Delegated execution (v1: `spl-approve` bounded autonomous spend).
 *
 * The owner `approveChecked`s an agent's dedicated delegate key for a bounded
 * `cap` USDC; the agent then autonomously `transferChecked`s up to `cap`. See
 * `spl-approve.ts` for the honest bound and hard gates.
 */

export {
  DELEGATION_MECHANISM,
  DelegationDescriptorSchema,
  SkillDelegationSchema,
  parseDelegationDescriptor,
  validateSkillDelegation,
} from './schema';
export type { DelegationDescriptor, SkillDelegation } from './schema';

export {
  resolveDelegationAsset,
  deriveOwnerDelegationAta,
  buildApproveDelegate,
  buildRevokeDelegate,
  buildDelegatedTransfer,
  getDelegation,
  decodeApproveDelegate,
  decodeDelegationFeeTransfer,
  delegationApproveFeeSubunits,
  formatDelegationGrant,
} from './spl-approve';

export {
  DELEGATED_PAYMENT_TAG,
  DELEGATED_PAYMENT_MODE,
  DELEGATION_OWNER_TAG,
  DELEGATION_EXPIRY_TAG,
  DELEGATION_NONCE_TAG,
  DELEGATION_PROOF_TAG,
  DELEGATION_NONCE_REGEX,
  DELEGATION_PROOF_REGEX,
  MAX_PROOF_TTL_SECS,
  PROOF_CLOCK_SKEW_SECS,
  buildAuthMessage,
  mintDelegationNonce,
  buildDelegationAuthProof,
  verifyDelegationAuthProof,
} from './auth-proof';
export type {
  DelegationAuthFields,
  BuildDelegationAuthProofArgs,
  VerifyDelegationAuthProofArgs,
} from './auth-proof';
export type {
  BuildApproveDelegateArgs,
  BuildRevokeDelegateArgs,
  BuildDelegatedTransferArgs,
  DelegationStatus,
  ApproveDelegateView,
  DelegationFeeTransferView,
} from './spl-approve';
