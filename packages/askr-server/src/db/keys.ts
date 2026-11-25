import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

export type KeyPurpose = 'assistant' | 'catalog' | 'delegate';

/** What a sealed secret text is (associated data along with its context). */
export type TextPurpose = 'shopify-access' | 'shopify-refresh';

const MAX_TEXT_BYTES = 4096;

/**
 * Store secret keys (A, the server K) encrypted at rest with the master key
 * (9), AES-256-GCM. The owner and the key's purpose are the associated data,
 * so a ciphertext copied to another row or column does not decrypt.
 */
export class KeyVault {
  private readonly masterKey: Buffer;

  constructor(masterKeyHex: string) {
    if (!HEX_KEY_RE.test(masterKeyHex)) {
      throw new Error('The master key must be 32 bytes as lowercase hex');
    }
    this.masterKey = Buffer.from(masterKeyHex, 'hex');
  }

  seal(secretKey: Uint8Array, owner: string, purpose: KeyPurpose): Uint8Array {
    if (secretKey.length !== KEY_BYTES) {
      throw new Error('A secret key is 32 bytes');
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    cipher.setAAD(associatedData(owner, purpose));
    const body = Buffer.concat([cipher.update(secretKey), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
  }

  open(sealed: Uint8Array, owner: string, purpose: KeyPurpose): Uint8Array {
    if (sealed.length !== 1 + NONCE_BYTES + KEY_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
      throw new Error('Not a sealed key');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const body = sealed.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + KEY_BYTES);
    const tag = sealed.subarray(1 + NONCE_BYTES + KEY_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAAD(associatedData(owner, purpose));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  }

  /** A secret text (an access token) sealed like a key, bound to `context` and `purpose`. */
  sealText(text: string, context: string, purpose: TextPurpose): Uint8Array {
    const plain = Buffer.from(text, 'utf8');
    if (plain.length === 0 || plain.length > MAX_TEXT_BYTES) {
      throw new Error('A sealed text is 1 to 4096 bytes');
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    cipher.setAAD(textAssociatedData(context, purpose));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
  }

  openText(sealed: Uint8Array, context: string, purpose: TextPurpose): string {
    if (sealed.length <= 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
      throw new Error('Not a sealed text');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const body = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAAD(textAssociatedData(context, purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

function textAssociatedData(context: string, purpose: TextPurpose): Buffer {
  return Buffer.from(`askr-text:${purpose}:${context}`, 'utf8');
}

function associatedData(owner: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(`askr:${purpose}:${owner}`, 'utf8');
}
