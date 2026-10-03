import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
/**
 * The store's keys at rest. `keys.json` holds the store key and the owner key,
 * each either 64-hex or sealed with a passphrase (`secret-box`), and the two
 * public keys in the clear, so a command that only needs them never asks for
 * the passphrase. Nothing here writes the file on load: only `init` and
 * `encrypt-keys` write it.
 */
import { nsecEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';
import { decryptSecret, encryptSecret, isEncrypted } from './secret-box';

/** The passphrase, in the clear. */
export const PASSPHRASE_ENV = 'ELISYM_MERCHANT_PASSPHRASE';

/** A file holding the passphrase: a Docker or systemd secret. */
export const PASSPHRASE_FILE_ENV = 'ELISYM_MERCHANT_PASSPHRASE_FILE';

/** What a command missing the passphrase says: the file first, as the runbooks use it. */
export const PASSPHRASE_HINT = `set ${PASSPHRASE_FILE_ENV} (or ${PASSPHRASE_ENV})`;

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

export type KeyName = 'store' | 'owner';

/** `keys.json` as written: the secrets and, from 0.5.0, their public keys. */
export interface KeysFile {
  store: string;
  owner: string;
  storePubkey?: string;
  ownerPubkey?: string;
}

/** `keys.json` as read: the public keys always, the secrets as stored. */
export interface LoadedKeys {
  storePubkey: string;
  ownerPubkey: string;
  /** Each secret as stored: 64-hex, or `encrypted:v1:`. */
  sealed: Record<KeyName, string>;
}

/**
 * The passphrase from the environment: `ELISYM_MERCHANT_PASSPHRASE`, or the
 * file `ELISYM_MERCHANT_PASSPHRASE_FILE` names (one trailing newline dropped,
 * so the same passphrase gives the same key either way). An empty variable
 * counts as unset; an empty file is an error, since a file that was named but
 * holds nothing (an `openssl` that failed after `>` created it) must never
 * quietly give plain keys. Both set is an error rather than a rule of which wins.
 */
export function readPassphrase(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const direct = env[PASSPHRASE_ENV];
  const file = env[PASSPHRASE_FILE_ENV];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = file !== undefined && file !== '';
  if (hasDirect && hasFile) {
    throw new Error(`set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV}, not both`);
  }
  if (hasFile) {
    const fromFile = readFile(file).replace(/\r?\n$/, '');
    if (fromFile === '') {
      throw new Error(`the passphrase file ${file} is empty`);
    }
    return fromFile;
  }
  return hasDirect ? direct : undefined;
}

/** The shape of `keys.json`; what each value holds is checked below. */
const KEYS_FILE_SCHEMA = z.object({
  store: z.string(),
  owner: z.string(),
  storePubkey: z.string().optional(),
  ownerPubkey: z.string().optional(),
});

/** One key's public key: the stored one when sealed, else derived and checked against it. */
function publicKeyOf(name: KeyName, secret: string, stored: string | undefined): string {
  if (!HEX_KEY_RE.test(secret) && !isEncrypted(secret)) {
    throw new Error(`keys.json holds no usable ${name} key`);
  }
  if (stored !== undefined && !HEX_KEY_RE.test(stored)) {
    throw new Error(`keys.json holds a malformed ${name} public key`);
  }
  if (isEncrypted(secret)) {
    if (stored === undefined) {
      throw new Error(`keys.json holds an encrypted ${name} key without its public key`);
    }
    return stored;
  }
  const derived = getPublicKey(hexToBytes(secret));
  if (stored !== undefined && stored !== derived) {
    throw new Error(`keys.json: the ${name} key does not match its public key`);
  }
  return derived;
}

/**
 * Read `keys.json`. A plaintext secret must match its stored public key; a
 * file from before 0.5.0 has none, and they are derived here, in memory only.
 */
export function parseKeysFile(text: string): LoadedKeys {
  const parsed = KEYS_FILE_SCHEMA.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error('keys.json holds no usable keys');
  }
  const file = parsed.data;
  return {
    storePubkey: publicKeyOf('store', file.store, file.storePubkey),
    ownerPubkey: publicKeyOf('owner', file.owner, file.ownerPubkey),
    sealed: { store: file.store, owner: file.owner },
  };
}

export function isSealed(keys: LoadedKeys, name: KeyName): boolean {
  return isEncrypted(keys.sealed[name]);
}

/**
 * The one way a secret key is read: decrypted when sealed, and always checked
 * against its stored public key, so swapped or stitched ciphertexts are refused
 * rather than used (a `store-key` that printed the owner key, say).
 */
export function openSecret(
  keys: LoadedKeys,
  name: KeyName,
  passphrase: string | undefined,
): Uint8Array {
  const sealed = keys.sealed[name];
  let hex = sealed;
  if (isEncrypted(sealed)) {
    if (passphrase === undefined) {
      throw new Error(`keys.json holds an encrypted ${name} key: ${PASSPHRASE_HINT}`);
    }
    hex = decryptSecret(sealed, passphrase);
  }
  if (!HEX_KEY_RE.test(hex)) {
    throw new Error(`keys.json: the ${name} key is not a key`);
  }
  const secret = hexToBytes(hex);
  const expected = name === 'store' ? keys.storePubkey : keys.ownerPubkey;
  if (getPublicKey(secret) !== expected) {
    throw new Error(`keys.json: the ${name} key does not match its public key`);
  }
  return secret;
}

