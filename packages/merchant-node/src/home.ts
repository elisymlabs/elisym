import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSecretKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import type { StoreKeys } from './store-events';

/**
 * Where a merchant keeps its state: `config.json` (the operator's), `keys.json`
 * (the store and owner secret keys), `ledger.json`, `run.lock` and the
 * `nostr.json` a level A domain serves.
 */
export interface MerchantHome {
  dir: string;
  config: string;
  keys: string;
  ledger: string;
  lock: string;
  nostrJson: string;
}

export const HOME_ENV = 'ELISYM_MERCHANT_HOME';
const DEFAULT_HOME_NAME = '.elisym-merchant';

/** `--home <dir>`, else `$ELISYM_MERCHANT_HOME`, else `~/.elisym-merchant`. */
export function merchantHome(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MerchantHome {
  const chosen = flag ?? env[HOME_ENV];
  const dir = resolve(
    chosen === undefined || chosen === '' ? join(homedir(), DEFAULT_HOME_NAME) : chosen,
  );
  return {
    dir,
    config: join(dir, 'config.json'),
    keys: join(dir, 'keys.json'),
    ledger: join(dir, 'ledger.json'),
    lock: join(dir, 'run.lock'),
    nostrJson: join(dir, 'nostr.json'),
  };
}

/** Create the home, readable by its owner only (it holds secret keys). */
export function ensureHome(home: MerchantHome): void {
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  try {
    // One that already existed (a Docker volume, say) is narrowed too.
    chmodSync(home.dir, 0o700);
  } catch {
    // Not ours to change: the files in it are still written 0600.
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The store's keys. Only a missing file mints new ones (and only with
 * `create`): an unreadable one must never replace the store's identity.
 */
export function loadOrCreateKeys(home: MerchantHome, create: boolean): StoreKeys {
  let text: string | undefined;
  try {
    text = readFileSync(home.keys, 'utf8');
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  if (text !== undefined) {
    const stored = JSON.parse(text) as { store: string; owner: string };
    return { storeSecretKey: hexToBytes(stored.store), ownerSecretKey: hexToBytes(stored.owner) };
  }
  if (!create) {
    throw new Error(`no store keys in ${home.dir}: run init first`);
  }
  const keys = { storeSecretKey: generateSecretKey(), ownerSecretKey: generateSecretKey() };
  ensureHome(home);
  writeFileSync(
    home.keys,
    `${JSON.stringify({ store: bytesToHex(keys.storeSecretKey), owner: bytesToHex(keys.ownerSecretKey) })}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return keys;
}

/** A lock nobody refreshed for this long was left by a process that is gone. */
export const LOCK_STALE_MS = 90_000;

/** How often the holder refreshes its lock. */
const LOCK_HEARTBEAT_MS = 20_000;

/**
 * Whether a running merchant holds the home: its lock was refreshed lately.
 * Freshness, not a PID: a PID says nothing across containers or hosts sharing
 * a mounted home (and in a container the node always has the same one).
 */
export function heldByRunningMerchant(home: MerchantHome, now: number = Date.now()): boolean {
  try {
    return now - statSync(home.lock).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function createLock(home: MerchantHome, token: string): boolean {
  try {
    writeFileSync(home.lock, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function heldError(home: MerchantHome): Error {
  return new Error(
    `another merchant holds ${home.lock}; a node that stopped without releasing it frees it ${LOCK_STALE_MS / 1000} s after its last refresh`,
  );
}

/**
 * Take the home for this process: refreshed while it runs, released on exit.
 * A stale lock is moved aside under a name of this process's own first, so of
 * two processes breaking it at once only one goes on; one that turns out fresh
 * (taken meanwhile) is put back.
 */
export function takeLock(
  home: MerchantHome,
  options: {
    /**
     * Called when the lock turned out not to be this process's any more (it was
     * stopped past `LOCK_STALE_MS` and another took the home): by default it
     * exits, since its ledger in memory would overwrite the other's.
     */
    onLost?: () => void;
    /** When the existing lock is judged; tests move it. */
    judgedAt?: number;
  } = {},
): () => void {
  ensureHome(home);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  if (!createLock(home, token)) {
    if (heldByRunningMerchant(home, options.judgedAt)) {
      throw heldError(home);
    }
    const aside = `${home.lock}.${token}`;
    try {
      renameSync(home.lock, aside);
    } catch {
      throw heldError(home);
    }
    if (Date.now() - statSync(aside).mtimeMs < LOCK_STALE_MS) {
      try {
        linkSync(aside, home.lock);
      } catch {
        // Someone holds the name again: that lock stands.
      }
      rmSync(aside, { force: true });
      throw heldError(home);
    }
    rmSync(aside, { force: true });
    if (!createLock(home, token)) {
      throw heldError(home);
    }
  }
  const ours = () => {
    try {
      return readFileSync(home.lock, 'utf8') === token;
    } catch {
      return false;
    }
  };
  const onLost =
    options.onLost ??
    (() => {
      console.error(`error: ${home.lock} was taken by another process; stopping`);
      process.exit(1);
    });
  const heartbeat = setInterval(() => {
    try {
      if (!ours()) {
        clearInterval(heartbeat);
        onLost();
        return;
      }
      const now = new Date();
      utimesSync(home.lock, now, now);
    } catch {
      // Gone between the read and the touch: the next beat finds it lost.
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  const release = () => {
    clearInterval(heartbeat);
    process.removeListener('exit', release);
    if (ours()) {
      rmSync(home.lock, { force: true });
    }
  };
  process.once('exit', release);
  return release;
}
