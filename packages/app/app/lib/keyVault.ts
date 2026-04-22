/**
 * KeyVault — encrypts Nostr secret keys at rest using Web Crypto API.
 *
 * Storage layout:
 *   localStorage  "elisym:vault"     → JSON { iv: base64, data: base64 }
 *   IndexedDB     "elisym-cache/kv"  → key "vault-key" → CryptoKey (non-extractable)
 *
 * Future upgrade path (Phase 2):
 *   Add "elisym:vault-mode" ("auto" | "password") + "elisym:vault-salt".
 *   Derive key via PBKDF2 from user password, re-encrypt, delete auto CryptoKey.
 */

import type { StoredIdentity } from '~/hooks/useIdentity';

const VAULT_KEY = 'elisym:vault';
const IDB_KEY = 'vault-key';

const DB_NAME = 'elisym-cache';
const STORE_NAME = 'kv';

// ── IndexedDB helpers (reuse existing DB) ──────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Crypto helpers ─────────────────────────────────────────────────

async function getOrCreateKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(IDB_KEY);
  if (existing) {
    return existing;
  }

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
  await idbSet(IDB_KEY, key);
  return key;
}

interface EncryptedBlob {
  v: 1; // schema version for future PBKDF2 migration
  iv: string; // base64
  data: string; // base64
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoded.buffer as ArrayBuffer,
  );
  return { v: 1, iv: toBase64(iv.buffer as ArrayBuffer), data: toBase64(ciphertext) };
}

async function decrypt(key: CryptoKey, blob: EncryptedBlob): Promise<string> {
  const iv = fromBase64(blob.iv);
  const data = fromBase64(blob.data);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    data.buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}

// ── Public API ─────────────────────────────────────────────────────

export async function loadIdentities(): Promise<StoredIdentity[]> {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) {
    return [];
  }

  try {
    const blob: EncryptedBlob = JSON.parse(raw);
    const key = await getOrCreateKey();
    const json = await decrypt(key, blob);
    return JSON.parse(json) as StoredIdentity[];
  } catch {
    // CryptoKey lost (IndexedDB cleared) or corrupt data — cannot recover
    localStorage.removeItem(VAULT_KEY);
    return [];
  }
}

export async function saveIdentities(list: StoredIdentity[]): Promise<void> {
  const key = await getOrCreateKey();
  const blob = await encrypt(key, JSON.stringify(list));
  localStorage.setItem(VAULT_KEY, JSON.stringify(blob));
}
