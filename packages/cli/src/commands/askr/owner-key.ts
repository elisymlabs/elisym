/**
 * The store owner key O of one profile (4): `~/.elisym/.askr/<profile>.json`,
 * a 0700 directory and a 0600 file, outside agent-store discovery (it skips
 * dot entries). Created with no-overwrite semantics, so two first runs at once
 * end with one key. The secret never leaves this module in an error.
 */
import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { DEFAULT_PROFILE, PROFILE_RE } from './constants';
import { AskrExit, EXIT } from './errors';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const KEY_FILE_VERSION = 1;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;
/** A reader that finds a file half written (the `wx` fallback) retries this long. */
const PARTIAL_READ_RETRY_MS = 2_000;
const PARTIAL_READ_STEP_MS = 100;

export interface OwnerKey {
  secretKey: Uint8Array;
  /** O, hex. */
  owner: string;
  /** O as an npub: the Store ID. */
  storeId: string;
  path: string;
}

/** The file operations creation needs; tests replace `link` to take the fallback. */
export interface KeyFileOps {
  link: (existingPath: string, newPath: string) => Promise<void>;
}

const DEFAULT_OPS: KeyFileOps = { link };

export function profileOf(value: string | undefined): string {
  const profile = value ?? DEFAULT_PROFILE;
  if (!PROFILE_RE.test(profile)) {
    throw new AskrExit(EXIT.BAD_INPUT, 'bad_flag', {
      hint: '--profile takes 1 to 32 lowercase letters, digits or hyphens',
    });
  }
  return profile;
}

export function keyDirOf(home: string): string {
  return join(home, '.elisym', '.askr');
}

export function keyFileOf(home: string, profile: string): string {
  return join(keyDirOf(home), `${profile}.json`);
}

function ownerKeyOf(secretKey: Uint8Array, path: string): OwnerKey {
  const owner = getPublicKey(secretKey);
  return { secretKey, owner, storeId: nip19.npubEncode(owner), path };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function unreadable(path: string): AskrExit {
  return new AskrExit(EXIT.KEY, 'key_file_unreadable', {
    hint: 'the owner key file of this profile cannot be read; restore it from your backup or sign in to the admin',
    fields: { ownerKeyFile: path },
  });
}

/** Text as an editor may save it: a leading byte order mark dropped. */
function withoutBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function parseKeyFile(text: string, path: string): OwnerKey {
  const parsed: unknown = JSON.parse(withoutBom(text));
  if (typeof parsed !== 'object' || parsed === null || !('secretKey' in parsed)) {
    throw unreadable(path);
  }
  const secretHex = parsed.secretKey;
  if (typeof secretHex !== 'string' || !HEX_KEY_RE.test(secretHex)) {
    throw unreadable(path);
  }
  return ownerKeyOf(hexToBytes(secretHex), path);
}

/** The profile's key, or undefined when it has none yet. */
export async function readOwnerKey(home: string, profile: string): Promise<OwnerKey | undefined> {
  const path = keyFileOf(home, profile);
  const started = Date.now();
  for (;;) {
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw unreadable(path);
    }
    try {
      return parseKeyFile(text, path);
    } catch (error) {
      if (error instanceof AskrExit) {
        throw error;
      }
      // A JSON parse error: another run may be writing the file through the fallback.
      if (Date.now() - started >= PARTIAL_READ_RETRY_MS) {
        throw unreadable(path);
      }
      await sleep(PARTIAL_READ_STEP_MS);
    }
  }
}

async function ensureKeyDir(home: string): Promise<void> {
  const dir = keyDirOf(home);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // Only this directory, never ~/.elisym: an existing one with a looser mode is tightened.
  const current = await stat(dir);
  if ((current.mode & 0o777) !== DIR_MODE) {
    await chmod(dir, DIR_MODE);
  }
}

function keyFileText(secretKey: Uint8Array, now: number): string {
  const owner = getPublicKey(secretKey);
  return `${JSON.stringify(
    {
      version: KEY_FILE_VERSION,
      storeId: nip19.npubEncode(owner),
      owner,
      secretKey: bytesToHex(secretKey),
      createdAt: now,
    },
    null,
    2,
  )}\n`;
}

