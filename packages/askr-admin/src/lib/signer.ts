import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The owner key O, whichever way it is held: a pasted or generated secret
 * key kept in memory only, or a NIP-07 browser extension. Every signature and
 * every NIP-44 operation of the admin goes through this.
 */
export interface Signer {
  /** O, hex. */
  readonly pubkey: string;
  readonly kind: 'secret-key' | 'extension';
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  /** NIP-44 v2 from O to `peer`. */
  encrypt(plaintext: string, peer: string): Promise<string>;
  /** NIP-44 v2 from `peer` to O. */
  decrypt(ciphertext: string, peer: string): Promise<string>;
}

/** What the admin needs of a NIP-07 extension (`window.nostr`). */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/** A signer over a secret key held in this tab's memory only. */
export function secretKeySigner(secretKey: Uint8Array): Signer {
  const key = Uint8Array.from(secretKey);
  const pubkey = getPublicKey(key);
  return {
    pubkey,
    kind: 'secret-key',
    signEvent: async (template) => finalizeEvent(template, key),
    encrypt: async (plaintext, peer) =>
      nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(key, peer)),
    decrypt: async (ciphertext, peer) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(key, peer)),
  };
}

/**
 * A signer over a NIP-07 extension. Every event it returns is checked: the
 * right author, the right kind, a valid signature.
 */
export async function extensionSigner(provider: Nip07Provider): Promise<Signer> {
  const pubkey = (await provider.getPublicKey()).toLowerCase();
  if (!HEX_KEY_RE.test(pubkey)) {
    throw new Error('The extension did not give a valid public key');
  }
  const nip44Of = () => {
    if (provider.nip44 === undefined) {
      throw new Error('The extension does not support NIP-44 encryption');
    }
    return provider.nip44;
  };
  return {
    pubkey,
    kind: 'extension',
    async signEvent(template) {
      const event = await provider.signEvent(template);
      if (event.pubkey !== pubkey || event.kind !== template.kind || !verifyEvent(event)) {
        throw new Error('The extension returned an event that is not signed by your key');
      }
      return event;
    },
    encrypt: (plaintext, peer) => nip44Of().encrypt(peer, plaintext),
    decrypt: (ciphertext, peer) => nip44Of().decrypt(peer, ciphertext),
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

/** A new owner key, to be shown once. */
export function generateOwnerKey(): { secretKey: Uint8Array; nsec: string; npub: string } {
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

export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function isNip07Provider(value: unknown): value is Nip07Provider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getPublicKey') === 'function' &&
    typeof Reflect.get(value, 'signEvent') === 'function'
  );
}

/** The extension the page sees, if any. */
export function windowNostr(): Nip07Provider | undefined {
  const candidate: unknown = Reflect.get(window, 'nostr');
  return isNip07Provider(candidate) ? candidate : undefined;
}
