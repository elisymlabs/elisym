import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

export class ElisymIdentity {
  private _secretKey: Uint8Array;
  readonly publicKey: string;
  readonly npub: string;

  get secretKey(): Uint8Array {
    return new Uint8Array(this._secretKey);
  }

  private constructor(secretKey: Uint8Array) {
    this._secretKey = new Uint8Array(secretKey);
    this.publicKey = getPublicKey(secretKey);
    this.npub = nip19.npubEncode(this.publicKey);
  }

  static generate(): ElisymIdentity {
    return new ElisymIdentity(generateSecretKey());
  }

  static fromSecretKey(sk: Uint8Array): ElisymIdentity {
    if (sk.length !== 32) {
      throw new Error('Secret key must be exactly 32 bytes.');
    }
    return new ElisymIdentity(sk);
  }

  toJSON(): { publicKey: string; npub: string } {
    return { publicKey: this.publicKey, npub: this.npub };
  }

  /** Best-effort scrub of the secret key bytes in memory. */
  scrub(): void {
    this._secretKey.fill(0);
  }

  static fromHex(hex: string): ElisymIdentity {
    if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('Invalid secret key hex: expected 64 hex characters (32 bytes).');
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 64; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return new ElisymIdentity(bytes);
  }
}