async function writeExclusive(path: string, text: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', FILE_MODE);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(text, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Save `secretKey` as the profile's key unless the profile has one already,
 * and return the key the file holds: another run's, when it won the race.
 */
export async function saveOwnerKey(
  home: string,
  profile: string,
  secretKey: Uint8Array,
  now: number,
  ops: KeyFileOps = DEFAULT_OPS,
): Promise<OwnerKey> {
  await ensureKeyDir(home);
  const path = keyFileOf(home, profile);
  const text = keyFileText(secretKey, now);
  const temp = `${path}.tmp.${randomBytes(8).toString('hex')}`;
  await writeFile(temp, text, { encoding: 'utf-8', mode: FILE_MODE, flag: 'wx' });
  let linked = false;
  try {
    await ops.link(temp, path);
    linked = true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EPERM' || code === 'ENOTSUP') {
      // A file system without hard links.
      linked = await writeExclusive(path, text);
    } else if (code !== 'EEXIST') {
      throw unreadable(path);
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  if (linked) {
    return ownerKeyOf(secretKey, path);
  }
  const existing = await readOwnerKey(home, profile);
  if (existing === undefined) {
    throw unreadable(path);
  }
  return existing;
}

/** A new owner key for the profile, or the one another run saved first. */
export function createOwnerKey(home: string, profile: string, now: number): Promise<OwnerKey> {
  return saveOwnerKey(home, profile, generateSecretKey(), now);
}

const NSEC_RE = /nsec1[02-9ac-hj-np-z]{58}/g;
const NPUB_RE = /npub1[02-9ac-hj-np-z]{58}/g;
const HEX_TOKEN_RE = /\b[0-9a-fA-F]{64}\b/g;
/** A key file is a few hundred bytes; anything far larger is not one. */
const MAX_IMPORT_BYTES = 64 * 1024;

function importRefused(hint: string): AskrExit {
  return new AskrExit(EXIT.KEY, 'key_file_unreadable', { hint: `--owner-key-file: ${hint}` });
}

/** A secret key that has a public key (not zero, below the curve order). */
function validKey(secretKey: Uint8Array): Uint8Array {
  try {
    getPublicKey(secretKey);
    return secretKey;
  } catch {
    throw importRefused('the key in the file is not a valid secret key');
  }
}

function jsonObjectOf(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ...parsed }
    : undefined;
}

/**
 * A JSON key file (this CLI's own `~/.elisym/.askr/<profile>.json`): its
 * `secretKey` only, never another field, checked against the `owner` and
 * `storeId` it names. One without a `secretKey` is refused: its keys are public.
 */
function keyOfJson(parsed: Record<string, unknown>): Uint8Array {
  const secretHex = parsed.secretKey;
  if (typeof secretHex !== 'string' || !HEX_KEY_RE.test(secretHex.toLowerCase())) {
    throw importRefused('a JSON key file needs a secretKey of 64 hex characters');
  }
  const secretKey = validKey(hexToBytes(secretHex.toLowerCase()));
  const owner = getPublicKey(secretKey);
  if (parsed.owner !== undefined && parsed.owner !== owner) {
    throw importRefused('its secretKey does not match its owner');
  }
  if (parsed.storeId !== undefined && parsed.storeId !== nip19.npubEncode(owner)) {
    throw importRefused('its secretKey does not match its storeId');
  }
  return secretKey;
}

function decodedNsec(nsec: string): Uint8Array {
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type === 'nsec') {
      return decoded.data;
    }
  } catch {
    // Reported below without the file's content.
  }
  throw importRefused('the nsec1... key in the file is not valid');
}

/**
 * A text key file (the admin's `Secret key: nsec1...` file, or a bare nsec or
 * hex key): exactly one secret key, written once or as both nsec and hex, and
 * every Store ID (npub) it names must be that key's.
 */
function keyOfText(text: string): Uint8Array {
  const candidates = new Map<string, Uint8Array>();
  for (const nsec of text.match(NSEC_RE) ?? []) {
    const secretKey = decodedNsec(nsec);
    candidates.set(bytesToHex(secretKey), secretKey);
  }
  for (const hex of text.match(HEX_TOKEN_RE) ?? []) {
    const secretKey = hexToBytes(hex.toLowerCase());
    candidates.set(bytesToHex(secretKey), secretKey);
  }
  // A key's own public key written beside it (`Public key: <hex>`) is not a second key.
  const publicKeys = new Set(
    [...candidates.values()].flatMap((secretKey) => {
      try {
        return [getPublicKey(secretKey)];
      } catch {
        return [];
      }
    }),
  );
  if (candidates.size > 1) {
    for (const hex of publicKeys) {
      candidates.delete(hex);
    }
  }
  if (candidates.size > 1) {
    throw importRefused('the file holds more than one key: give a file with only the secret key');
  }
  const [secretKey] = candidates.values();
  if (secretKey === undefined) {
    throw importRefused('no nsec1... or 64-character hex secret key found in the file');
  }
  const storeId = nip19.npubEncode(getPublicKey(validKey(secretKey)));
  if ((text.match(NPUB_RE) ?? []).some((npub) => npub !== storeId)) {
    throw importRefused('the Store ID in the file is not the one of its secret key');
  }
  return secretKey;
}

/**
 * The secret key in a file: this CLI's own JSON key file, a file the admin
 * saved, or a bare nsec or 64-hex key. Anything ambiguous is refused rather
 * than guessed from.
 */
export async function readImportedKey(path: string): Promise<Uint8Array> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMPORT_BYTES) {
      throw new Error('not a key file');
    }
    text = withoutBom(await readFile(path, 'utf-8'));
  } catch {
    throw importRefused('the file cannot be read, or is not a key file');
  }
  const parsed = jsonObjectOf(text);
  return parsed === undefined ? keyOfText(text) : keyOfJson(parsed);
}

/** Whether two secret keys are the same key. */
export function sameKey(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}
