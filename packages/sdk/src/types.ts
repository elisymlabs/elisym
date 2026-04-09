import type { ElisymIdentity } from './primitives/identity';

// --- Pool ---

export interface SubCloser {
  close: (reason?: string) => void;
}

// --- Agent (on-network representation) ---

/** Capability card published to Nostr (NIP-89). */
export interface CapabilityCard {
  name: string;
  description: string;
  capabilities: string[];
  payment?: PaymentInfo;
  image?: string;
  static?: boolean;
}

/** Payment info embedded in capability card (legacy format for on-network events). */
export interface PaymentInfo {
  chain: string;
  network: string;
  address: string;
  /** Price in lamports (must be non-negative integer). */
  job_price?: number;
}

/** Agent discovered from the network. */
export interface Agent {
  pubkey: string;
  npub: string;
  cards: CapabilityCard[];
  eventId: string;
  supportedKinds: number[];
  lastSeen: number;
  picture?: string;
  name?: string;
  about?: string;
}

export type Network = 'mainnet' | 'devnet';

// --- Jobs ---

/**
 * Job lifecycle status.
 * Note: for broadcast jobs (no providerPubkey, no bid), fetchRecentJobs() keeps
 * status as 'processing' even if a provider sent 'payment-required' feedback,
 * because the customer hasn't committed to that provider yet. The real-time
 * payment-required transition is handled by subscribeToJobUpdates().
 */
export type JobStatus =
  | 'payment-required'
  | 'payment-completed'
  | 'processing'
  | 'error'
  | 'success'
  | 'partial'
  | 'unknown';

export interface Job {
  eventId: string;
  customer: string;
  agentPubkey?: string;
  capability?: string;
  bid?: number;
  status: JobStatus;
  result?: string;
  resultEventId?: string;
  amount?: number;
  txHash?: string;
  createdAt: number;
}

export interface SubmitJobOptions {
  /** Job input text. Sent unencrypted if providerPubkey is not set. */
  input: string;
  capability: string;
  /** Target provider pubkey. If omitted, job is broadcast unencrypted and visible to all relays. */
  providerPubkey?: string;
  /** Kind offset (default 100 - kind 5100). */
  kindOffset?: number;
}

export interface JobUpdateCallbacks {
  onFeedback?: (
    status: string,
    amount?: number,
    paymentRequest?: string,
    senderPubkey?: string,
  ) => void;
  onResult?: (content: string, eventId: string) => void;
  onError?: (error: string) => void;
}

export interface JobSubscriptionOptions {
  jobEventId: string;
  providerPubkey?: string;
  customerPublicKey: string;
  callbacks: JobUpdateCallbacks;
  timeoutMs?: number;
  customerSecretKey?: Uint8Array;
  kindOffsets?: number[];
  sinceOverride?: number;
}

// --- Messaging ---

export interface PingResult {
  online: boolean;
  /** The identity used for the ping session - reuse for job submission so pubkeys match. */
  identity: ElisymIdentity | null;
}

// --- Payment ---

export interface PaymentRequestData {
  recipient: string;
  /** Total amount in lamports (must be positive integer). */
  amount: number;
  reference: string;
  description?: string;
  fee_address?: string;
  fee_amount?: number;
  /** Creation timestamp (Unix seconds). */
  created_at: number;
  /** Expiry duration in seconds. */
  expiry_secs: number;
}

export interface VerifyResult {
  verified: boolean;
  txSignature?: string;
  error?: string;
}

export interface VerifyOptions {
  retries?: number;
  intervalMs?: number;
  txSignature?: string;
}

export type PaymentValidationCode =
  | 'invalid_json'
  | 'invalid_amount'
  | 'missing_recipient'
  | 'invalid_recipient_address'
  | 'missing_reference'
  | 'invalid_reference_address'
  | 'recipient_mismatch'
  | 'expired'
  | 'future_timestamp'
  | 'fee_address_mismatch'
  | 'fee_amount_mismatch'
  | 'missing_fee'
  | 'invalid_fee_params';

export interface PaymentValidationError {
  code: PaymentValidationCode;
  message: string;
}

// --- Network Stats ---

export interface NetworkStats {
  totalAgentCount: number;
  agentCount: number;
  jobCount: number;
  totalLamports: number;
}

// --- Client ---

export interface ElisymClientConfig {
  relays?: string[];
}

// --- Agent Config (on-disk JSON at ~/.elisym/agents/<name>/config.json) ---

export interface Identity {
  secret_key: string;
  name: string;
  description?: string;
  picture?: string;
  banner?: string;
}

export interface Capability {
  name: string;
  description: string;
  tags: string[];
  /** Price in smallest unit (lamports for Solana). */
  price: number;
  /** Hero image URL for app display. */
  image?: string;
}

export interface PaymentAddress {
  chain: string;
  network: string;
  address: string;
  /** Token mint/contract address. Absent = native coin. */
  token?: string;
}

export interface WalletConfig {
  chain: string;
  network: string;
  secret_key: string;
}

export interface LlmConfig {
  provider: string;
  api_key: string;
  model: string;
  max_tokens: number;
}

export interface AgentConfig {
  identity: Identity;
  relays: string[];
  capabilities?: Capability[];
  payments?: PaymentAddress[];
  wallet?: WalletConfig;
  llm?: LlmConfig;
}
