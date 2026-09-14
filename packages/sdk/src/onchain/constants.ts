/**
 * Shared bounds for on-chain action capabilities.
 *
 * A capability in this family delivers a Solana call that the CUSTOMER signs -
 * the provider never signs and never takes custody. Everything here bounds
 * untrusted provider output before it reaches a decoder, a simulation or a
 * wallet. Design: `docs/plans/onchain-action-skills.md`.
 */

import type { OnchainRefusalReason } from './types';

/** Envelope version. Bumped only for a breaking change to the wire shape. */
/**
 * The System program, which four files here need to name. Defined once: it
 * decides a durable nonce, a bare wallet, a reassignment and a closed account,
 * and four copies of one magic string is four chances for them to disagree.
 */
export const SYSTEM_PROGRAM_ADDRESS_STR = '11111111111111111111111111111111';

export const ONCHAIN_CALL_VERSION = 'v1';

/**
 * Solana's transport limit for a serialized transaction (PACKET_DATA_SIZE
 * 1280 minus the 40-byte IPv6 header and the 8-byte fragment header). A larger
 * transaction can never land, so accepting one only buys a provider free decode
 * work on the client.
 */
export const MAX_WIRE_TRANSACTION_BYTES = 1232;

/**
 * Base64 ceiling for `transaction`, derived from the byte limit above:
 * ceil(1232 / 3) * 4 = 1644 characters including padding. Enforced by the
 * schema, i.e. BEFORE the string is decoded.
 */
export const MAX_CALL_BASE64_CHARS = 1644;

/**
 * Instruction ceiling for one call. A routed swap sits in the low tens; this
 * bounds the decode, the simulation request and the display list without
 * excluding real DeFi traffic.
 */
export const MAX_INSTRUCTIONS_PER_CALL = 32;

/**
 * Unique account addresses one call may hold, lookup-table entries included.
 *
 * Solana's own `MAX_TX_ACCOUNT_LOCKS`, not a policy of ours: a message above it
 * cannot land, and kit refuses to compile one. The client's budget instructions
 * reference the ComputeBudget program, so a call that does not already name it
 * gets 63 rather than 64 - both sides account for that themselves.
 */
export const MAX_TRANSACTION_ACCOUNTS = 64;

/**
 * Program allowlist ceiling on a capability card.
 *
 * Generous on purpose. The allowlist must name every program a call reaches
 * INCLUDING through a CPI, and a router-backed swap - the first case this
 * feature exists for - fans out across a venue set in the tens. At 16 such a
 * capability could not describe itself, and the mismatch only surfaced as a
 * `program-not-on-card` refusal after the customer had paid. Nothing here is
 * load-bearing: it bounds the card's size and the set the verifier builds.
 */
export const MAX_PROGRAMS_PER_CARD = 48;

/** Parameter ceiling on a capability card (drives the client's input form). */
export const MAX_PARAMS_PER_CARD = 8;

/** Ceiling on the `requires` display hint. */
export const MAX_REQUIRES_PER_CARD = 4;

/** Ceiling on provider-supplied `explain` entries (display only, untrusted). */
export const MAX_EXPLAIN_ENTRIES = 8;

/**
 * How far ahead a call may claim to stay valid. A call is a signing request;
 * keeping the window short bounds how long a leaked or hoarded envelope stays
 * usable. Mirrors the delegation auth-proof's `MAX_PROOF_TTL_SECS` posture.
 */
export const MAX_CALL_TTL_SECS = 900;

/** Allowance for the verifier's clock running behind the provider's. */
export const CALL_CLOCK_SKEW_SECS = 60;

/** Upper bound on `expires_at`, well clear of anything a `Number` mangles. */
export const MAX_EXPIRY_UNIX = 100_000_000_000;

/** Character bounds for the free-form labels a card and an envelope carry. */
export const MAX_KIND_CHARS = 32;
export const MAX_PARAM_NAME_CHARS = 32;
export const MAX_PARAM_TYPE_CHARS = 32;
export const MAX_PARAM_DESCRIPTION_CHARS = 200;
export const MAX_EXPLAIN_TEXT_CHARS = 200;

