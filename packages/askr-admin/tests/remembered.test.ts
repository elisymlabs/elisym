import { nip19 } from 'nostr-tools';
import { encrypt } from 'nostr-tools/nip49';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyFileName, keyFileText, saveTextFile } from '../src/lib/key-file';
import {
  MIN_PASSWORD_LENGTH,
  REMEMBER_LOG_N,
  canRemember,
  forgetDamaged,
  forgetKey,
  isRemembered,
  passwordProblem,
  readRemembered,
  rememberKey,
  unlockKey,
} from '../src/lib/remembered';
import { type MemoryStorage, blockStorage, installStorage, plainForms } from './stored';

const PASSWORD = 'correct horse battery';
const STORAGE_KEY = 'askr-admin.remembered-keys';

let storage: MemoryStorage;
beforeEach(() => {
  storage = installStorage();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function writeRaw(value: unknown) {
  storage.setItem(STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('remembering a key on this device', () => {
  it('writes only the password-locked key, with the chosen cost, and unlocks it with the password', () => {
    const secretKey = generateSecretKey();
    expect(rememberKey(secretKey, PASSWORD)).toBe(true);
    const stored = storage.everything();
    const written = storage.writes.join('\n');
    expect(stored).toContain('ncryptsec1');
    for (const secret of [...plainForms(secretKey), PASSWORD]) {
      expect(stored).not.toContain(secret);
      expect(written).not.toContain(secret);
    }
    const read = readRemembered();
    expect(read).toMatchObject({ available: true, damaged: false });
    expect(read.keys).toHaveLength(1);
    const [key] = read.keys;
    if (key === undefined) {
      throw new Error('nothing remembered');
    }
    expect(key.store).toBe(getPublicKey(secretKey));
    expect(key.locked.startsWith('ncryptsec1')).toBe(true);
    expect(REMEMBER_LOG_N).toBe(16);
    const unlocked = unlockKey(key, PASSWORD);
    expect(unlocked.ok && bytesToHex(unlocked.secretKey)).toBe(bytesToHex(secretKey));
    expect(isRemembered(getPublicKey(secretKey))).toBe(true);
  });

  it('says a wrong password plainly and passes nothing of the failure on', () => {
    const secretKey = generateSecretKey();
    rememberKey(secretKey, PASSWORD);
    const [key] = readRemembered().keys;
    if (key === undefined) {
      throw new Error('nothing remembered');
    }
    expect(unlockKey(key, 'correct horse batterY')).toEqual({ ok: false, reason: 'password' });
  });

  it('keeps one key per Store ID, newest first, and replaces one remembered again', () => {
    const first = generateSecretKey();
    const second = generateSecretKey();
    rememberKey(first, PASSWORD);
    rememberKey(second, PASSWORD);
    expect(readRemembered().keys.map((key) => key.store)).toEqual([
      getPublicKey(second),
      getPublicKey(first),
    ]);
    rememberKey(first, 'another long password');
    const keys = readRemembered().keys;
    expect(keys.map((key) => key.store)).toEqual([getPublicKey(first), getPublicKey(second)]);
    const [firstKey] = keys;
    if (firstKey === undefined) {
      throw new Error('nothing remembered');
    }
    expect(unlockKey(firstKey, PASSWORD).ok).toBe(false);
    expect(unlockKey(firstKey, 'another long password').ok).toBe(true);
  });

  it('forgets one store and leaves the others, and removes the entry once none is left', () => {
    const first = generateSecretKey();
    const second = generateSecretKey();
    rememberKey(first, PASSWORD);
    rememberKey(second, PASSWORD);
    expect(forgetKey(getPublicKey(first))).toBe(true);
    expect(readRemembered().keys.map((key) => key.store)).toEqual([getPublicKey(second)]);
    expect(forgetKey(getPublicKey(first))).toBe(true);
    expect(forgetKey(getPublicKey(second))).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('refuses a key whose Store ID does not match what it unlocks to', () => {
    const secretKey = generateSecretKey();
    const other = getPublicKey(generateSecretKey());
    const locked = encrypt(secretKey, PASSWORD, REMEMBER_LOG_N);
    expect(unlockKey({ store: other, locked }, PASSWORD)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });
});

describe('what is stored, read back carefully', () => {
  const secretKey = generateSecretKey();
  const store = getPublicKey(secretKey);

  it('flags what does not parse, and offers nothing of it', () => {
    for (const raw of [
      'not json',
      '[]',
      { version: 2, keys: [] },
      { version: 1 },
      { version: 1, keys: {} },
    ]) {
      writeRaw(raw);
      expect(readRemembered()).toEqual({ available: true, keys: [], damaged: true });
    }
  });

  it('drops an entry that is damaged, of another cost, or a second one for the same store', () => {
    const good = encrypt(secretKey, PASSWORD, REMEMBER_LOG_N);
    const flipped = `${good.slice(0, 20)}${good[20] === 'q' ? 'p' : 'q'}${good.slice(21)}`;
    const other = generateSecretKey();
    const cheap = encrypt(other, PASSWORD, 10);
    writeRaw({
      version: 1,
      keys: [
        { store, locked: good },
        { store, locked: good },
        { store: getPublicKey(other), locked: cheap },
        { store: getPublicKey(generateSecretKey()), locked: flipped },
        { store: 'NOTHEX', locked: good },
        { store: getPublicKey(generateSecretKey()), locked: 7 },
        { store: getPublicKey(generateSecretKey()), locked: `${good}q` },
        { store: getPublicKey(generateSecretKey()), locked: 'npub1qqqq' },
        'loose',
      ],
    });
    const read = readRemembered();
    expect(read.damaged).toBe(true);
    expect(read.keys).toEqual([{ store, locked: good }]);
    expect(forgetDamaged()).toBe(true);
    expect(readRemembered()).toEqual({
      available: true,
      keys: [{ store, locked: good }],
      damaged: false,
    });
  });

  it('forgetting a store clears damaged leftovers too', () => {
    writeRaw('not json');
    expect(forgetKey(store)).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('a browser that keeps nothing', () => {
  it('says so when storage throws on write, and remembers nothing', () => {
    storage.failing.add('setItem');
    expect(canRemember()).toBe(false);
    expect(rememberKey(generateSecretKey(), PASSWORD)).toBe(false);
    expect(readRemembered()).toEqual({ available: false, keys: [], damaged: false });
  });

  it('says so when storage itself cannot be reached', () => {
    blockStorage();
    expect(canRemember()).toBe(false);
    expect(readRemembered()).toEqual({ available: false, keys: [], damaged: false });
    expect(rememberKey(generateSecretKey(), PASSWORD)).toBe(false);
    expect(forgetKey(getPublicKey(generateSecretKey()))).toBe(true);
    expect(isRemembered(getPublicKey(generateSecretKey()))).toBe(false);
  });

  it('says so when reading throws', () => {
    storage.failing.add('getItem');
    expect(readRemembered()).toEqual({ available: false, keys: [], damaged: false });
  });
});

describe('the password', () => {
  it(`needs ${MIN_PASSWORD_LENGTH} characters, typed the same twice`, () => {
    expect(passwordProblem('short', 'short')).toContain('at least 10 characters');
    expect(passwordProblem('123456789', '123456789')).toContain('at least 10');
    expect(passwordProblem('1234567890', '1234567891')).toContain('not the same');
    expect(passwordProblem('1234567890', '1234567890')).toBeUndefined();
  });
});

describe('the key file', () => {
  const secretKey = generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);
  const npub = nip19.npubEncode(getPublicKey(secretKey));

  it('is named after the Store ID and says the key, the Store ID, how to sign in, and the risk', () => {
    expect(keyFileName(npub)).toBe(`askr-secret-key-${npub.slice(5, 13)}.txt`);
    const text = keyFileText(nsec, npub);
    expect(text).toContain(`Secret key: ${nsec}`);
    expect(text).toContain(`Store ID: ${npub}`);
    expect(text).toContain('/admin/ and paste the secret key');
    expect(text).toContain('Whoever has this file controls your store');
  });

  it('is saved through an object URL that is revoked after, from a link that does not stay', async () => {
    vi.useFakeTimers();
    let blob: Blob | undefined;
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
      blob = object instanceof Blob ? object : undefined;
      return 'blob:askr-test';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function record(this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
      },
    );
    saveTextFile('askr-secret-key-test.txt', 'the text');
    expect(create).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([
      { href: 'blob:askr-test', download: 'askr-secret-key-test.txt', attached: true },
    ]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:askr-test');
    expect(blob?.type).toBe('text/plain;charset=utf-8');
    expect(await blob?.text()).toBe('the text');
  });
});
