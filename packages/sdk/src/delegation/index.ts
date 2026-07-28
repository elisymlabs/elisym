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
export type {
  BuildApproveDelegateArgs,
  BuildRevokeDelegateArgs,
  BuildDelegatedTransferArgs,
  DelegationStatus,
  ApproveDelegateView,
  DelegationFeeTransferView,
} from './spl-approve';
