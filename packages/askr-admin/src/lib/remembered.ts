// cspell:words ncryptsec
import { decrypt, encrypt } from 'nostr-tools/nip49';
import { getPublicKey } from 'nostr-tools/pure';
import { publicKeyOf } from './signer';

/**
 * Secret keys remembered on this device, each locked with a password the
 * merchant chose (NIP-49: scrypt, then XChaCha20-Poly1305). Only the locked
 * form is ever written; the plain key never touches storage.
 *
 * One remembered key per Store ID, newest first: a merchant with several
 * stores picks one on the sign-in page, and remembering a key again for the
 * same Store ID replaces it.
 *
 * This is the only module that touches browser storage.
 */

/**
 * scrypt cost: N = 2^16, 64 MiB, the value NIP-49 suggests. Measured with
 * nostr-tools' scrypt (pure JS, the same code the browser runs): about 125 ms
 * to lock or unlock on a laptop (2^15: 60 ms, 2^17: 255 ms), so a phone stays
 * near a second while each password guess stays costly.
 */
export const REMEMBER_LOG_N = 16;
/**
 * The costs read back: up to 2^18 (256 MiB), so a later release may raise
 * the cost without old keys turning unreadable, and a damaged value never
 * asks for a run the browser cannot afford.
 */
const MAX_READ_LOG_N = 18;

/** Kept low on purpose: the merchant chooses; the key file and the secret key itself stay the way back. */
export const MIN_PASSWORD_LENGTH = 6;

const STORAGE_KEY = 'askr-admin.remembered-keys';
const PROBE_KEY = 'askr-admin.probe';
const FORMAT_VERSION = 1;

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;
const NCRYPTSEC_PREFIX = 'ncryptsec';
// cspell:disable-next-line
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CHECKSUM_WORDS = 6;
/** version, log_n, salt (16), nonce (24), key security byte, ciphertext (32) and tag (16). */
const NCRYPTSEC_BYTES = 1 + 1 + 16 + 24 + 1 + 48;
const NCRYPTSEC_VERSION = 2;
const SECRET_KEY_BYTES = 32;

export interface RememberedKey {
  /** The Store ID, as a hex public key. */
  store: string;
  /** The secret key locked with the merchant's password. */
  locked: string;
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
  | { ok: false; reason: 'password' | 'mismatch' };

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Whether a value can be written here: private windows and blocked storage say no. */
export function canRemember(): boolean {
  const store = storage();
  if (store === undefined) {
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

function bech32Checksum(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    BECH32_GENERATORS.forEach((generator, index) => {
      if (((top >>> index) & 1) === 1) {
        checksum ^= generator;
      }
    });
  }
  return checksum;
}

/** The bytes of a well-formed bech32 string with this prefix, or undefined. */
function bech32Bytes(value: string, prefix: string): Uint8Array | undefined {
  if (!value.startsWith(`${prefix}1`)) {
    return undefined;
  }
  const words: number[] = [];
  for (const character of value.slice(prefix.length + 1)) {
    const word = BECH32_CHARSET.indexOf(character);
    if (word === -1) {
      return undefined;
    }
    words.push(word);
  }
  if (words.length <= BECH32_CHECKSUM_WORDS) {
    return undefined;
  }
  const prefixCodes = [...prefix].map((character) => character.charCodeAt(0));
  const expanded = [
    ...prefixCodes.map((code) => code >>> 5),
    0,
    ...prefixCodes.map((code) => code & 31),
  ];
  if (bech32Checksum([...expanded, ...words]) !== 1) {
    return undefined;
  }
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const word of words.slice(0, -BECH32_CHECKSUM_WORDS)) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || (accumulator & ((1 << bits) - 1)) !== 0) {
    return undefined;
  }
  return Uint8Array.from(bytes);
}

/**
 * A locked key exactly as this module writes it: the cost is checked before
 * any unlock, so a damaged value can never ask for a huge scrypt run.
 */
function wellFormedLocked(value: string): boolean {
  const bytes = bech32Bytes(value, NCRYPTSEC_PREFIX);
  if (bytes === undefined || bytes.length !== NCRYPTSEC_BYTES) {
    return false;
  }
  const logN = bytes[1] ?? 0;
  return bytes[0] === NCRYPTSEC_VERSION && logN >= REMEMBER_LOG_N && logN <= MAX_READ_LOG_N;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): RememberedKey | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { store, locked } = value;
  if (typeof store !== 'string' || !HEX_PUBKEY_RE.test(store)) {
    return undefined;
  }
  if (typeof locked !== 'string' || !wellFormedLocked(locked)) {
    return undefined;
  }
  return { store, locked };
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

/** Why this password cannot lock a key, or undefined when it can. */
export function passwordProblem(password: string, repeated: string): string | undefined {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== repeated) {
    return 'The two passwords are not the same.';
  }
  return undefined;
}

/**
 * Remember `secretKey` on this device, locked with `password`, in place of any
 * for its store. Refused over a newer admin's value or a wholly unreadable one,
 * which only the merchant clears.
 */
export function rememberKey(secretKey: Uint8Array, password: string): boolean {
  const read = inspect();
  if (read.newer === true || read.unreadable) {
    return false;
  }
  const store = getPublicKey(secretKey);
  const locked = encrypt(secretKey, password, REMEMBER_LOG_N);
  return writeKeys(
    [{ store, locked }, ...read.keys.filter((key) => key.store !== store)],
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
 * The secret key behind `key`, or why not. A wrong password and a damaged
 * value both fail the authentication tag; nothing of the failure is passed on.
 */
export function unlockKey(key: RememberedKey, password: string): UnlockOutcome {
  let secretKey: Uint8Array;
  try {
    secretKey = decrypt(key.locked, password);
  } catch {
    return { ok: false, reason: 'password' };
  }
  if (secretKey.length !== SECRET_KEY_BYTES || publicKeyOf(secretKey) !== key.store) {
    secretKey.fill(0);
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, secretKey };
}

/** Let a slow step (scrypt) start after React painted its busy label. */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
