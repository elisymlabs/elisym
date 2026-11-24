import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyFileName, keyFileText } from '../../src/hosted/lib/key-file';
import {
  canRemember,
  forgetDamaged,
  forgetKey,
  isRemembered,
  readRemembered,
  rememberKey,
  unlockKey,
} from '../../src/hosted/lib/remembered';
import {
  type MemoryStorage,
  blockStorage,
  freshDeviceKeys,
  installStorage,
  plainForms,
} from './stored';

const STORAGE_KEY = 'paycore-hosted.remembered-keys';
const SEALED_BYTES = 12 + 32 + 16;

let storage: MemoryStorage;
beforeEach(() => {
  storage = installStorage();
  freshDeviceKeys();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function writeRaw(value: unknown) {
  storage.setItem(STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

async function storedDeviceKey(): Promise<CryptoKey> {
  const request = indexedDB.open('paycore-hosted');
  const db = await new Promise<IDBDatabase>((resolve) => {
    request.onsuccess = () => resolve(request.result);
  });
  const read = db.transaction('device').objectStore('device').get('remember-key');
  const device = await new Promise<unknown>((resolve) => {
    read.onsuccess = () => resolve(read.result);
  });
  db.close();
  if (!(device instanceof CryptoKey)) {
    throw new Error('no device key');
  }
  return device;
}

function bytesOf(sealed: string): Uint8Array {
  return Uint8Array.from(atob(sealed), (character) => character.charCodeAt(0));
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function rememberedOf(secretKey: Uint8Array) {
  expect(await rememberKey(secretKey)).toBe(true);
  const key = readRemembered().keys.find((known) => known.owner === getPublicKey(secretKey));
  if (key === undefined) {
    throw new Error('nothing remembered');
  }
  return key;
}

describe('remembering a key on this device', () => {
  it('writes only the sealed key, never the key itself, and opens it again with no password', async () => {
    const secretKey = generateSecretKey();
    const key = await rememberedOf(secretKey);
    const stored = storage.everything();
    const written = storage.writes.join('\n');
    for (const secret of plainForms(secretKey)) {
      expect(stored).not.toContain(secret);
      expect(written).not.toContain(secret);
    }
    expect(stored).not.toContain(base64Of(secretKey));
    expect(readRemembered()).toMatchObject({ available: true, damaged: false });
    expect(key.owner).toBe(getPublicKey(secretKey));
    expect(bytesOf(key.sealed)).toHaveLength(SEALED_BYTES);
    const unlocked = await unlockKey(key);
    expect(unlocked.ok && bytesToHex(unlocked.secretKey)).toBe(bytesToHex(secretKey));
    expect(isRemembered(getPublicKey(secretKey))).toBe(true);
  });

  it('seals with a device key no script can read out', async () => {
    const key = await rememberedOf(generateSecretKey());
    const request = indexedDB.open('paycore-hosted');
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const read = db.transaction('device').objectStore('device').get('remember-key');
    const device = await new Promise<unknown>((resolve) => {
      read.onsuccess = () => resolve(read.result);
    });
    db.close();
    expect(device).toBeInstanceOf(CryptoKey);
    expect(device instanceof CryptoKey && device.extractable).toBe(false);
    if (device instanceof CryptoKey) {
      await expect(crypto.subtle.exportKey('raw', device)).rejects.toThrow();
    }
    expect((await unlockKey(key)).ok).toBe(true);
  });

  it('uses a fresh nonce each time, and keeps using the same device key', async () => {
    const secretKey = generateSecretKey();
    const first = await rememberedOf(secretKey);
    const second = await rememberedOf(secretKey);
    expect(second.sealed).not.toBe(first.sealed);
    expect((await unlockKey(first)).ok).toBe(true);
    expect((await unlockKey(second)).ok).toBe(true);
  });

  it('cannot open a key once the device key is gone', async () => {
    const key = await rememberedOf(generateSecretKey());
    freshDeviceKeys();
    expect(await unlockKey(key)).toEqual({ ok: false, reason: 'lost' });
  });

  it('cannot open a key sealed by another device', async () => {
    const key = await rememberedOf(generateSecretKey());
    freshDeviceKeys();
    await rememberedOf(generateSecretKey());
    expect(await unlockKey(key)).toEqual({ ok: false, reason: 'lost' });
  });

  it('refuses a key that opens to another key than its owner, and wipes what it opened', async () => {
    const owner = getPublicKey(generateSecretKey());
    // Seal another key under the real device key, bound to this owner, as a forged entry would be.
    await rememberedOf(generateSecretKey());
    const device = await storedDeviceKey();
    const other = generateSecretKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner) },
        device,
        other,
      ),
    );
    const joined = new Uint8Array(SEALED_BYTES);
    joined.set(iv);
    joined.set(cipher, 12);
    // Keep what the decrypt hands back: the opened key is a view over it.
    const opened: ArrayBuffer[] = [];
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const plain = await decrypt(...args);
      opened.push(plain);
      return plain;
    });
    expect(await unlockKey({ owner, sealed: base64Of(joined) })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(opened).toHaveLength(1);
    const [plain] = opened;
    expect(plain === undefined ? false : new Uint8Array(plain).every((byte) => byte === 0)).toBe(
      true,
    );
  });

  it('says storage did not answer, not that the key is lost, when IndexedDB fails to open', async () => {
    const key = await rememberedOf(generateSecretKey());
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('Connection to Indexed Database server lost', 'UnknownError');
      },
    });
    expect(await unlockKey(key)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('replaces a device key slot holding something else, so remembering works again', async () => {
    const request = indexedDB.open('paycore-hosted', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('device');
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const put = db
      .transaction('device', 'readwrite')
      .objectStore('device')
      .put('junk', 'remember-key');
    await new Promise((resolve) => {
      put.onsuccess = resolve;
    });
    db.close();
    const key = await rememberedOf(generateSecretKey());
    expect((await unlockKey(key)).ok).toBe(true);
  });

  it('replaces an extractable key put in the device slot, and opens nothing sealed under it', async () => {
    const planted = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const owner = getPublicKey(generateSecretKey());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const secretKey = generateSecretKey();
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner) },
        planted,
        secretKey,
      ),
    );
    const request = indexedDB.open('paycore-hosted', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('device');
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const put = db
      .transaction('device', 'readwrite')
      .objectStore('device')
      .put(planted, 'remember-key');
    await new Promise((resolve) => {
      put.onsuccess = resolve;
    });
    db.close();
    const joined = new Uint8Array(SEALED_BYTES);
    joined.set(iv);
    joined.set(cipher, 12);
    expect(await unlockKey({ owner, sealed: base64Of(joined) })).toEqual({
      ok: false,
      reason: 'lost',
    });
    const key = await rememberedOf(generateSecretKey());
    const device = await storedDeviceKey();
    expect(device.extractable).toBe(false);
    expect((await unlockKey(key)).ok).toBe(true);
  });

  it('refuses a sealed key moved under another owner', async () => {
    const key = await rememberedOf(generateSecretKey());
    const other = getPublicKey(generateSecretKey());
    expect(await unlockKey({ owner: other, sealed: key.sealed })).toEqual({
      ok: false,
      reason: 'lost',
    });
  });

  it('refuses a changed byte anywhere in the sealed key', async () => {
    const key = await rememberedOf(generateSecretKey());
    for (const offset of [0, 11, 12, 43, 44, SEALED_BYTES - 1]) {
      const bytes = bytesOf(key.sealed);
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      expect(await unlockKey({ owner: key.owner, sealed: base64Of(bytes) })).toEqual({
        ok: false,
        reason: 'lost',
      });
    }
  });

  it('keeps one key per owner, newest first, and replaces one remembered again', async () => {
    const first = generateSecretKey();
    const second = generateSecretKey();
    await rememberKey(first);
    await rememberKey(second);
    expect(readRemembered().keys.map((key) => key.owner)).toEqual([
      getPublicKey(second),
      getPublicKey(first),
    ]);
    await rememberKey(first);
    expect(readRemembered().keys.map((key) => key.owner)).toEqual([
      getPublicKey(first),
      getPublicKey(second),
    ]);
  });

  it('forgets one owner and leaves the others, and removes the entry once none is left', async () => {
    const first = generateSecretKey();
    const second = generateSecretKey();
    await rememberKey(first);
    await rememberKey(second);
    expect(forgetKey(getPublicKey(first))).toBe(true);
    expect(readRemembered().keys.map((key) => key.owner)).toEqual([getPublicKey(second)]);
    expect(forgetKey(getPublicKey(first))).toBe(true);
    expect(forgetKey(getPublicKey(second))).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps a key remembered in another tab while this one sealed its own', async () => {
    const mine = generateSecretKey();
    const theirs = generateSecretKey();
    await Promise.all([rememberKey(mine), rememberKey(theirs)]);
    const keys = readRemembered().keys;
    expect(keys.map((key) => key.owner).sort()).toEqual(
      [getPublicKey(mine), getPublicKey(theirs)].sort(),
    );
    for (const key of keys) {
      expect((await unlockKey(key)).ok).toBe(true);
    }
  });
});

