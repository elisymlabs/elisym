import { getPublicKey } from 'nostr-tools/pure';
import { publicKeyOf } from './signer';

/**
 * Secret keys remembered on this device, each sealed with AES-GCM under a
 * device key this browser made for the admin. The device key is a
 * non-extractable WebCrypto key kept in IndexedDB: its bytes can never be
 * read out, so a copy of localStorage alone does not give the secret key
 * away. It is not a lock against whoever has this browser profile, nor
 * against script running on the admin's origin: either can use the device
 * key to open it, as the merchant chose by remembering it with no password.
 * Only the sealed form is written; the plain key never touches storage.
 *
 * One remembered key per Store ID, newest first: a merchant with several
 * stores picks one on the sign-in page, and remembering a key again for the
 * same Store ID replaces it.
 *
 * This is the only module that touches browser storage.
 */

const STORAGE_KEY = 'askr-admin.remembered-keys';
const PROBE_KEY = 'askr-admin.probe';
const FORMAT_VERSION = 2;
const PASSWORD_FORMAT_VERSION = 1;

const DEVICE_DB = 'askr-admin';
const DEVICE_DB_VERSION = 1;
const DEVICE_STORE = 'device';
const DEVICE_KEY_ID = 'remember-key';

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;
const SECRET_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The nonce, then the sealed secret key and its tag. */
const SEALED_BYTES = IV_BYTES + SECRET_KEY_BYTES + TAG_BYTES;

export interface RememberedKey {
  /** The Store ID, as a hex public key. */
  store: string;
  /** The secret key sealed with this device's key, base64. */
  sealed: string;
}

export interface RememberedRead {
  /** This browser lets the admin keep anything at all (not, say, a private window). */
  available: boolean;
  keys: RememberedKey[];
  /** Something was stored but could not be read: it is not offered. */
  damaged: boolean;
  /** A newer admin remembered keys here in a form this one does not know: left untouched. */
  newer?: true;
}

export type UnlockOutcome =
  | { ok: true; secretKey: Uint8Array }
  /**
   * lost: no device key, or the sealed key does not open (site data cleared in part);
   * mismatch: it opens to another key than its Store ID's; unavailable: the browser's
   * storage did not answer this time, so a retry may work.
   */
  | { ok: false; reason: 'lost' | 'mismatch' | 'unavailable' };

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function deviceKeysAvailable(): boolean {
  try {
    return (
      typeof globalThis.indexedDB !== 'undefined' &&
      typeof globalThis.crypto?.subtle !== 'undefined'
    );
  } catch {
    return false;
  }
}

/** Whether a value can be written here: private windows and blocked storage say no. */
export function canRemember(): boolean {
  const store = storage();
  if (store === undefined || !deviceKeysAvailable()) {
    return false;
  }
  try {
    store.setItem(PROBE_KEY, '1');
    store.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesOfBase64(value: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function requestResult<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDeviceDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DEVICE_DB, DEVICE_DB_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
      request.result.createObjectStore(DEVICE_STORE);
    }
  };
  return requestResult(request);
}

function isDeviceKey(value: unknown): value is CryptoKey {
  return (
    value instanceof CryptoKey &&
    value.algorithm.name === 'AES-GCM' &&
    !value.extractable &&
    value.usages.includes('encrypt') &&
    value.usages.includes('decrypt')
  );
}

/**
 * This device's key, made on first use when `create`. Two tabs making one at
 * once keep whichever was stored first: it is added, never put over another.
 */
async function deviceKey(create: boolean): Promise<CryptoKey | undefined> {
  const db = await openDeviceDb();
  try {
    const stored: unknown = await requestResult(
      db.transaction(DEVICE_STORE).objectStore(DEVICE_STORE).get(DEVICE_KEY_ID),
    );
    if (isDeviceKey(stored) || !create) {
      return isDeviceKey(stored) ? stored : undefined;
    }
    const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    // A slot holding something else opens nothing sealed under it: it is cleared for a new key.
    if (stored !== undefined) {
      await requestResult(
        db.transaction(DEVICE_STORE, 'readwrite').objectStore(DEVICE_STORE).delete(DEVICE_KEY_ID),
      );
    }
    const objects = db.transaction(DEVICE_STORE, 'readwrite').objectStore(DEVICE_STORE);
    try {
      await requestResult(objects.add(made, DEVICE_KEY_ID));
      return made;
    } catch {
      const winner: unknown = await requestResult(
        db.transaction(DEVICE_STORE).objectStore(DEVICE_STORE).get(DEVICE_KEY_ID),
      );
      return isDeviceKey(winner) ? winner : undefined;
    }
  } finally {
    db.close();
  }
}

/** The Store ID is bound in as associated data: a sealed key moved to another entry fails. */
function sealParams(iv: Uint8Array, store: string): AesGcmParams {
  return { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(store) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): RememberedKey | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { store, sealed } = value;
  if (typeof store !== 'string' || !HEX_PUBKEY_RE.test(store)) {
    return undefined;
  }
  if (typeof sealed !== 'string' || bytesOfBase64(sealed)?.length !== SEALED_BYTES) {
    return undefined;
  }
  return { store, sealed };
}

interface Inspected extends RememberedRead {
  /** Entries that could not be read: kept until the merchant clears them. */
  leftovers: unknown[];
  /** The whole value could not be read: nothing is written over it until cleared. */
  unreadable: boolean;
}

