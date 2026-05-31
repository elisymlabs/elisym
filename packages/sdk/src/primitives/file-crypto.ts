/**
 * Hybrid file encryption for the Blossom transport (browser-safe).
 *
 * NIP-44 is text-only and capped at ~64 KB, so it cannot encrypt a file directly. Instead this uses
 * the standard hybrid scheme: a fresh random AES-256-GCM content key encrypts the file bytes, and that
 * small key is NIP-44-wrapped to the recipient's pubkey. The recipient unwraps the key (with their
 * secret key + the sender's pubkey) and decrypts the bytes.
 *
 * WebCrypto only (`crypto.subtle` + `crypto.getRandomValues`) - NO `node:crypto`, NO `Buffer` - so it
 * runs in the browser. The IV is non-secret and travels in the transport descriptor (`enc.iv`).
 */
import { nip44Decrypt, nip44Encrypt } from './crypto';

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length

// base64 helpers (browser-safe via btoa/atob). Only ever applied to the tiny content key (32 B) and
// IV (12 B) - never to the file bytes, which are uploaded raw - so the per-char loop cost is trivial.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export interface EncryptedBytes {
  /** AES-256-GCM ciphertext with the 16-byte auth tag appended (WebCrypto layout). */
  ciphertext: Uint8Array;
  /** NIP-44-wrapped content key (sender secret key -> recipient pubkey). */
  wrappedKey: string;
  /** base64 GCM IV (non-secret). */
  iv: string;
}

/** Encrypt `bytes` so that only `recipientPubkey` (with the sender's pubkey) can decrypt. */
export async function encryptBytesForRecipient(
  bytes: Uint8Array,
  senderSk: Uint8Array,
  recipientPubkey: string,
): Promise<EncryptedBytes> {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, bytes);
  const wrappedKey = nip44Encrypt(bytesToBase64(rawKey), senderSk, recipientPubkey);
  return { ciphertext: new Uint8Array(ct), wrappedKey, iv: bytesToBase64(iv) };
}

/**
 * Decrypt bytes produced by `encryptBytesForRecipient`. Throws on any tamper (GCM auth tag), a
 * corrupted/forged wrapped key (NIP-44 MAC), or the wrong receiver/sender key pair.
 */
export async function decryptBytesFromSender(
  ciphertext: Uint8Array,
  wrappedKey: string,
  iv: string,
  receiverSk: Uint8Array,
  senderPubkey: string,
): Promise<Uint8Array> {
  const rawKey = base64ToBytes(nip44Decrypt(wrappedKey, receiverSk, senderPubkey));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv), tagLength: 128 },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}
