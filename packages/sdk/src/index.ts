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

// --- Services ---
export { DiscoveryService, toDTag } from './services/discovery';
export { MarketplaceService } from './services/marketplace';
export { MediaService } from './services/media';
export { PingService } from './services/ping';

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
export { estimateSolFeeLamports, formatFeeBreakdown } from './payment/feeEstimate';
export type { SolFeeEstimate, EstimateSolFeeOptions } from './payment/feeEstimate';
export { PaymentRequestSchema, parsePaymentRequest } from './payment/schema';
export type { ParsedPaymentRequest, ParseOptions, ParseResult } from './payment/schema';
export {
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  KNOWN_ASSETS,
  assetKey,
  assetByKey,
  resolveKnownAsset,
  resolveAssetFromPaymentRequest,
  parseAssetAmount,
  formatAssetAmount,
} from './payment/assets';
export type { Asset, Chain } from './payment/assets';

// --- On-chain protocol config ---
export { clearProtocolConfigCache, getProtocolConfig } from './config/onchain';
export type { GetProtocolConfigOptions, ProtocolConfig } from './config/onchain';

// --- Global config (~/.elisym/config.yaml) ---
export {
  GlobalConfigSchema,
  SessionSpendLimitEntrySchema,
  loadGlobalConfig,
  writeGlobalConfig,
} from './config/global';
export type { GlobalConfig, SessionSpendLimitEntry } from './config/global';

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
  LAMPORTS_PER_SOL,
  PROTOCOL_FEE_BPS,
  PROTOCOL_TREASURY,
  PROTOCOL_PROGRAM_ID_DEVNET,
  getProtocolProgramId,
  DEFAULTS,
  LIMITS,
} from './constants';
export type { ProtocolCluster } from './constants';

// --- Types ---
export type {
  // Agent (on-network)
  PaymentInfo,
  CapabilityCard,
  Agent,
  Network,
  // Jobs
  JobStatus,
  Job,
  SubmitJobOptions,
  JobUpdateCallbacks,
  JobSubscriptionOptions,
  // Ping
  PingResult,
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