describe('what is stored, read back carefully', () => {
  const secretKey = generateSecretKey();
  const owner = getPublicKey(secretKey);
  const someone = getPublicKey(generateSecretKey());
  const sealed = base64Of(new Uint8Array(SEALED_BYTES));

  it('flags what does not parse, and offers nothing of it', () => {
    for (const raw of [
      'not json',
      '[]',
      { version: 0, keys: [] },
      { version: '1', keys: [] },
      { version: 1 },
      { version: 1, keys: {} },
    ]) {
      writeRaw(raw);
      expect(readRemembered()).toEqual({ available: true, keys: [], damaged: true });
    }
  });

  it.each([
    ['a sealed key that is too short', { owner: someone, sealed: base64Of(new Uint8Array(59)) }],
    ['a sealed key that is too long', { owner: someone, sealed: base64Of(new Uint8Array(61)) }],
    ['a sealed key that is not base64', { owner: someone, sealed: '%%%' }],
    ['a sealed key that is not text', { owner: someone, sealed: 7 }],
    ['an owner that is not one', { owner: 'NOTHEX', sealed }],
    ['a second entry for the same owner', { owner, sealed }],
    ['not an entry at all', 'loose'],
  ])('drops and flags %s, keeping the readable key', (_name, entry) => {
    writeRaw({ version: 1, keys: [{ owner, sealed }, entry] });
    expect(readRemembered()).toEqual({
      available: true,
      keys: [{ owner, sealed }],
      damaged: true,
    });
    expect(forgetDamaged()).toBe(true);
    expect(readRemembered()).toEqual({
      available: true,
      keys: [{ owner, sealed }],
      damaged: false,
    });
  });

  it('leaves what a newer admin remembered untouched', async () => {
    const newer = JSON.stringify({ version: 2, keys: [{ anything: true }] });
    writeRaw(newer);
    expect(readRemembered()).toEqual({ available: true, keys: [], damaged: false, newer: true });
    expect(await rememberKey(secretKey)).toBe(false);
    expect(forgetKey(owner)).toBe(false);
    expect(forgetDamaged()).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe(newer);
  });

  it('writes nothing over a value it cannot read at all, until it is cleared', async () => {
    writeRaw('not json');
    expect(forgetKey(owner)).toBe(true);
    expect(await rememberKey(secretKey)).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe('not json');
    expect(forgetDamaged()).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(await rememberKey(secretKey)).toBe(true);
  });

  it('keeps unreadable entries through remembering and forgetting other owners', async () => {
    const other = generateSecretKey();
    const unreadable = { owner: someone, sealed: '%%%' };
    writeRaw({ version: 1, keys: [{ owner, sealed }, unreadable] });
    expect(await rememberKey(other)).toBe(true);
    expect(forgetKey(owner)).toBe(true);
    const kept = storage.getItem(STORAGE_KEY) ?? '';
    expect(JSON.parse(kept).keys).toContainEqual(unreadable);
    expect(readRemembered()).toMatchObject({ damaged: true });
    expect(readRemembered().keys.map((key) => key.owner)).toEqual([getPublicKey(other)]);
  });

  it('drops unreadable entries naming the owner it forgets or replaces', async () => {
    const naming = { owner, sealed: '%%%' };
    writeRaw({ version: 1, keys: [naming] });
    expect(readRemembered()).toMatchObject({ keys: [], damaged: true });
    expect(forgetKey(owner)).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    writeRaw({ version: 1, keys: [naming] });
    expect(await rememberKey(secretKey)).toBe(true);
    expect(readRemembered()).toMatchObject({ damaged: false });
  });

  it('writes over nothing when another tab made the value unreadable meanwhile', async () => {
    const remembering = rememberKey(secretKey);
    writeRaw('not json');
    expect(await remembering).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe('not json');
  });
});

