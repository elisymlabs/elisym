import type { ChainConfig } from '@elisym/pay-core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58, hex } from '@scure/base';
import { PAYTO_PROOF_PREFIX } from './constants';

const EVM_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;
const UTF8 = new TextEncoder();

/**
 * The exact text a payout wallet signs for an `accept` tag. A Solana wallet signs
 * its UTF-8 bytes with `signMessage`; an EVM wallet signs it with `personal_sign`
 * (EIP-191).
 */
export function paytoProofMessage(ownerPubkey: string, caip19: string): string {
  return `${PAYTO_PROOF_PREFIX}:${ownerPubkey}:${caip19}`;
}

/**
 * Whether `signature` proves that the wallet at `address` agreed to receive
 * `caip19` payments for `ownerPubkey`.
 *
 * Encodings, one per family and nothing else: Solana - the 64-byte ed25519
 * signature in base58, `address` the base58 public key; EVM - the 65-byte
 * `r || s || v` signature as `0x` hex, as `personal_sign` returns it, `address`
 * lowercase. Any malformed input is `false`, never a throw.
 */
export function verifyPaytoProof(params: {
  chain: ChainConfig;
  address: string;
  ownerPubkey: string;
  caip19: string;
  signature: string;
}): boolean {
  const message = UTF8.encode(paytoProofMessage(params.ownerPubkey, params.caip19));
  try {
    return params.chain.family === 'solana'
      ? verifyEd25519(message, params.signature, params.address)
      : verifyEip191(message, params.signature, params.address);
  } catch {
    return false;
  }
}

function verifyEd25519(message: Uint8Array, signature: string, address: string): boolean {
  const signatureBytes = base58.decode(signature);
  const publicKey = base58.decode(address);
  if (
    signatureBytes.length !== ED25519_SIGNATURE_BYTES ||
    publicKey.length !== ED25519_PUBLIC_KEY_BYTES
  ) {
    return false;
  }
  // zip215: false is the strict RFC 8032 check, which is what Solana wallets produce.
  return ed25519.verify(signatureBytes, message, publicKey, { zip215: false });
}

/** keccak256("\x19Ethereum Signed Message:\n" + len(message) + message). */
export function eip191Hash(message: Uint8Array): Uint8Array {
  const prefix = UTF8.encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const payload = new Uint8Array(prefix.length + message.length);
  payload.set(prefix, 0);
  payload.set(message, prefix.length);
  return keccak_256(payload);
}

function verifyEip191(message: Uint8Array, signature: string, address: string): boolean {
  if (!EVM_SIGNATURE_RE.test(signature)) {
    return false;
  }
  const bytes = hex.decode(signature.slice(2).toLowerCase());
  const recoveryByte = bytes[64];
  if (recoveryByte === undefined) {
    return false;
  }
  // Wallets write v as 27/28; some write the bare recovery id 0/1.
  const recovery = recoveryByte >= 27 ? recoveryByte - 27 : recoveryByte;
  if (recovery !== 0 && recovery !== 1) {
    return false;
  }
  // noble's 'recovered' format puts the recovery id FIRST: [v, r, s].
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(bytes.subarray(0, 64), 1);
  const publicKey = secp256k1.recoverPublicKey(recovered, eip191Hash(message), {
    prehash: false,
  });
  return evmAddressOf(publicKey) === address.toLowerCase();
}

function evmAddressOf(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const digest = keccak_256(uncompressed.subarray(1));
  return `0x${hex.encode(digest.subarray(12))}`;
}
