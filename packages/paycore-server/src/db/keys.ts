import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;
export const MIN_SECRET_BYTES = 1;
export const MAX_SECRET_BYTES = 256;
export const DEFAULT_AD_PREFIX = 'paycore';

/** `store`: the store key S (32 bytes); `webhook`: the webhook signing secret. */
export type KeyPurpose = 'store' | 'webhook';

/**
 * Store secrets encrypted at rest with the master key, AES-256-GCM. The
 * associated data is `<prefix>:<purpose>:<owner>`, so a ciphertext copied to
 * another row or column, or sealed by another server sharing the master key,
 * does not decrypt.
 */
export class KeyVault {
  private readonly masterKey: Buffer;

  constructor(
    masterKeyHex: string,
    private readonly adPrefix: string = DEFAULT_AD_PREFIX,
  ) {
    if (!HEX_KEY_RE.test(masterKeyHex)) {
      throw new Error('The master key must be 32 bytes as lowercase hex');
    }
    if (adPrefix === '' || adPrefix.includes(':')) {
      throw new Error('The associated-data prefix must be non-empty and hold no colon');
    }
    this.masterKey = Buffer.from(masterKeyHex, 'hex');
  }

  seal(secret: Uint8Array, owner: string, purpose: KeyPurpose): Uint8Array {
    if (secret.length < MIN_SECRET_BYTES || secret.length > MAX_SECRET_BYTES) {
      throw new Error(`A sealed secret is ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes`);
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    cipher.setAAD(this.associatedData(owner, purpose));
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
  }

  open(sealed: Uint8Array, owner: string, purpose: KeyPurpose): Uint8Array {
    const bodyBytes = sealed.length - 1 - NONCE_BYTES - TAG_BYTES;
    if (bodyBytes < MIN_SECRET_BYTES || bodyBytes > MAX_SECRET_BYTES || sealed[0] !== VERSION) {
      throw new Error('Not a sealed secret');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const body = sealed.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + bodyBytes);
    const tag = sealed.subarray(1 + NONCE_BYTES + bodyBytes);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAAD(this.associatedData(owner, purpose));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  }

  private associatedData(owner: string, purpose: KeyPurpose): Buffer {
    return Buffer.from(`${this.adPrefix}:${purpose}:${owner}`, 'utf8');
  }
}
