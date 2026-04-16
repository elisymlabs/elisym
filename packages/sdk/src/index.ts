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
export { buildPaymentInstructions, SolanaPaymentStrategy } from './payment/solana';
export { calculateProtocolFee, validateExpiry, assertExpiry, assertLamports } from './payment/fee';
export type { PaymentStrategy, ProtocolConfigInput } from './payment/strategy';

// --- Primitives ---
export { ElisymIdentity } from './primitives/identity';
export { nip44Encrypt, nip44Decrypt } from './primitives/crypto';
export { formatSol, timeAgo, truncateKey } from './primitives/format';
export { validateAgentName, serializeConfig } from './primitives/config';
export { BoundedSet } from './primitives/bounded-set';

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
  DEFAULTS,
  LIMITS,
} from './constants';

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
  VerifyResult,
  VerifyOptions,
  PaymentValidationCode,
  PaymentValidationError,
  // Stats
  NetworkStats,
  // Client
  ElisymClientConfig,
  SubCloser,
  // Agent Config (on-disk)
  Identity,
  Capability,
  PaymentAddress,
  WalletConfig,
  LlmConfig,
  AgentConfig,
} from './types';
