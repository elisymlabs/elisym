import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The owner key O: a pasted or generated secret key kept in this tab's
 * memory only. Every signature and every NIP-44 operation of the admin goes
 * through this.
 */
export interface Signer {
  /** O, hex. */
  readonly pubkey: string;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  /** NIP-44 v2 from O to `peer`. */
  encrypt(plaintext: string, peer: string): Promise<string>;
  /** NIP-44 v2 from `peer` to O. */
  decrypt(ciphertext: string, peer: string): Promise<string>;
}

/** A signer over a secret key held in this tab's memory only. */
export function secretKeySigner(secretKey: Uint8Array): Signer {
  const key = Uint8Array.from(secretKey);
  const pubkey = getPublicKey(key);
  return {
    pubkey,
    signEvent: async (template) => finalizeEvent(template, key),
    encrypt: async (plaintext, peer) =>
      nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(key, peer)),
    decrypt: async (ciphertext, peer) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(key, peer)),
  };
}

/** A secret key from an nsec or 64 hex characters, or undefined. */
export function parseSecretKey(input: string): Uint8Array | undefined {
  const value = input.trim();
  if (HEX_KEY_RE.test(value.toLowerCase())) {
    return hexToBytes(value.toLowerCase());
  }
  if (!value.startsWith('nsec1')) {
    return undefined;
  }
  try {
    const decoded = nip19.decode(value);
    return decoded.type === 'nsec' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** A public key (hex) from an npub or 64 hex characters, or undefined. */
export function parsePublicKey(input: string): string | undefined {
  const value = input.trim();
  if (HEX_KEY_RE.test(value.toLowerCase())) {
    return value.toLowerCase();
  }
  if (!value.startsWith('npub1')) {
    return undefined;
  }
  try {
    const decoded = nip19.decode(value);
    return decoded.type === 'npub' ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

export interface OwnerKey {
  secretKey: Uint8Array;
  nsec: string;
  npub: string;
}

/** An owner key in the forms the admin shows. */
export function ownerKeyOf(secretKey: Uint8Array): OwnerKey {
  return {
    secretKey,
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

/** A new owner key, to be shown once. */
export function generateOwnerKey(): OwnerKey {
  return ownerKeyOf(generateSecretKey());
}

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
