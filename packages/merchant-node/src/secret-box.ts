/**
 * A secret sealed with a passphrase, in the same format as the agents' secrets
 * in `@elisym/sdk` (a value either one encrypts, the other opens):
 * `encrypted:v1:` + base64(salt 16 | iv 12 | ciphertext | tag 16), AES-256-GCM
 * under a key from scrypt N=2^17, r=8, p=1. Copied, not imported: the node
 * does not depend on the sdk.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'encrypted:v1:';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** Twice what N=2^17, r=8 needs: Node's 32 MiB default refuses it. */
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

function deriveKey(passphrase: string, salt: Uint8Array): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function encryptSecret(plaintext: string, passphrase: string): string {
  if (passphrase === '') {
    throw new Error('the passphrase must not be empty');
  }
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([salt, iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** Throws on a wrong passphrase or a damaged value: the GCM tag does not verify. */
export function decryptSecret(sealed: string, passphrase: string): string {
  if (!isEncrypted(sealed)) {
    throw new Error('the value is not encrypted');
  }
  if (passphrase === '') {
    throw new Error('the passphrase must not be empty');
  }
  const payload = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  if (payload.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('the encrypted value is too short');
  }
  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH, payload.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase, or a damaged keys.json');
  }
}
