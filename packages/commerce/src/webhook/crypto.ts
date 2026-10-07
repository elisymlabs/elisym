/**
 * The few primitives both sides share: UTF-8, hex, HMAC-SHA256 on WebCrypto,
 * and a constant-time compare. No Node or DOM globals beyond `crypto.subtle`,
 * `TextEncoder` and `TextDecoder`, so the same code runs on Node 20+, Bun,
 * Deno, edge runtimes and Workers.
 */
import { WEBHOOK_MIN_SECRET_BYTES } from './constants';

const UTF8_ENCODER = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/** Lowercase hex of the bytes. */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Bytes of a hex string the caller has already checked (even length, hex digits only). */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant time over equal lengths: every byte is compared, with no early exit.
 * The lengths are public (both are 32 bytes here).
 */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** The secret's UTF-8 bytes; throws (never quoting it) when it is not a long enough string. */
export function secretBytes(secret: unknown, caller: string): Uint8Array {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError(`${caller}: the secret must be a non-empty string`);
  }
  const bytes = utf8(secret);
  if (bytes.length < WEBHOOK_MIN_SECRET_BYTES) {
    throw new TypeError(
      `${caller}: the secret is shorter than ${WEBHOOK_MIN_SECRET_BYTES} UTF-8 bytes`,
    );
  }
  return bytes;
}

function webCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('@elisym/commerce/webhook needs globalThis.crypto.subtle (Node 20+)');
  }
  return subtle;
}

/** HMAC-SHA256(key, data): 32 bytes. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const subtle = webCrypto();
  const cryptoKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, data));
}

/** `${timestampText}.` then the body bytes, never re-encoding a byte body. */
export function signedBytes(timestampText: string, body: string | Uint8Array): Uint8Array {
  const prefix = utf8(`${timestampText}.`);
  const bodyBytes = typeof body === 'string' ? utf8(body) : body;
  const data = new Uint8Array(prefix.length + bodyBytes.length);
  data.set(prefix, 0);
  data.set(bodyBytes, prefix.length);
  return data;
}
