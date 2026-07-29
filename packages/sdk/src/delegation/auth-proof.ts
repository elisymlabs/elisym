/**
 * Delegated job payment - the per-job proof-of-control (v3, single-use,
 * short-lived).
 *
 * A customer who `approve`d a provider's delegate key authorizes ONE delegated
 * job by signing a short, human-legible message with the OWNER key (the Solana
 * account funds are pulled from). The provider verifies the signature against
 * the `delegation_owner` tag before pulling the price from the delegation, so a
 * third party who merely observes the public tags can never trigger spend from
 * someone else's allowance.
 *
 * {@link buildAuthMessage} is the ONLY place the byte layout lives - SDK sign,
 * SDK verify, and the web app's wallet `signMessage` path all import it, so the
 * bytes cannot drift. The message is domain-separated and length-prefixes each
 * field so no field value can inject a fake line.
 *
 * Crypto is `@solana/kit` only (`signBytes` / `verifySignature` /
 * `getPublicKeyFromAddress`); base58 via the kit codecs. No `@noble`, no
 * `tweetnacl`.
 */

import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  signBytes,
  verifySignature,
  type KeyPairSigner,
  type SignatureBytes,
} from '@solana/kit';

/** NIP-90 top-level tag names for the delegated payment mode. */
export const DELEGATED_PAYMENT_TAG = 'payment';
export const DELEGATED_PAYMENT_MODE = 'delegated';
export const DELEGATION_OWNER_TAG = 'delegation_owner';
export const DELEGATION_EXPIRY_TAG = 'delegation_expiry';
export const DELEGATION_NONCE_TAG = 'delegation_nonce';
export const DELEGATION_PROOF_TAG = 'delegation_proof';

/**
 * Upper bound on how far in the future a proof may expire. A proof is a spend
 * authorization; keeping the window short caps how long a leaked/phished proof
 * stays usable. Customers mint `expiry = now + MAX_PROOF_TTL_SECS`.
 */
export const MAX_PROOF_TTL_SECS = 600;

/**
 * Small allowance for the verifier's clock running behind the prover's when
 * checking the `expiry <= now + MAX_PROOF_TTL_SECS` horizon.
 */
export const PROOF_CLOCK_SKEW_SECS = 60;

/** base58 Solana material (32-44 chars, excludes 0 O I l). Mirrors schema.ts. */
const BASE58_32_44_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Single-use nonce: base58, fixed 32-44 char length (32 random bytes). */
export const DELEGATION_NONCE_REGEX = BASE58_32_44_REGEX;

/** Ed25519 signature, base58 (64 bytes encode to 86-88 chars). */
export const DELEGATION_PROOF_REGEX = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

const NOSTR_PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/** Bound expiry parsing well clear of anything a `Number` could mangle. */
const MAX_EXPIRY_UNIX = 100_000_000_000; // year ~5138

export interface DelegationAuthFields {
  /** The provider's delegate pubkey (base58) - binds the proof to ONE provider. */
  agentDelegate: string;
  /** The Nostr request author pubkey (64-char hex) - binds the proof to ONE author. */
  nostrAuthor: string;
  /** The owner base58 Solana address: source of funds AND the verify key. */
  owner: string;
  /** Unix seconds after which the proof is dead. */
  expiryUnix: number;
  /** Single-use base58 nonce (32-44 chars). */
  nonce: string;
}

function assertField(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Invalid delegation auth field: ${message}`);
  }
}

/**
 * Build the exact bytes the owner signs. Human-legible (a wallet `signMessage`
 * prompt shows real words), domain-separated by the fixed first line, and each
 * field value is length-prefixed (`<byte-length>:<value>`) so a crafted value
 * can never masquerade as an extra line. Throws on any malformed field -
 * shared by sign AND verify, so both sides enforce the same formats.
 */
export function buildAuthMessage(fields: DelegationAuthFields): Uint8Array {
  assertField(
    BASE58_32_44_REGEX.test(fields.agentDelegate),
    'agentDelegate must be a base58 Solana address',
  );
  assertField(
    NOSTR_PUBKEY_REGEX.test(fields.nostrAuthor),
    'nostrAuthor must be a 64-char hex Nostr pubkey',
  );
  assertField(BASE58_32_44_REGEX.test(fields.owner), 'owner must be a base58 Solana address');
  assertField(
    Number.isInteger(fields.expiryUnix) &&
      fields.expiryUnix > 0 &&
      fields.expiryUnix <= MAX_EXPIRY_UNIX,
    'expiryUnix must be a positive unix-seconds integer',
  );
  assertField(
    DELEGATION_NONCE_REGEX.test(fields.nonce),
    'nonce must be base58 with 32-44 characters',
  );

  const line = (label: string, value: string): string => `${label}=${value.length}:${value}`;
  const message = [
    'elisym delegated-payment authorization (v1)',
    line('agent-delegate', fields.agentDelegate),
    line('nostr-author', fields.nostrAuthor),
    line('owner', fields.owner),
    line('expires', String(fields.expiryUnix)),
    line('nonce', fields.nonce),
  ].join('\n');
  return new TextEncoder().encode(message);
}

/** Mint a fresh single-use nonce: 32 random bytes, base58 (43-44 chars). */
export function mintDelegationNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return getBase58Decoder().decode(bytes);
}

export interface BuildDelegationAuthProofArgs extends DelegationAuthFields {
  /** The owner's keypair signer (holds the extractable-to-sign private key). */
  ownerSigner: KeyPairSigner;
}

/**
 * Sign the auth message with the owner key. The signer's address must equal
 * `owner` - a proof signed by any other key would never verify, so failing
 * loud here beats a confusing rejection at the provider. Returns the base58
 * signature for the `delegation_proof` tag.
 */
export async function buildDelegationAuthProof(
  args: BuildDelegationAuthProofArgs,
): Promise<string> {
  if (args.ownerSigner.address !== args.owner) {
    throw new Error(
      `Delegation proof signer (${args.ownerSigner.address}) must be the owner (${args.owner})`,
    );
  }
  const message = buildAuthMessage(args);
  const signatureBytes = await signBytes(args.ownerSigner.keyPair.privateKey, message);
  return getBase58Decoder().decode(signatureBytes);
}

export interface VerifyDelegationAuthProofArgs extends DelegationAuthFields {
  /** The base58 Ed25519 signature from the `delegation_proof` tag. */
  proof: string;
}

/**
 * Verify a delegated-payment proof against the owner address (the `owner`
 * field IS the verify key). Fail-closed: any malformed field, undecodable
 * proof, or crypto error returns `false` - this runs in the provider's job
 * loop against attacker-controlled tags and must never throw.
 *
 * Deliberately does NOT check expiry: time-bound checks (and the single-use
 * nonce) are the caller's, so a "valid signature, expired proof" rejection can
 * be reported distinctly.
 */
export async function verifyDelegationAuthProof(
  args: VerifyDelegationAuthProofArgs,
): Promise<boolean> {
  try {
    if (!DELEGATION_PROOF_REGEX.test(args.proof)) {
      return false;
    }
    const signatureBytes = getBase58Encoder().encode(args.proof) as SignatureBytes;
    if (signatureBytes.length !== 64) {
      return false;
    }
    const message = buildAuthMessage(args);
    const ownerKey = await getPublicKeyFromAddress(address(args.owner));
    return await verifySignature(ownerKey, signatureBytes, message);
  } catch {
    return false;
  }
}