function inspect(): Inspected {
  const nothing = { keys: [], damaged: false, leftovers: [], unreadable: false };
  const available = canRemember();
  const store = storage();
  let raw: string | null = null;
  try {
    raw = store === undefined ? null : store.getItem(STORAGE_KEY);
  } catch {
    return { ...nothing, available: false };
  }
  if (raw === null) {
    return { ...nothing, available };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...nothing, available, damaged: true, unreadable: true };
  }
  // Keys locked with a password by an earlier build, never released: written over, not offered.
  if (isRecord(parsed) && parsed.version === PASSWORD_FORMAT_VERSION) {
    return { ...nothing, available };
  }
  if (isRecord(parsed) && typeof parsed.version === 'number' && parsed.version > FORMAT_VERSION) {
    return { ...nothing, available, newer: true };
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.keys)) {
    return { ...nothing, available, damaged: true, unreadable: true };
  }
  const keys: RememberedKey[] = [];
  const leftovers: unknown[] = [];
  for (const entry of parsed.keys) {
    const key = parseEntry(entry);
    if (key === undefined || keys.some((known) => known.store === key.store)) {
      leftovers.push(entry);
    } else {
      keys.push(key);
    }
  }
  return { available, keys, damaged: leftovers.length > 0, leftovers, unreadable: false };
}

/** What is remembered here, newest first; anything unreadable is left out and flagged. */
export function readRemembered(): RememberedRead {
  const { available, keys, damaged, newer } = inspect();
  return newer === true ? { available, keys, damaged, newer } : { available, keys, damaged };
}

/** An unreadable entry naming this Store ID (hex): forgetting or replacing the store drops it. */
function namesStore(entry: unknown, store: string): boolean {
  return isRecord(entry) && entry.store === store;
}

function writeKeys(keys: readonly RememberedKey[], leftovers: readonly unknown[]): boolean {
  const store = storage();
  if (store === undefined) {
    return false;
  }
  try {
    if (keys.length === 0 && leftovers.length === 0) {
      store.removeItem(STORAGE_KEY);
    } else {
      store.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: FORMAT_VERSION, keys: [...keys, ...leftovers] }),
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remember `secretKey` on this device, sealed with its device key, in place of
 * any for its store. Refused over a newer admin's value or a wholly unreadable
 * one, which only the merchant clears.
 */
export async function rememberKey(secretKey: Uint8Array): Promise<boolean> {
  const before = inspect();
  if (before.unreadable || before.newer === true) {
    return false;
  }
  const store = getPublicKey(secretKey);
  let sealed: string;
  try {
    const key = await deviceKey(true);
    if (key === undefined) {
      return false;
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(sealParams(iv, store), key, secretKey),
    );
    const joined = new Uint8Array(SEALED_BYTES);
    joined.set(iv);
    joined.set(cipher, IV_BYTES);
    sealed = base64OfBytes(joined);
  } catch {
    return false;
  }
  // Read again: another tab may have written while the key was sealed.
  const read = inspect();
  if (read.newer === true || read.unreadable) {
    return false;
  }
  return writeKeys(
    [{ store, sealed }, ...read.keys.filter((known) => known.store !== store)],
    read.leftovers.filter((entry) => !namesStore(entry, store)),
  );
}

/**
 * Forget the key remembered for this Store ID (hex), and unreadable entries
 * naming it. True when nothing of it is left that could be unlocked.
 */
export function forgetKey(store: string): boolean {
  const read = inspect();
  if (read.newer === true) {
    return false;
  }
  const leftovers = read.leftovers.filter((entry) => !namesStore(entry, store));
  if (!read.keys.some((key) => key.store === store) && leftovers.length === read.leftovers.length) {
    return true;
  }
  return writeKeys(
    read.keys.filter((key) => key.store !== store),
    leftovers,
  );
}

/** Drop whatever could not be read (the merchant confirmed), keeping the keys that can. */
export function forgetDamaged(): boolean {
  const read = inspect();
  if (read.newer === true) {
    return false;
  }
  return writeKeys(read.keys, []);
}

export function isRemembered(store: string): boolean {
  return readRemembered().keys.some((key) => key.store === store);
}

/**
 * The secret key behind `key`, or why not. A device key that is gone (site
 * data cleared in part) and a damaged value both fail; nothing of the failure
 * is passed on.
 */
export async function unlockKey(key: RememberedKey): Promise<UnlockOutcome> {
  const joined = bytesOfBase64(key.sealed);
  if (joined === undefined || joined.length !== SEALED_BYTES) {
    return { ok: false, reason: 'lost' };
  }
  let device: CryptoKey | undefined;
  try {
    device = await deviceKey(false);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (device === undefined) {
    return { ok: false, reason: 'lost' };
  }
  let secretKey: Uint8Array;
  try {
    secretKey = new Uint8Array(
      await crypto.subtle.decrypt(
        sealParams(joined.slice(0, IV_BYTES), key.store),
        device,
        joined.slice(IV_BYTES),
      ),
    );
  } catch {
    return { ok: false, reason: 'lost' };
  }
  if (secretKey.length !== SECRET_KEY_BYTES || publicKeyOf(secretKey) !== key.store) {
    secretKey.fill(0);
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, secretKey };
}

/** Said under a ticked remember box on the sign-in and key replacement screens. */
export const REMEMBER_NOTE =
  'Kept encrypted in this browser and never sent anywhere. Anyone who can use this browser can sign in as your store, so clear this on a shared computer.';
