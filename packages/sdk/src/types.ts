import type { DelegationDescriptor } from './delegation';
import type { ElisymIdentity } from './primitives/identity';
import type { FileAttachment, TransportKind } from './transport/attachment';

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
  /**
   * MIME the capability expects as a file input (from a dynamic-script skill's
   * `input_mime`). Discovery hint only; the provider still content-sniffs the
   * actual file. Its presence means the capability accepts a file input (the web
   * app sends it over encrypted Blossom; the MCP/CLI over iroh), so clients show a
   * file picker. `*` = any file, `image/*` = any image, `image/png` = exact.
   */
  inputMime?: string;
  /** MIME of a file result the capability produces (from `output_mime`). */
  outputMime?: string;
  /**
   * How a file-input capability treats the text prompt (from `input_text`):
   * `'none'` = file only, `'optional'` = file optional + instruction required (a
   * generate-or-edit skill), `'required'` = file + text both required. Omitted =
   * file required + optional note. Discovery hint; the web app shows/hides/gates its
   * text box and file picker accordingly. Only meaningful with `inputMime`.
   * Untrusted - gate on it, never render the raw value.
   */
  inputText?: 'required' | 'optional' | 'none';
  /**
   * The capability keeps conversation context across jobs (from a skill's
   * `context: true` frontmatter): reusing a `sessionId` on submits makes the
   * provider answer with the session's prior exchanges as context. Absent =
   * stateless; a session id sent anyway is processed statelessly without
   * error. Discovery hint - clients gate chat affordances on it.
   */
  context?: boolean;
  /**
   * Delegated-execution descriptor (v1: `spl-approve`). Present when the
   * capability accepts a bounded USDC allowance: the owner `approve`s the
   * `delegate_pubkey` for up to `cap`, and the agent then autonomously spends
   * up to that. Untrusted remote data - `parseCapabilityEvent` validates and
   * clears a malformed descriptor rather than dropping the whole card. The
   * `suggested_cap_subunits` is a non-binding display default; the owner always
   * sets the real cap.
   */
  delegation?: DelegationDescriptor;
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

/**
 * Legal/operational policy published by an agent (NIP-23 long-form article,
 * kind 30023). One event per `(pubkey, type)` slot; replaceable by `d`-tag.
 *
 * `type` is open vocabulary - common values: `tos`, `privacy`, `refund`,
 * `aup`, `sla`, `dpa`, `jurisdiction`. Validation regex `POLICY_TYPE_REGEX`.
 */
export interface AgentPolicy {
  type: string;
  version: string;
  title: string;
  summary?: string;
  /** Full markdown body. */
  content: string;
  /** NIP-19 `naddr` reference, e.g. for sharing or migration to dedicated kind. */
  naddr: string;
  /** Underlying NIP-23 d-tag (e.g. `elisym-policy-tos`). */
  dTag: string;
  /** Event `created_at` in unix seconds (NIP-23 spec: defaults to publication date). */
  publishedAt: number;
  eventId: string;
  authorPubkey: string;
}

/** Input shape for `PoliciesService.publishPolicy`. */
export interface PolicyInput {
  type: string;
  version: string;
  title: string;
  summary?: string;
  content: string;
}

/**
 * External identity claim (NIP-39 kind 10011 for github/x, NIP-05 for
 * website) attached to an agent. A claim is self-published and proves nothing
 * by itself - anyone can claim any handle. Status comes only from
 * `verifyAgentIdentities`.
 */
export interface AgentExternalIdentity {
  platform: 'github' | 'x' | 'website';
  /** Username (github/x) or normalized NIP-05 identifier (website). */
  handle: string;
  /** Public proof artifact: gist URL, tweet URL, or `https://<domain>`. */
  proofUrl: string;
}

/**
 * Input claim for `publishExternalIdentities`. The website claim does not ride
 * kind 10011 - it is the kind-0 `nip05` field (see `publishProfile`).
 */
export interface ExternalIdentityClaimInput {
  platform: 'github' | 'x';
  handle: string;
  /** Proof artifact id: gist id (github) or tweet status id (x). */
  proofId: string;
}

export type IdentityVerifyStatus = 'verified' | 'broken' | 'unverifiable';