/**
 * Default allowance for lamports that leave for reasons other than the action:
 * the network fee plus rent for accounts the call creates.
 *
 * Sized from the two things that actually land in it.
 *
 * RENT. `(128 + bytes)` times the cluster's rent rate, which is 6333 lamports
 * per byte on mainnet today and 5080 on devnet - measured with
 * `getMinimumBalanceForRentExemption`, not the 6960 an older note here assumed.
 * A real position open creates more than one account: a Drift first deposit
 * makes both the User (4376 B) and the UserStats (240 B), 30,854,376 lamports
 * together on mainnet; a Kamino obligation plus its UserMetadata is ~29.3M.
 * Sizing against a single account - which 0.035 SOL did - refused those, and
 * 0.02 refused every position account outright by covering only ~2.7 kB.
 *
 * FEE. Bounded by construction rather than measured: `MAX_COMPUTE_UNIT_LIMIT`
 * (1.4M) times `PRIORITY_FEE_CEILING` (5M microlamports/CU) plus the signature
 * is 7,005,000 lamports, plus 5,000 for every signature a precompile
 * instruction declares - at most 65 in a transaction that still fits 1232
 * bytes, so 7,330,000 all told. In practice the estimator reads per-slot MINIMUMS and
 * clamps to its floor, so the real figure is nearer 6.4k - but the ceiling is
 * what the bound has to survive, because a customer meeting it has already paid
 * and neither shipped client exposes this number to lift.
 *
 * 30,854,376 + 7,330,000 = 38,184,376, which 0.035 SOL did not cover and this
 * does. `onchain-verify.test.ts` pins that arithmetic so a future tightening
 * cannot silently reinstate the refusal. It applies only to a capability
 * priced in a TOKEN; a SOL-denominated one bounds rent with its own
 * `max_per_call`.
 */
export const DEFAULT_INCIDENTAL_LAMPORTS = 45_000_000n;

/** Hard ceiling on the incidental allowance, however a client configures it. */
export const MAX_INCIDENTAL_LAMPORTS = 100_000_000n;

/**
 * The one sentence every client shows before a call is signed, in the primary
 * flow and never in a footnote. It lives here so the browser and MCP say the
 * SAME thing: elisym bounds what a call can take and displays what it found;
 * it does not audit the program, and no wording may imply that it does.
 */
export const ONCHAIN_DISCLAIMER =
  'elisym checked this call against what the capability published, simulated it, and bounded ' +
  'what can leave your wallet. It has NOT audited the program you are about to call and cannot ' +
  'tell you it is safe.';

/**
 * Said whenever a call writes to accounts the verifier could not attribute to
 * the signer. Shared by both clients so the limit of the guarantee is described
 * identically wherever a customer meets it - and so no client can quietly
 * describe such a call as moving nothing.
 */
export const ONCHAIN_UNATTRIBUTED_NOTICE =
  'This call also writes to accounts elisym cannot attribute to you. If any of them holds funds ' +
  'on your behalf - a lending position, a stake account, an escrow - the limits above do not ' +
  'cover what this call does to them.';

/**
 * Human wording for every refusal, shared by both clients so the same rejection
 * reads identically wherever a customer meets it. The verifier's `detail`
 * carries the specifics; this is the headline.
 *
 * Keyed by the refusal union, not by `string`: a new reason is then a
 * type-checked addition here rather than two clients quietly falling back to
 * two different sentences for the same rejection.
 */
export const ONCHAIN_REFUSAL_HEADLINES: Record<OnchainRefusalReason, string> = {
  'malformed-card':
    "This capability's published promise could not be read, so nothing can be checked against it.",
  'malformed-envelope': 'This capability did not return a call elisym can read.',
  'wrong-network': 'This call was built for a different network.',
  'wrong-signer': 'This call was built for a different wallet.',
  expired: 'This call has expired. Ask the capability for a fresh one.',
  'expiry-too-far': 'This call claims to stay valid for too long.',
  'undecodable-transaction': 'This is not a readable Solana transaction.',
  'lookup-table-unavailable': "Part of this call's account list could not be read.",
  'already-signed': 'This call arrived already signed. Only unsigned calls are accepted.',
  'foreign-fee-payer': "This call would be paid for by someone else's account.",
  'durable-nonce-lifetime': 'This call never expires once signed.',
  'extra-signer-required': 'This call needs a signature from someone else too.',
  'malformed-instruction': 'This call is not shaped in a way elisym can sign.',
  'too-many-instructions': 'This call has more instructions than elisym will check.',
  'too-many-accounts': 'This call holds more accounts than a Solana transaction can carry.',
  'oversized-transaction': 'This call is too large to be sent to Solana at all.',
  'program-not-on-card': 'This call touches a program the capability never published.',
  'simulation-failed': 'This call fails against the current chain state.',
  'post-state-unavailable': 'The effect of this call could not be read, so it cannot be bounded.',
  'rpc-unavailable': 'The chain could not be reached to check this call.',
  'spend-ceiling-exceeded': 'This call moves more than you allowed.',
  'unexpected-asset-outflow': 'This call moves an asset the capability never published.',
  'fee-ceiling-exceeded': 'This call takes more SOL in fees and rent than you allowed.',
  'authority-grant-not-declared': 'This call leaves an approval the capability never published.',
  'authority-ceiling-exceeded': 'This call authorizes more future spending than you allowed.',
  'account-authority-changed': 'This call changes who controls one of your accounts.',
};
