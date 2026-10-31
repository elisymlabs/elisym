/**
 * The owner key (plan section 1): made or imported in the page, never sent to
 * the cloud, never stored. It lives only inside an `OwnerKey`, which the app
 * keeps in a ref and closes (zeroing the secret) on sign out.
 */
import * as nip19 from 'nostr-tools/nip19';
import {
  type EventTemplate,
  type NostrEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';

const HEX_SECRET = /^[0-9a-f]{64}$/i;

/** What signs for the owner: its pubkey, and events it finalizes. */
export interface OwnerSigner {
  readonly pubkey: string;
  sign(template: EventTemplate): NostrEvent;
}

export class OwnerKey implements OwnerSigner {
  #secret: Uint8Array | undefined;
  readonly pubkey: string;

  constructor(secret: Uint8Array) {
    this.pubkey = getPublicKey(secret);
    this.#secret = secret.slice();
  }

  /** A new owner key, made in the page. */
  static create(): OwnerKey {
    const secret = generateSecretKey();
    const key = new OwnerKey(secret);
    secret.fill(0);
    return key;
  }

  get npub(): string {
    return nip19.npubEncode(this.pubkey);
  }

  /** The nsec, for the file the merchant saves (and nothing else). */
  nsec(): string {
    return nip19.nsecEncode(this.#open());
  }

  sign(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.#open());
  }

  /** Zeroes the secret: the key signs nothing after. */
  close(): void {
    this.#secret?.fill(0);
    this.#secret = undefined;
  }

  #open(): Uint8Array {
    if (this.#secret === undefined) {
      throw new Error('the owner key was closed');
    }
    return this.#secret;
  }
}

/** An owner key from what the merchant pasted: an nsec or 64 hex characters, else undefined. */
export function parseOwnerKey(text: string): OwnerKey | undefined {
  const trimmed = text.trim();
  let secret: Uint8Array | undefined;
  if (HEX_SECRET.test(trimmed)) {
    secret = Uint8Array.from(trimmed.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  } else {
    try {
      const decoded = nip19.decode(trimmed);
      secret = decoded.type === 'nsec' ? decoded.data : undefined;
    } catch {
      secret = undefined;
    }
  }
  if (secret === undefined) {
    return undefined;
  }
  try {
    return new OwnerKey(secret);
  } catch {
    // Not a valid secp256k1 scalar (zero, or past the curve order).
    return undefined;
  } finally {
    secret.fill(0);
  }
}

/** The text of the file the merchant saves: the nsec, and what it is. */
export function ownerKeyFile(key: OwnerKey): string {
  return [
    '# Pay Core owner key. Keep this file safe and private.',
    '# It signs your payout list: anyone holding it can redirect new payments.',
    `# Store owner: ${key.npub}`,
    key.nsec(),
    '',
  ].join('\n');
}

/** The saved file's name: names the key by its npub's start, never by the secret. */
export function ownerKeyFileName(key: OwnerKey): string {
  return `paycore-owner-${key.npub.slice(0, 14)}.txt`;
}
