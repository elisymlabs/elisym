import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { VISITOR_KEY_PREFIX } from './constants';
import { type KeyValueStorage, readItem, writeItem } from './storage';

const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export interface VisitorKey {
  secretKey: Uint8Array;
  pubkey: string;
  /** `browser`: kept in localStorage per store; `tab`: this page only (no storage). */
  scope: 'browser' | 'tab';
}

function fromHex(secretHex: string): Uint8Array | undefined {
  if (!SECRET_HEX_RE.test(secretHex)) {
    return undefined;
  }
  const secretKey = hexToBytes(secretHex);
  try {
    getPublicKey(secretKey);
    return secretKey;
  } catch {
    return undefined;
  }
}

/**
 * The visitor key V for one store (6): one per (browser, store) in
 * localStorage, or a fresh per-tab key when storage is refused.
 */
export function loadVisitorKey(owner: string, storage: KeyValueStorage | undefined): VisitorKey {
  const storageKey = `${VISITOR_KEY_PREFIX}${owner}`;
  const stored = readItem(storage, storageKey);
  const kept = stored === undefined ? undefined : fromHex(stored);
  if (kept) {
    return { secretKey: kept, pubkey: getPublicKey(kept), scope: 'browser' };
  }
  const secretKey = generateSecretKey();
  const saved = writeItem(storage, storageKey, bytesToHex(secretKey));
  // A write that did not stick (quota, a storage that drops writes) leaves a per-tab key.
  const persisted = saved && readItem(storage, storageKey) === bytesToHex(secretKey);
  return { secretKey, pubkey: getPublicKey(secretKey), scope: persisted ? 'browser' : 'tab' };
}