describe('a browser that keeps nothing', () => {
  it('says so when storage throws on write, and remembers nothing', async () => {
    storage.failing.add('setItem');
    expect(canRemember()).toBe(false);
    expect(await rememberKey(generateSecretKey())).toBe(false);
    expect(readRemembered()).toEqual({ available: false, keys: [], damaged: false });
  });

  it('says so when storage itself cannot be reached', async () => {
    blockStorage();
    expect(canRemember()).toBe(false);
    expect(readRemembered()).toEqual({ available: false, keys: [], damaged: false });
    expect(await rememberKey(generateSecretKey())).toBe(false);
    expect(forgetKey(getPublicKey(generateSecretKey()))).toBe(true);
    expect(isRemembered(getPublicKey(generateSecretKey()))).toBe(false);
  });

  it('says so when reading throws', () => {
    storage.failing.add('getItem');
    expect(readRemembered()).toEqual({ available: false, keys: [], damaged: false });
  });

  it('says so where there is no IndexedDB, and remembers nothing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(canRemember()).toBe(false);
    expect(await rememberKey(generateSecretKey())).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('remembers nothing when IndexedDB refuses to open', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(await rememberKey(generateSecretKey())).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('the key file', () => {
  const secretKey = generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);
  const npub = nip19.npubEncode(getPublicKey(secretKey));

  it('is named after the Owner ID and says the key, the Owner ID, where to sign in, and the risk', () => {
    expect(keyFileName(npub)).toBe(`paycore-owner-key-${npub.slice(5, 13)}.txt`);
    const text = keyFileText(nsec, npub, 'https://admin.elisym.network/hosted/');
    expect(text).toContain(`Owner key: ${nsec}`);
    expect(text).toContain(`Owner ID: ${npub}`);
    expect(text).toContain('https://admin.elisym.network/hosted/ and paste the owner key');
    expect(text).toContain('Whoever has this file controls your store');
    expect(text).not.toMatch(/askr/i);
  });
});
