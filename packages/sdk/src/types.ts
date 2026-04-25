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
  /**
   * Price in subunits of the payment asset (non-negative integer).
   *
   * Subunit = smallest indivisible unit: 1 lamport for SOL, 1 "cent" (1e-6 USDC)
   * for USDC. When `token` is omitted, subunits are lamports (back-compat).
   */
  job_price?: number;
  /** Lowercase token id (e.g. 'sol', 'usdc'). Absent => native SOL. */
  token?: string;
  /** SPL mint / ERC-20 contract. Undefined for native coin. */
  mint?: string;
  /** Subunits per whole (9 for SOL, 6 for USDC). */
  decimals?: number;
  /** Display symbol (e.g. 'SOL', 'USDC'). */
  symbol?: string;
}

/** Agent discovered from the network. */
export interface Agent {
  pubkey: string;
  npub: string;
  cards: CapabilityCard[];
  eventId: string;
  supportedKinds: number[];
  /** Newest network signal of any kind: capability publish, result event, or feedback event. */
  lastSeen: number;
  /** Unix seconds of the agent's most recent on-chain-verified paid job. Undefined if none. */
  lastPaidJobAt?: number;
  /** Solana tx signature of the verified paid job referenced by `lastPaidJobAt`. */
  lastPaidJobTx?: string;
  /** Count of `rating=1` feedback events targeting this agent (last 30 days). */
  positiveCount?: number;
  /** Count of all rated feedback events targeting this agent (last 30 days). */
  totalRatingCount?: number;
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
  /**
   * Payment asset, derived from the `payment-required` feedback's embedded
   * payment request when present. Undefined means either no payment-required
   * feedback was observed for this job, or the embedded request was missing
   * an `asset` field (treated as native SOL by callers).
   */
  asset?: PaymentAssetRef;
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

// --- Ping ---

export interface PingResult {
  online: boolean;
  /** The identity used for the ping session - reuse for job submission so pubkeys match. */
  identity: ElisymIdentity | null;
}

// --- Payment ---

/**
 * Wire-shape reference to an asset inside a payment request.
 *
 * Same shape as `Asset` minus the display-only `symbol` field. Absent = native
 * SOL (back-compat for payment requests published before multi-asset support).
 */
export interface PaymentAssetRef {
  chain: string;
  token: string;
  mint?: string;
  decimals: number;
}

export interface PaymentRequestData {
  recipient: string;
  /**
   * Total amount in subunits of the payment asset (must be positive integer).
   *
   * - For native SOL (asset absent / `token: 'sol'`): lamports (1e-9 SOL).
   * - For SPL USDC: 1e-6 USDC.
   */
  amount: number;
  reference: string;
  description?: string;
  fee_address?: string;
  fee_amount?: number;
  /** Creation timestamp (Unix seconds). */
  created_at: number;
  /** Expiry duration in seconds. */
  expiry_secs: number;
  /** Optional asset identifier. Absent => native SOL (back-compat). */
  asset?: PaymentAssetRef;
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
  | 'invalid_fee_params'
  | 'invalid_asset';

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

// Agent config types moved to @elisym/sdk/agent-store (ElisymYaml, Secrets).
