import type { Address } from '@solana/kit';

export const RELAYS = [
  // Dedicated elisym relay (self-hosted) first, public relays as fallback.
  'wss://relay.elisym.network',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
];

export const KIND_APP_HANDLER = 31990;
export const KIND_LONG_FORM_ARTICLE = 30023;
export const KIND_JOB_REQUEST_BASE = 5000;
export const KIND_JOB_RESULT_BASE = 6000;
export const KIND_JOB_FEEDBACK = 7000;
export const DEFAULT_KIND_OFFSET = 100;

/** Discovery tag attached to elisym agent policy events (kind 30023). */
export const POLICY_T_TAG = 'elisym-policy';
/** d-tag prefix for policy events: full d-tag = `<prefix><type>` (e.g. `elisym-policy-tos`). */
export const POLICY_D_TAG_PREFIX = 'elisym-policy-';
/** Validation regex for policy `type` slug. Lowercase ASCII + hyphen, 1-32 chars, no leading/trailing hyphen. */
export const POLICY_TYPE_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Default job request kind (5000 + 100). */
export const KIND_JOB_REQUEST = KIND_JOB_REQUEST_BASE + DEFAULT_KIND_OFFSET;
/** Default job result kind (6000 + 100). */
export const KIND_JOB_RESULT = KIND_JOB_RESULT_BASE + DEFAULT_KIND_OFFSET;

/** Compute a job request kind from an offset (5000 + offset). */
export function jobRequestKind(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset >= 1000) {
    throw new Error(`Invalid kind offset: ${offset}. Must be integer 0-999.`);
  }
  return KIND_JOB_REQUEST_BASE + offset;
}

/** Compute a job result kind from an offset (6000 + offset). */
export function jobResultKind(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset >= 1000) {
    throw new Error(`Invalid kind offset: ${offset}. Must be integer 0-999.`);
  }
  return KIND_JOB_RESULT_BASE + offset;
}

/** Ephemeral ping/pong kinds (not stored by relays, forwarded in real-time). */
export const KIND_PING = 20200;
export const KIND_PONG = 20201;

/** NIP-59 gift wrap (outer layer of a NIP-17 private direct message). */
export const KIND_GIFT_WRAP = 1059;
/** NIP-59 seal (middle layer - signed by the real sender). */
export const KIND_DM_SEAL = 13;
/** NIP-17 chat rumor (innermost, unsigned DM event). */
export const KIND_DM_RUMOR = 14;
/** NIP-17/NIP-51 DM inbox relay list (replaceable). */
export const KIND_DM_INBOX_RELAYS = 10050;
/** NIP-39 external identity claims (`i` tags; normal-replaceable, newest wins). */
export const KIND_EXTERNAL_IDENTITIES = 10011;

// External-identity handle/proof-id formats, enforced symmetrically like the
// payment fields: `ElisymYamlSchema` + `publishExternalIdentities` reject on
// write, the kind-10011 parser rejects on read. The strict charsets are the
// URL-injection guard - handles and proof ids are embedded into proof-fetch
// URLs, so anything outside these patterns is dropped at every boundary.
/** GitHub username (also the gist URL path segment). */
export const GITHUB_USERNAME_REGEX = /^[a-zA-Z0-9-]{1,39}$/;
/** X / Twitter username (on-wire NIP-39 platform name stays `twitter`). */
export const X_USERNAME_REGEX = /^[A-Za-z0-9_]{1,15}$/;
/** GitHub gist id (lowercase hex). */
export const GIST_ID_REGEX = /^[a-f0-9]{1,64}$/;
/** Tweet status id. Always a string - tweet ids overflow IEEE-754 doubles. */
export const TWEET_ID_REGEX = /^[0-9]{1,25}$/;
/** Marker tag on SDK-published kind 10050 events: `['client', 'elisym']`.
 * Present = SDK-managed default list (safe to refresh when the relay set
 * changes); absent = operator-managed (never overwritten by the SDK). */
export const DM_INBOX_MARKER_TAG = 'client';
export const DM_INBOX_MARKER_VALUE = 'elisym';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Solana program ID for the elisym protocol config (devnet deployment).
 *
 * The Anchor program at this address is the source of truth for fee bps,
 * treasury address, and admin rotation state. Read via `getProtocolConfig`.
 */
export const PROTOCOL_PROGRAM_ID_DEVNET = 'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE' as Address;

/**
 * Solana program ID for the elisym protocol config (mainnet deployment).
 *
 * Deliberately the same address as devnet - the program was deployed to
 * mainnet with the same program keypair (plan D4). The constants stay
 * per-cluster so a future divergence (or a localnet deployment) is a
 * one-line change, but the program id alone no longer identifies a
 * cluster: every program-id-keyed cache carries a network discriminator.
 */