/** Per-identity outcome of `verifyAgentIdentities`. */
export interface VerifiedIdentityResult {
  identity: AgentExternalIdentity;
  /**
   * `verified` - proof fetched, author matches the handle, body matches the
   * platform proof template with this agent's npub (or the NIP-05 mapping
   * equals the pubkey). `broken` - proof fetched and definitively wrong or
   * absent; a positive "do not trust" signal. `unverifiable` - could not
   * check (network error, rate limit, CORS, timeout, oversize body); neutral,
   * never rendered as negative.
   */
  status: IdentityVerifyStatus;
}

/**
 * Result of `DiscoveryService.fetchExternalIdentityClaims` - parsed claims
 * plus the newest kind-0 profile fields from the same relay query, so CLI
 * kind-0 republishes can carry over picture/banner without a second fetch.
 */
export interface ExternalIdentityClaimsResult {
  identities: AgentExternalIdentity[];
  profile: {
    name?: string;
    about?: string;
    picture?: string;
    banner?: string;
    /** Normalized NIP-05 identifier from kind 0, when present and valid. */
    nip05?: string;
  };
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
  /**
   * Unix seconds of the agent's most recent paid job, request-authorship-bound
   * (the `payment-completed` author equals the job request's author). Undefined
   * if none. Read by `compareAgentsByRank` as the top sort key.
   */
  lastPaidJobAt?: number;
  /** Solana tx signature of the paid job referenced by `lastPaidJobAt`. */
  lastPaidJobTx?: string;
  /**
   * Nostr-verified positive ratings (last 30 days): the rating author signed
   * the job request too. Read by `compareAgentsByRank`.
   */
  positiveCount?: number;
  /** Nostr-verified total ratings (last 30 days). Read by `compareAgentsByRank`. */
  totalRatingCount?: number;
  /**
   * Ratings that passed the weaker result-`p`-tag binding but not the strong
   * request-authorship anchor (broadcast jobs, expired requests). Displayed as
   * the broader "total", NOT a ranking input.
   */
  unverifiedRatingCount?: number;
  unverifiedPositiveCount?: number;
  /**
   * Reserved for the off-chain indexer (see docs/plans/agent-reputation-indexer.md).
   * Always undefined in stage 1 - the payment tx signatures ride in the events
   * but are not verified on-chain here. The indexer fills this without an API
   * break.
   */
  paymentVerified?: {
    total: number;
    positive: number;
    /** assetKey -> raw subunits (string). */
    volume: Record<string, string>;
  };
  picture?: string;
  banner?: string;
  name?: string;
  about?: string;
  /** External identity claims (github/x from kind 10011, website from kind-0 nip05). Unverified self-claims - status only via `verifyAgentIdentities`. */
  identities?: AgentExternalIdentity[];
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
  /**
   * Job input text. Sent unencrypted if providerPubkey is not set. May be empty
   * when `attachment` is set (a file-only job carries no text note).
   */
  input: string;
  capability: string;
  /** Target provider pubkey. If omitted, job is broadcast unencrypted and visible to all relays. */
  providerPubkey?: string;
  /** Kind offset (default 100 - kind 5100). */
  kindOffset?: number;
  /**
   * Optional file attachment. When set, `input` (as the text note) and the
   * attachment are wrapped in a job-payload envelope before encryption. The file
   * itself travels out-of-band (P2P via iroh), not in the Nostr event.
   */
  attachment?: FileAttachment;
  /**
   * Ordered (by client preference) transports this customer can RECEIVE output on. Published as a
   * public `accept` tag. When omitted, providers default to seeding all transports (back-compat);
   * advertising `['iroh']` makes a provider skip the (encrypted-Blossom) upload it can't use.
   */
  acceptTransports?: TransportKind[];
  /**
   * Conversation session id (client-generated UUID v4, lowercase). Reusing an id
   * asks the provider to answer with the context of prior jobs in the session;
   * a fresh id starts a new chat; omitting it is a stateless one-shot. Requires
   * `providerPubkey` (the session travels inside the NIP-44-encrypted payload
   * envelope and must never appear in cleartext relay content) - submitting a
   * session id without a provider pubkey throws. Providers that predate or
   * disable sessions strip the field and process the job statelessly.
   */
  sessionId?: string;
  /**
   * Delegated payment mode: the job carries `payment=delegated` + the owner
   * address and a single-use, short-lived owner-signed proof; the provider
   * settles by pulling its skill price from the customer's existing spl-approve
   * USDC delegation instead of a per-job payment. Requires `providerPubkey`
   * (the proof binds THIS provider's delegate key; a broadcast delegated job is
   * meaningless and refused at submit). Build the proof with
   * `buildDelegationAuthProof` / the shared `buildAuthMessage`.
   */
  delegatedPayment?: {
    /** Owner base58 Solana address - source of funds AND the verify key. */
    owner: string;
    /** Unix seconds after which the proof is dead (<= now + MAX_PROOF_TTL_SECS). */
    expiryUnix: number;
    /** Single-use base58 nonce (32-44 chars). */
    nonce: string;
    /** base58 Ed25519 signature by the owner over the shared auth message. */
    proof: string;
  };
}