/**
 * Seal `names` of the keys with `passphrase`, each round-tripped before it is
 * kept: a ciphertext that does not open with this passphrase is never written.
 * A key already sealed must open with it (one passphrase for the whole file).
 */
export function sealKeys(
  keys: LoadedKeys,
  names: readonly KeyName[],
  passphrase: string,
  /** Replaceable in tests, to prove a value that does not read back is never kept. */
  encrypt: (plaintext: string, passphrase: string) => string = encryptSecret,
): KeysFile {
  const sealed = { ...keys.sealed };
  for (const name of ['store', 'owner'] as const) {
    const secret = openSecret(keys, name, passphrase);
    if (isEncrypted(sealed[name]) || !names.includes(name)) {
      continue;
    }
    const encrypted = encrypt(bytesToHex(secret), passphrase);
    // Read back before it is kept: it must open with this passphrase to the same
    // key (openSecret checks it against the stored public key), or nothing is written.
    openSecret({ ...keys, sealed: { ...sealed, [name]: encrypted } }, name, passphrase);
    sealed[name] = encrypted;
  }
  return {
    store: sealed.store,
    owner: sealed.owner,
    storePubkey: keys.storePubkey,
    ownerPubkey: keys.ownerPubkey,
  };
}

/** Plain keys as a file: `init` without a passphrase. */
export function plainKeysFile(storeSecretKey: Uint8Array, ownerSecretKey: Uint8Array): KeysFile {
  return {
    store: bytesToHex(storeSecretKey),
    owner: bytesToHex(ownerSecretKey),
    storePubkey: getPublicKey(storeSecretKey),
    ownerPubkey: getPublicKey(ownerSecretKey),
  };
}

export function keysFileText(file: KeysFile): string {
  return `${JSON.stringify(file)}\n`;
}

/**
 * Replace `keys.json` atomically: a temporary file next to it (same directory,
 * so the rename stays on one file system), `0600`, flushed, then renamed over.
 * A crash leaves the old file or the new one, never half of either.
 */
export function replaceKeysFile(path: string, file: KeysFile): void {
  const temporary = join(dirname(path), `.keys.json.${process.pid}.tmp`);
  // A temporary file left by a failed write may hold a plain key: it never
  // survives, whether this write fails (removed below) or an earlier one did.
  rmSync(temporary, { force: true });
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, keysFileText(file));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // The rename itself is flushed too: after a crash, the old plain file must not
  // come back. A platform that cannot sync a directory (Windows) skips it: the
  // file is already replaced, and failing now would say otherwise.
  if (process.platform === 'win32') {
    return;
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** What an operator is told whenever keys are encrypted. */
export function encryptionNotes(ownerOnly: boolean): string[] {
  const notes = [
    ownerOnly
      ? 'back up the passphrase: without it the owner key is lost'
      : 'back up the passphrase: without it both keys are lost',
    'the passphrase protects a copy of this home (a backup, a snapshot, a copied volume), not a host that also holds the passphrase: keep its source out of the volume and its backups',
  ];
  if (ownerOnly) {
    notes.push(
      'the store key stays plain: whoever copies this home can still publish a store profile naming another owner and redirect new buyers. Encrypt both keys unless the node must run without the passphrase',
    );
  }
  return notes;
}

/** Said with the store key, every time it is printed. */
export const STORE_KEY_WARNING =
  'warning: whoever holds this key can redirect payments from new buyers; paste it only into the admin on this machine';

/**
 * `store-key`: the store's secret key (nsec), to paste into the admin page on
 * this machine. Only to a terminal, or with `--yes`: it must not land in a log
 * unasked. Checked before anything is decrypted. Never the owner key.
 */
export function storeKeyForAdmin(
  keys: LoadedKeys,
  passphrase: string | undefined,
  toTerminal: boolean,
  yes: boolean,
): string {
  if (!yes && !toTerminal) {
    throw new Error('not printing a secret key off a terminal: pass --yes to print it anyway');
  }
  return nsecEncode(openSecret(keys, 'store', passphrase));
}

/**
 * Whether the owner key opens here (plain, or sealed and opened with the
 * passphrase given), checked against its public key. `check` writes the
 * nostr.json naming the owner only then, never from the plaintext public key
 * alone, which a copy of the home could have changed.
 */
export function ownerOpensHere(keys: LoadedKeys, passphrase: string | undefined): boolean {
  if (isSealed(keys, 'owner') && passphrase === undefined) {
    return false;
  }
  openSecret(keys, 'owner', passphrase);
  return true;
}

/**
 * What `check` reads: the store key (relay probes), and whether the nostr.json
 * naming the owner may be written (only for an owner key that opens here).
 */
export function openCheckKeys(
  keys: LoadedKeys,
  passphrase: string | undefined,
): { storeSecretKey: Uint8Array; writeNostrJson: boolean } {
  return {
    storeSecretKey: openSecret(keys, 'store', passphrase),
    writeNostrJson: ownerOpensHere(keys, passphrase),
  };
}

/**
 * Both secrets `setup` signs with, the owner's first. `setup` calls this before
 * anything is checked, signed or published: a missing or wrong passphrase must
 * never leave a half-published store.
 */
export function openSetupKeys(
  keys: LoadedKeys,
  passphrase: string | undefined,
): { ownerSecretKey: Uint8Array; storeSecretKey: Uint8Array } {
  const ownerSecretKey = openSecret(keys, 'owner', passphrase);
  const storeSecretKey = openSecret(keys, 'store', passphrase);
  return { ownerSecretKey, storeSecretKey };
}
