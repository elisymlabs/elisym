/**
 * Secret encryption/decryption for agent config files.
 * Uses scrypt (KDF) + AES-256-GCM (cipher).
 * Format: "encrypted:v1:" + base64(salt[16] + iv[12] + ciphertext + tag[16])
 *
 * scrypt params: N=2^17, r=8, p=1 (~128 MB RAM per derivation).
 *
 * Node.js/Bun only - not available in browsers. Reachable only via the
 * '@elisym/sdk/node' subpath, which browser bundlers will not resolve.
 */

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'encrypted:v1:';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
// v1: N=2^17 (OWASP minimum). v2 will use N=2^20 with format migration.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2; // 2x the minimum required memory

/** Check if a value is encrypted (has the encrypted:v1: prefix). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt a plaintext secret with a passphrase. Returns "encrypted:v1:base64...". Node.js/Bun only. */
export function encryptSecret(plaintext: string, passphrase: string): string {
  if (!passphrase) {
    throw new Error('Passphrase must not be empty.');
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([salt, iv, encrypted, tag]);
  return PREFIX + payload.toString('base64');
}

/** Decrypt an encrypted secret with a passphrase. Throws on wrong passphrase or corrupted data. Node.js/Bun only. */
export function decryptSecret(encrypted: string, passphrase: string): string {
  if (!isEncrypted(encrypted)) {
    throw new Error('Value is not encrypted (missing encrypted:v1: prefix).');
  }
  if (!passphrase) {
    throw new Error('Passphrase must not be empty.');
  }

  const payload = Buffer.from(encrypted.slice(PREFIX.length), 'base64');
  if (payload.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload is too short.');
  }

  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH, payload.length - TAG_LENGTH);

  const key = scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed. Wrong passphrase or corrupted data.');
  }
}