export const PROTOCOL_PROGRAM_ID_MAINNET =
  'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE' as Address;

/**
 * Read-only marker pubkey attached as a non-signer account to every elisym
 * payment transaction. Lets indexers enumerate every elisym tx network-wide
 * via a single `getSignaturesForAddress(ELISYM_PROTOCOL_TAG)` call,
 * independent of fee size or recipient.
 *
 * The account does not need to exist on-chain; including its pubkey as an
 * extra read-only account in the provider transfer instruction is enough for
 * Solana's tx-by-account index to pick it up. The corresponding secret key
 * was generated and discarded - the tag never signs and never holds funds.
 */
export const ELISYM_PROTOCOL_TAG = 'ELiZksgwDt41LaeuPDLkUfWgFXhGgVayTMP7L5nTSEL8' as Address;

export type ProtocolCluster = 'devnet' | 'mainnet' | 'localnet';

/** Resolve the elisym-config program ID for a given Solana cluster. */
export function getProtocolProgramId(cluster: ProtocolCluster): Address {
  switch (cluster) {
    case 'devnet':
    case 'localnet':
      return PROTOCOL_PROGRAM_ID_DEVNET;
    case 'mainnet':
      return PROTOCOL_PROGRAM_ID_MAINNET;
  }
}

/** Default values for timeouts, retries, and batch sizes. */
export const DEFAULTS = {
  SUBSCRIPTION_TIMEOUT_MS: 120_000,
  PING_TIMEOUT_MS: 3_000,
  PING_RETRIES: 2,
  PING_CACHE_TTL_MS: 30_000,
  PAYMENT_EXPIRY_SECS: 600,
  BATCH_SIZE: 250,
  QUERY_TIMEOUT_MS: 15_000,
  EOSE_TIMEOUT_MS: 3_000,
  VERIFY_RETRIES: 10,
  VERIFY_INTERVAL_MS: 3_000,
  VERIFY_BY_REF_RETRIES: 15,
  VERIFY_BY_REF_INTERVAL_MS: 2_000,
  RESULT_RETRY_COUNT: 3,
  RESULT_RETRY_BASE_MS: 1_000,
  QUERY_MAX_CONCURRENCY: 6,
  VERIFY_SIGNATURE_LIMIT: 25,
  // Default ceiling for a single iroh file transfer (seed/fetch). A tunable
  // default, not a protocol constant - the transfer is resumable and its own
  // budget, decoupled from the result-wait window.
  IROH_FETCH_TIMEOUT_MS: 300_000,
  // Ceiling for a single iroh SEED (addFromPath/addBytes/share). Seeding is local
  // (hash + store-copy + ticket mint), so this is a generous backstop: it bounds
  // the JS await so a wedged native call surfaces as a thrown error (and triggers a
  // node reset) instead of an indefinite hang that stalls file delivery.
  IROH_SEED_TIMEOUT_MS: 120_000,
  // Ceiling for a single Blossom blob upload (PUT /upload). Large blobs (up to
  // LIMITS.MAX_FILE_SIZE) need far more than the 30s used for small media images.
  BLOSSOM_UPLOAD_TIMEOUT_MS: 300_000,
  // Ceiling for a single encrypted Blossom blob download (GET). Same budget as upload.
  BLOSSOM_FETCH_TIMEOUT_MS: 300_000,
  // NIP-59 randomizes gift-wrap/seal timestamps up to 2 days into the past.
  // Every `since` filter on kind 1059 must be widened by this much (with a
  // zero floor), and ordering must use the rumor's real created_at instead.
  DM_WRAP_TIMESTAMP_SLACK_SECS: 172_800,
  // Rumors stamped further than this into the future are dropped - a hostile
  // sender must not pin a message to the top of a conversation forever.
  DM_FUTURE_SKEW_SECS: 600,
  // Default fetchHistory window when the caller passes no `since` (30 days).
  DM_HISTORY_WINDOW_SECS: 2_592_000,
  // Per-request ceiling for a single external-identity proof fetch (gist raw /
  // X oEmbed / NIP-05 nostr.json). Verification is lazy and on-demand, so a
  // hanging host must fail into `unverifiable` quickly.
  IDENTITY_PROOF_FETCH_TIMEOUT_MS: 10_000,
  // Identity verification results cache (in-process, per claim set): 1 h for
  // definitive results, 5 min for `unverifiable` so transient failures
  // (429/5xx/timeouts) retry sooner.
  IDENTITY_VERIFY_CACHE_TTL_MS: 3_600_000,
  IDENTITY_VERIFY_NEGATIVE_CACHE_TTL_MS: 300_000,
} as const;

