/**
 * @elisym/sdk - public API.
 *
 * Browser-safe. For Node.js-only features (config parsing, secret encryption),
 * import from '@elisym/sdk/node'.
 */

// --- Client ---
export { ElisymClient } from './client';
export type { ElisymClientFullConfig } from './client';

// --- Transport ---
export { NostrPool } from './transport/pool';
export {
  encodeJobPayload,
  decodeJobPayload,
  attachmentsOf,
  ENVELOPE_VERSION,
  ACCEPT_TRANSPORTS_TAG,
  SESSION_ID_REGEX,
  buildAcceptTransportsTag,
  readAcceptedTransports,
} from './transport/attachment';
export type {
  FileAttachment,
  FileTransport,
  TransportKind,
  JobPayloadEnvelope,
  DecodedJobPayload,
  SessionRef,
} from './transport/attachment';
// Encrypted Blossom/HTTP file transport (browser-safe peer to the Node-only iroh transport).
export { createBlossomTransport } from './transport/blossom-transport';
export type { BlossomBlobTransport } from './transport/blossom-transport';
export {
  buildEncryptedFileInput,
  prepareEncryptedFileInput,
  fetchEncryptedFileOutput,
} from './transport/file-jobs';
export { encryptBytesForRecipient, decryptBytesFromSender } from './primitives/file-crypto';
export type { EncryptedBytes } from './primitives/file-crypto';

// --- Services ---
export {
  DiscoveryService,
  toDTag,
  computeRankKey,
  compareAgentsByRank,
  parseExternalIdentityEvent,
} from './services/discovery';
export type { RankKey } from './services/discovery';
export {
  verifyAgentIdentities,
  clearIdentityVerifyCache,
  normalizeNip05Identifier,
  splitNip05Identifier,
  isPrivateAddress,
} from './services/identity-verify';
export type { VerifyIdentitiesOptions, HostAddressResolver } from './services/identity-verify';
export { tallyReputation, requestJobIds } from './services/reputation';
export type {
  AgentReputation,
  RatingTier,
  CapabilityTiers,
  TallyInput,
} from './services/reputation';
export { MarketplaceService, parseDelegatedPayment } from './services/marketplace';
export type { DelegatedPaymentRequest } from './services/marketplace';
export { classifyJobError, JobWaitTimeoutError } from './services/jobErrors';
export type { JobErrorKind } from './services/jobErrors';
export { MediaService } from './services/media';
export { BlossomService } from './services/blossom';
export type { BlobDescriptor, BlossomUploadFallback } from './services/blossom';
export { MessagesService } from './services/messages';
export { PingService } from './services/ping';
export { PoliciesService } from './services/policies';

// --- Payment ---
export {
  buildPaymentInstructions,
  createPaymentRequestWithOnchainConfig,
  SolanaPaymentStrategy,
} from './payment/solana';
export { calculateProtocolFee, validateExpiry, assertExpiry, assertLamports } from './payment/fee';
export type {
  BuildTransactionOptions,
  PaymentStrategy,
  ProtocolConfigInput,
  Signer,
} from './payment/strategy';
export {
  estimatePriorityFeeMicroLamports,
  clearPriorityFeeCache,
  pickPercentileFee,
} from './payment/priorityFee';
export type { EstimatePriorityFeeOptions } from './payment/priorityFee';
export {
  estimateSolFeeLamports,
  formatFeeBreakdown,
  estimateNetworkBaseline,
  formatNetworkBaseline,
} from './payment/feeEstimate';
export type {
  SolFeeEstimate,
  EstimateSolFeeOptions,
  NetworkBaselineEstimate,
  NetworkBaselineOptions,
} from './payment/feeEstimate';
export { PaymentRequestSchema, parsePaymentRequest } from './payment/schema';
export type { ParsedPaymentRequest, ParseOptions, ParseResult } from './payment/schema';
export { verifyJobPaymentQuick, clearQuickVerifyCache } from './payment/quick-verify';
export type { QuickVerifyResult, QuickVerifyReason } from './payment/quick-verify';
export {
  isDefinitelyUnpaid,
  buildSignedPull,
  sendConfirmToTerminal,
  confirmPullToTerminal,
} from './payment/settlement';
export type {
  SignedPullTransaction,
  PullTerminalOutcome,
  ConfirmToTerminalOptions,
} from './payment/settlement';
export { aggregateNetworkStats, getNetworkStats } from './payment/analytics';
export type {
  AggregateNetworkStatsOptions,
  NetworkStatsResult,
  OnchainNetworkStats,
} from './payment/analytics';
export {
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  KNOWN_ASSETS,
  assetKey,
  assetByKey,
  resolveKnownAsset,
  resolveUsdcAsset,
  resolveAssetFromPaymentRequest,
  parseAssetAmount,
  formatAssetAmount,
} from './payment/assets';
export type { Asset, Chain } from './payment/assets';
export {
  encodeSecretKeyBase58,
  exportKeyPairBytes,
  generateSolanaWallet,
  signerFromSecretKeyBase58,
} from './payment/wallet';