export interface JobUpdateCallbacks {
  onFeedback?: (
    status: string,
    amount?: number,
    paymentRequest?: string,
    senderPubkey?: string,
  ) => void;
  /**
   * Fired on a job result. `content` is the result text (for a file result, the
   * envelope's text note, or `''`); `attachment` is the FIRST file descriptor
   * (= `attachments[0]`, kept for back-compat); `attachments` is the full list for
   * a multi-file result. Files are fetched separately (P2P via iroh / Blossom),
   * never inlined here. `paymentTx` is the result event's `tx` tag when present
   * (the provider's on-chain settlement signature, e.g. a delegated pull) -
   * transparency data from the provider, NOT verified on-chain here.
   */
  onResult?: (
    content: string,
    eventId: string,
    attachment?: FileAttachment,
    attachments?: FileAttachment[],
    paymentTx?: string,
  ) => void;
  onError?: (error: string) => void;
  /**
   * Fired when the result wait window expires without a result - a distinct,
   * structured signal from `onError`. When omitted, the timeout is delivered
   * through `onError` as a "Timed out waiting..." string for backwards
   * compatibility.
   */
  onTimeout?: (timeoutMs: number) => void;
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

// --- Direct messages (NIP-17) ---

/** A decrypted private direct message. Transport details (wraps, seals) never leak out of the SDK. */
export interface DirectMessage {
  /** Rumor id - identical across the sender's self-copy and the recipient's copy. */
  id: string;
  senderPubkey: string;
  /**
   * Best-effort display metadata: the first `p` tag of the rumor, falling
   * back to the reader's own pubkey when absent (the wrap decrypted to us,
   * so we are a recipient). External clients may deviate (multi-`p` group
   * rumors); received messages group by sender, so this stays correct.
   */
  recipientPubkey: string;
  content: string;
  /** Rumor created_at (real time - wrap/seal timestamps are randomized by NIP-59). */
  createdAt: number;
  /** True when the reader authored the message (senderPubkey === own pubkey). */
  isMine: boolean;
}

/** One conversation (grouped by counterpart) in an inbox listing. */
export interface ConversationSummary {
  counterpartPubkey: string;
  lastMessage: DirectMessage;
  /** Messages fetched in the query window - not an all-time total. */
  messageCount: number;
  /**
   * Counterpart-authored (`!isMine`) messages strictly newer than the
   * caller's read cursor. Present only when `readCursors` was passed to
   * `listConversations`; a missing cursor counts every counterpart-authored
   * message as unread.
   */
  unreadCount?: number;
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
  /**
   * Solana network the request settles on. Always written by the SDK's
   * request-creation API; optional on the parse side - absent means devnet
   * (requests from pre-mainnet providers). `validatePaymentRequest` rejects a
   * request whose network differs from the customer's.
   */
  network?: Network;
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
  | 'network_mismatch'
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
  jobCount: number;
  totalLamports: number;
}

// --- Client ---

export interface ElisymClientConfig {
  relays?: string[];
}

// Agent config types moved to @elisym/sdk/agent-store (ElisymYaml, Secrets).