/** Protocol limits for input validation. */
export const LIMITS = {
  MAX_INPUT_LENGTH: 100_000,
  // NIP-44 v2 hard cap on encrypted plaintext: the pad() length prefix is a u16,
  // so the plaintext can be at most 65_535 BYTES (not chars). Encrypting anything
  // larger throws `invalid plaintext size` inside nip44Encrypt. This is the binding
  // limit for TARGETED (encrypted) jobs - lower than every relay's NIP-11 cap.
  NIP44_MAX_PLAINTEXT_BYTES: 65_535,
  // Spill threshold for encrypted content: above this many UTF-8 bytes, callers
  // route the text through iroh out-of-band instead of inlining it. A non-spilled
  // job is encrypted RAW (no envelope - see marketplace.submitJobRequest), so a
  // 60_000-byte input is a 60_000-byte plaintext; the ~5.5KB gap under the hard cap
  // is plain slack, and NIP44_MAX_PLAINTEXT_BYTES is the SDK backstop.
  MAX_ENCRYPTED_INLINE_BYTES: 60_000,
  // Ceiling above which a text/* attachment is NOT materialized back into a string
  // (re-inlined into SkillInput.data) - the consumer gets a filePath / explicit
  // fetch instead. Also bounds the in-memory git-diff buffer (memory-DoS guard).
  MAX_REINLINE_TEXT_BYTES: 4_194_304, // 4 MiB
  // Hard safety cap on a single file transferred via iroh, enforced on the
  // actual streamed bytes (never the sender-declared `size`). A tunable default;
  // providers may lower it per deployment.
  MAX_FILE_SIZE: 1_073_741_824, // 1 GiB
  // Cap for the ENCRYPTED Blossom path (web/SDK). The encrypt-then-upload flow is
  // whole-buffer in WebCrypto + BlossomService (~3x file-size peak RAM), so this is
  // deliberately far below MAX_FILE_SIZE to stay safe in a browser tab; larger files
  // use iroh. The relay enforces a ~128 MiB server-side backstop.
  MAX_BLOSSOM_ENCRYPTED_BYTES: 104_857_600, // 100 MiB

  MAX_TIMEOUT_SECS: 600,
  // Upper bound for execution budgets (`max_execution_secs` / `execution_timeout_secs`).
  // Distinct from MAX_TIMEOUT_SECS (the result-wait cap): execution budgets may be
  // hours, so this exists only to keep `secs * 1000` within Node's setTimeout limit
  // (2_147_483_647 ms) - a larger value overflows and fires the timer immediately.
  MAX_EXECUTION_SECS: 2_147_483,
  MAX_CAPABILITIES: 20,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_AGENT_NAME_LENGTH: 64,
  MAX_CAPABILITY_LENGTH: 64,
  MAX_POLICY_CONTENT_LENGTH: 50_000,
  MAX_POLICIES_PER_AGENT: 12,
  MAX_POLICY_TYPE_LENGTH: 32,
  MAX_POLICY_TITLE_LENGTH: 120,
  MAX_POLICY_SUMMARY_LENGTH: 280,
  MAX_POLICY_VERSION_LENGTH: 32,
  // Direct messages (NIP-17). Two independent caps because the sealed payload
  // is JSON of the rumor: escape-heavy content (control chars become 6-byte
  // \uXXXX sequences) can blow the NIP-44 65_535-byte cap at the WRAP layer
  // (the seal ciphertext is JSON-wrapped and encrypted again) even when the
  // char count is small. 40_000 JSON bytes keeps the double envelope under
  // the cap with real margin (hard edge measured at ~40.6KB on nostr-tools
  // 2.23.3).
  MAX_MESSAGE_LENGTH: 10_000,
  MAX_MESSAGE_JSON_BYTES: 40_000,
  // External identities (NIP-39 kind 10011 + NIP-05). The tag cap is counted
  // AFTER the platform whitelist filter, so a foreign multi-platform event
  // cannot starve a claim behind unrelated platforms.
  MAX_IDENTITY_TAGS: 8,
  // Streamed-byte cap on a fetched proof body. A body over the cap maps to
  // `unverifiable` - a truncated body must never be substring-searched into a
  // false npub mismatch.
  MAX_IDENTITY_PROOF_BYTES: 65_536, // 64 KiB
  MAX_IDENTITY_VERIFY_CACHE_ENTRIES: 256,
  // Pre-regex length guards for identity handles / proof ids (GitHub username
  // max 39, gist hex max 64; the per-platform regexes narrow further).
  MAX_IDENTITY_HANDLE_LENGTH: 39,
  MAX_IDENTITY_PROOF_ID_LENGTH: 64,
  /** Full `local@domain` NIP-05 identifier length cap. */
  MAX_IDENTITY_NIP05_LENGTH: 254,
} as const;

const UTF8_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of a string. All size guards on encrypted content measure
 * BYTES, not `String.length` (UTF-16 code units): NIP-44's plaintext cap is a
 * byte cap, so a multibyte string under the char cap can still exceed it.
 */
export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}
