import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The owner key O: a pasted, generated or remembered secret key kept in this
 * tab's memory only, in its own copy. Every signature of hosted mode goes
 * through this; `close` zeroes the copy, and nothing is signed after.
 */
export interface Signer {
  /** O, hex. */
  readonly pubkey: string;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  /** Zero the key: sign out. */
  close(): void;
}

/** A signer over its own copy of `secretKey`: the caller may zero theirs. */
export function secretKeySigner(secretKey: Uint8Array): Signer {
  let key: Uint8Array | undefined = Uint8Array.from(secretKey);
  const pubkey = getPublicKey(key);
  return {
    pubkey,
    signEvent: async (template) => {
      if (key === undefined) {
        throw new Error('signed out: the owner key is gone');
      }
      return finalizeEvent(template, key);
    },
    close: () => {
      key?.fill(0);
      key = undefined;
    },
  };
}

/** The public key (hex) of a secret key, or undefined when it is not a valid one. */
export function publicKeyOf(secretKey: Uint8Array): string | undefined {
  try {
    return getPublicKey(secretKey);
  } catch {
    return undefined;
  }
}

/** A secret key from an nsec or 64 hex characters, or undefined. */
export function parseSecretKey(input: string): Uint8Array | undefined {
  const value = input.trim();
  let secretKey: Uint8Array | undefined;
  if (HEX_KEY_RE.test(value.toLowerCase())) {
    secretKey = hexToBytes(value.toLowerCase());
  } else if (value.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(value);
      secretKey = decoded.type === 'nsec' ? decoded.data : undefined;
    } catch {
      secretKey = undefined;
    }
  }
  if (secretKey === undefined) {
    return undefined;
  }
  // Zero or past the curve order: no public key, so no signer either.
  if (publicKeyOf(secretKey) === undefined) {
    secretKey.fill(0);
    return undefined;
  }
  return secretKey;
}

export interface OwnerKey {
  secretKey: Uint8Array;
  nsec: string;
  npub: string;
}

/** A new owner key, to be shown once. */
export function generateOwnerKey(): OwnerKey {
  const secretKey = generateSecretKey();
  return {
    secretKey,
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}