// --- Delegated execution (spl-approve bounded spend) ---
export {
  DELEGATION_MECHANISM,
  DelegationDescriptorSchema,
  SkillDelegationSchema,
  parseDelegationDescriptor,
  validateSkillDelegation,
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
} from './delegation';
export type {
  DelegationDescriptor,
  SkillDelegation,
  BuildApproveDelegateArgs,
  BuildRevokeDelegateArgs,
  BuildDelegatedTransferArgs,
  DelegationStatus,
  ApproveDelegateView,
  DelegationFeeTransferView,
  DelegationAuthFields,
  BuildDelegationAuthProofArgs,
  VerifyDelegationAuthProofArgs,
} from './delegation';

// --- On-chain protocol config ---
export { clearProtocolConfigCache, getProtocolConfig } from './config/onchain';
export type { GetProtocolConfigOptions, ProtocolConfig } from './config/onchain';

// --- Global config (~/.elisym/config.yaml) schemas ---
// Node-only loader/writer live in `@elisym/sdk/node`; the schemas stay here so
// browser code can validate shapes without pulling in `node:fs/promises`.
export { GlobalConfigSchema, SessionSpendLimitEntrySchema } from './config/global-schema';
export type { GlobalConfig, SessionSpendLimitEntry } from './config/global-schema';

// --- Primitives ---
export { ElisymIdentity } from './primitives/identity';
export { nip44Encrypt, nip44Decrypt } from './primitives/crypto';
export { formatSol, timeAgo, truncateKey } from './primitives/format';
export { validateAgentName } from './primitives/config';
export { BoundedSet } from './primitives/bounded-set';
export { createSlidingWindowLimiter } from './primitives/rateLimiter';
export type {
  RateLimitDecision,
  SlidingWindowLimiter,
  SlidingWindowLimiterOptions,
} from './primitives/rateLimiter';
export {
  DEFAULT_REDACT_PATHS,
  INPUT_REDACT_PATHS,
  SECRET_REDACT_PATHS,
  makeCensor,
} from './primitives/logRedact';

// --- Constants ---
export {
  RELAYS,
  KIND_APP_HANDLER,
  KIND_LONG_FORM_ARTICLE,
  KIND_JOB_REQUEST_BASE,
  KIND_JOB_RESULT_BASE,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_JOB_FEEDBACK,
  DEFAULT_KIND_OFFSET,
  jobRequestKind,
  jobResultKind,
  KIND_PING,
  KIND_PONG,
  KIND_GIFT_WRAP,
  KIND_DM_SEAL,
  KIND_DM_RUMOR,
  KIND_DM_INBOX_RELAYS,
  KIND_EXTERNAL_IDENTITIES,
  GITHUB_USERNAME_REGEX,
  X_USERNAME_REGEX,
  GIST_ID_REGEX,
  TWEET_ID_REGEX,
  DM_INBOX_MARKER_TAG,
  DM_INBOX_MARKER_VALUE,
  POLICY_T_TAG,
  POLICY_D_TAG_PREFIX,
  POLICY_TYPE_REGEX,
  LAMPORTS_PER_SOL,
  PROTOCOL_PROGRAM_ID_DEVNET,
  PROTOCOL_PROGRAM_ID_MAINNET,
  ELISYM_PROTOCOL_TAG,
  getProtocolProgramId,
  DEFAULTS,
  LIMITS,
  utf8ByteLength,
} from './constants';
export type { ProtocolCluster } from './constants';

// --- Types ---
export type {
  // Agent (on-network)
  PaymentInfo,
  CapabilityCard,
  Agent,
  AgentExternalIdentity,
  ExternalIdentityClaimInput,
  ExternalIdentityClaimsResult,
  IdentityVerifyStatus,
  VerifiedIdentityResult,
  AgentPolicy,
  PolicyInput,
  Network,
  // Jobs
  JobStatus,
  Job,
  SubmitJobOptions,
  JobUpdateCallbacks,
  JobSubscriptionOptions,
  // Ping
  PingResult,
  // Direct messages
  DirectMessage,
  ConversationSummary,
  // Payment
  PaymentRequestData,
  PaymentAssetRef,
  VerifyResult,
  VerifyOptions,
  PaymentValidationCode,
  PaymentValidationError,
  // Stats
  NetworkStats,
  // Client
  ElisymClientConfig,
  SubCloser,
} from './types';
