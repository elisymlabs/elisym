/**
 * On-chain action capabilities: a capability whose deliverable is a Solana
 * call, signed by the CUSTOMER (browser wallet or MCP agent key) and never by
 * the provider.
 *
 * The card carries the promise (which programs, which asset, which ceilings),
 * the job returns one unsigned transaction, and the client verifies the second
 * against the first before anything is signed. Design and the honest bound:
 * `docs/plans/onchain-action-skills.md`.
 *
 * This barrel is the module's OUTWARD face - what `src/index.ts` republishes
 * and what `services/discovery.ts` consumes. The stages (`decodeCallTransaction`,
 * `runStaticChecks`, `simulateCall`, `analyzeStateChange`, `assertCeilings`) are
 * deliberately absent: `verifyOnchainCall` is the only path by which a client
 * may sign, and exporting a stage would invite assembling a partial check.
 * Internal callers, including the tests, import them by path.
 */

export { OnchainRefusalError } from './errors';
export { validateProviderCall } from './provider';
export { defaultCeilings, verifyOnchainCall } from './verify';
export type { VerifyOnchainCallArgs } from './verify';
export type {
  OnchainAssetDelta,
  OnchainAuthorityGrant,
  OnchainCallFacts,
  OnchainCeilings,
  OnchainRefusalReason,
  OnchainVerifyResult,
  SkillOnchainResolved,
} from './types';

export {
  ONCHAIN_CALL_VERSION,
  MAX_WIRE_TRANSACTION_BYTES,
  MAX_CALL_BASE64_CHARS,
  MAX_INSTRUCTIONS_PER_CALL,
  MAX_PROGRAMS_PER_CARD,
  MAX_PARAMS_PER_CARD,
  MAX_REQUIRES_PER_CARD,
  MAX_EXPLAIN_ENTRIES,
  MAX_EXPLAIN_TEXT_CHARS,
  MAX_CALL_TTL_SECS,
  CALL_CLOCK_SKEW_SECS,
  DEFAULT_INCIDENTAL_LAMPORTS,
  MAX_INCIDENTAL_LAMPORTS,
  ONCHAIN_DISCLAIMER,
  ONCHAIN_REFUSAL_HEADLINES,
  ONCHAIN_UNATTRIBUTED_NOTICE,
} from './constants';

export {
  OnchainCallEnvelopeSchema,
  OnchainDescriptorSchema,
  SkillOnchainSchema,
  parseOnchainCallEnvelope,
  parseOnchainDescriptor,
  validateSkillOnchain,
} from './schema';
export type {
  OnchainCallEnvelope,
  OnchainDescriptor,
  OnchainExplain,
  OnchainParam,
  SkillOnchain,
} from './schema';
