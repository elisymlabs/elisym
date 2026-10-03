import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { describe, expect, it } from 'vitest';
import {
  createKeysFile,
  encryptHomeKeys,
  initKeys,
  loadKeys,
  merchantHome,
  takeLock,
} from '../src/home';
import {
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  type LoadedKeys,
  isSealed,
  keysFileText,
  openSecret,
  openSetupKeys,
  openCheckKeys,
  ownerOpensHere,
  parseKeysFile,
  plainKeysFile,
  readPassphrase,
  replaceKeysFile,
  sealKeys,
  storeKeyForAdmin,
} from '../src/keys';
import { decryptSecret, encryptSecret } from '../src/secret-box';

const PASSPHRASE = 'correct horse battery staple';
/** Made once by `@elisym/sdk`'s `encryptSecret`: the two must open each other's values. */
const SDK_VECTOR =
  'encrypted:v1:khaJXctOhVsFGD4jI7WfaPqIM/YHYN7wtJvoGpOoh9Ye+vFMAMyi1bgkgFceYv9EKQsdncRG+POnDP45eMIOfD7yiDvYv/zorC509507mT3Dug==';

function freshHome() {
  return merchantHome(mkdtempSync(join(tmpdir(), 'merchant-keys-')), {});
}

function newKeys(): LoadedKeys {
  return parseKeysFile(keysFileText(plainKeysFile(generateSecretKey(), generateSecretKey())));
}

describe('the secret box', () => {
  it('opens a value the sdk sealed, and refuses a wrong passphrase', () => {
    expect(decryptSecret(SDK_VECTOR, PASSPHRASE)).toBe('elisym merchant-node secret-box vector');
    expect(() => decryptSecret(SDK_VECTOR, 'wrong')).toThrow(/wrong passphrase/);
    const sealed = encryptSecret('x', PASSPHRASE);
    expect(sealed.startsWith('encrypted:v1:')).toBe(true);
    expect(decryptSecret(sealed, PASSPHRASE)).toBe('x');
  });

  it('draws a fresh salt and nonce for every value', () => {
    const first = Buffer.from(
      encryptSecret('same', PASSPHRASE).slice('encrypted:v1:'.length),
      'base64',
    );
    const second = Buffer.from(
      encryptSecret('same', PASSPHRASE).slice('encrypted:v1:'.length),
      'base64',
    );
    // salt (16) and nonce (12) lead each value.
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(16, 28).equals(second.subarray(16, 28))).toBe(false);
  });
});

describe('the passphrase', () => {
  const files: Record<string, string> = {
    '/run/secrets/a': `${PASSPHRASE}\n`,
    '/run/secrets/b': `${PASSPHRASE}\r\n`,
    '/run/secrets/empty': '\n',
  };
  const readFile = (path: string) => files[path] ?? '';

  it('comes from the variable, or the file it names with one trailing newline dropped', () => {
    expect(readPassphrase({ [PASSPHRASE_ENV]: PASSPHRASE }, readFile)).toBe(PASSPHRASE);
    expect(readPassphrase({ [PASSPHRASE_FILE_ENV]: '/run/secrets/a' }, readFile)).toBe(PASSPHRASE);
    expect(readPassphrase({ [PASSPHRASE_FILE_ENV]: '/run/secrets/b' }, readFile)).toBe(PASSPHRASE);
  });

  it('counts empty as unset, and refuses both being set', () => {
    expect(readPassphrase({}, readFile)).toBeUndefined();
    expect(readPassphrase({ [PASSPHRASE_ENV]: '' }, readFile)).toBeUndefined();
    expect(() => readPassphrase({ [PASSPHRASE_FILE_ENV]: '/run/secrets/empty' }, readFile)).toThrow(
      /passphrase file \/run\/secrets\/empty is empty/,
    );
    expect(() =>
      readPassphrase(
        { [PASSPHRASE_ENV]: PASSPHRASE, [PASSPHRASE_FILE_ENV]: '/run/secrets/a' },
        readFile,
      ),
    ).toThrow(/not both/);
  });
});

describe('keys.json', () => {
  it('reads a file from before 0.5.0: the public keys are derived', () => {
    const store = generateSecretKey();
    const owner = generateSecretKey();
    const keys = parseKeysFile(
      JSON.stringify({ store: bytesToHex(store), owner: bytesToHex(owner) }),
    );
    expect(keys.storePubkey).toBe(getPublicKey(store));
    expect(keys.ownerPubkey).toBe(getPublicKey(owner));
  });

  it('refuses a plaintext key that does not match its public key', () => {
    const file = plainKeysFile(generateSecretKey(), generateSecretKey());
    expect(() =>
      parseKeysFile(JSON.stringify({ ...file, storePubkey: getPublicKey(generateSecretKey()) })),
    ).toThrow(/store key does not match/);
  });

  it('refuses an encrypted key without its public key', () => {
    const sealed = sealKeys(newKeys(), ['store', 'owner'], PASSPHRASE);
    const { storePubkey: _dropped, ...withoutPubkey } = sealed;
    expect(() => parseKeysFile(JSON.stringify(withoutPubkey))).toThrow(/without its public key/);
  });
});

describe('opening a key', () => {
  it('needs the passphrase for a sealed key, and says which', () => {
    const keys = parseKeysFile(keysFileText(sealKeys(newKeys(), ['store', 'owner'], PASSPHRASE)));
    expect(() => openSecret(keys, 'store', undefined)).toThrow(
      `keys.json holds an encrypted store key: set ${PASSPHRASE_ENV}`,
    );
    expect(() => openSecret(keys, 'owner', undefined)).toThrow(/encrypted owner key/);
    expect(() => openSecret(keys, 'owner', 'wrong')).toThrow(/wrong passphrase/);
    expect(getPublicKey(openSecret(keys, 'store', PASSPHRASE))).toBe(keys.storePubkey);
  });

  it('refuses swapped ciphertexts: store-key would otherwise print the owner key', () => {
    const sealed = sealKeys(newKeys(), ['store', 'owner'], PASSPHRASE);
    const swapped = parseKeysFile(
      keysFileText({ ...sealed, store: sealed.owner, owner: sealed.store }),
    );
    expect(() => openSecret(swapped, 'store', PASSPHRASE)).toThrow(/store key does not match/);
    expect(() => openSecret(swapped, 'owner', PASSPHRASE)).toThrow(/owner key does not match/);
  });

  it('owner only: the store key opens with no passphrase, the owner key does not', () => {
    const keys = parseKeysFile(keysFileText(sealKeys(newKeys(), ['owner'], PASSPHRASE)));
    expect(isSealed(keys, 'store')).toBe(false);
    // What run, check, deliver and refund read.
    expect(getPublicKey(openSecret(keys, 'store', undefined))).toBe(keys.storePubkey);
    // What setup reads.
    expect(() => openSecret(keys, 'owner', undefined)).toThrow(/encrypted owner key/);
  });

  it('leaves no temporary file behind when the replace fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-keys-'));
    // keys.json as a non-empty directory: the rename over it fails.
    const target = join(directory, 'keys.json');
    mkdirSync(join(target, 'inside'), { recursive: true });
    expect(() =>
      replaceKeysFile(target, plainKeysFile(generateSecretKey(), generateSecretKey())),
    ).toThrow();
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never keeps a value that does not read back', () => {
    const keys = newKeys();
    expect(() =>
      sealKeys(keys, ['store', 'owner'], PASSPHRASE, () =>
        encryptSecret(bytesToHex(generateSecretKey()), PASSPHRASE),
      ),
    ).toThrow(/does not match/);
  });

  it('seals the rest with the same passphrase only', () => {
    const ownerOnly = parseKeysFile(keysFileText(sealKeys(newKeys(), ['owner'], PASSPHRASE)));
    const both = sealKeys(ownerOnly, ['store', 'owner'], PASSPHRASE);
    expect(both.owner).toBe(ownerOnly.sealed.owner);
    expect(both.store.startsWith('encrypted:v1:')).toBe(true);
    expect(() => sealKeys(ownerOnly, ['store', 'owner'], 'another passphrase')).toThrow(
      /wrong passphrase/,
    );
  });
});

describe('the store key for the admin', () => {
  it('is printed only to a terminal or with --yes, and is always the store key', () => {
    const keys = parseKeysFile(keysFileText(sealKeys(newKeys(), ['store', 'owner'], PASSPHRASE)));
    expect(() => storeKeyForAdmin(keys, PASSPHRASE, false, false)).toThrow(/--yes/);
    for (const [toTerminal, yes] of [
      [true, false],
      [false, true],
    ] as const) {
      const nsec = storeKeyForAdmin(keys, PASSPHRASE, toTerminal, yes);
      const decoded = decode(nsec);
      expect(decoded.type).toBe('nsec');
      expect(decoded.type === 'nsec' && getPublicKey(decoded.data)).toBe(keys.storePubkey);
    }
  });

  it('refuses swapped ciphertexts instead of printing the owner key', () => {
    const sealed = sealKeys(newKeys(), ['store', 'owner'], PASSPHRASE);
    const swapped = parseKeysFile(
      keysFileText({ ...sealed, store: sealed.owner, owner: sealed.store }),
    );
    expect(() => storeKeyForAdmin(swapped, PASSPHRASE, true, false)).toThrow(/does not match/);
  });
});

describe('the owner key check writes nostr.json from', () => {
  it('opens here only when plain or with the passphrase, and never takes a wrong one', () => {
    expect(ownerOpensHere(newKeys(), undefined)).toBe(true);
    const ownerOnly = parseKeysFile(keysFileText(sealKeys(newKeys(), ['owner'], PASSPHRASE)));
    expect(ownerOpensHere(ownerOnly, undefined)).toBe(false);
    expect(ownerOpensHere(ownerOnly, PASSPHRASE)).toBe(true);
    expect(() => ownerOpensHere(ownerOnly, 'wrong')).toThrow(/wrong passphrase/);
    // A plaintext owner public key changed in a copy of the home is refused, not written.
    const tampered = { ...ownerOnly, ownerPubkey: getPublicKey(generateSecretKey()) };
    expect(() => ownerOpensHere(tampered, PASSPHRASE)).toThrow(/does not match/);
  });
});

describe('the keys check reads', () => {
  it('writes nostr.json only for an owner key that opens here', () => {
    const plain = newKeys();
    expect(openCheckKeys(plain, undefined).writeNostrJson).toBe(true);
    const ownerOnly = parseKeysFile(keysFileText(sealKeys(newKeys(), ['owner'], PASSPHRASE)));
    expect(openCheckKeys(ownerOnly, undefined)).toMatchObject({ writeNostrJson: false });
    expect(openCheckKeys(ownerOnly, PASSPHRASE).writeNostrJson).toBe(true);
    const both = parseKeysFile(keysFileText(sealKeys(newKeys(), ['store', 'owner'], PASSPHRASE)));
    expect(() => openCheckKeys(both, undefined)).toThrow(/encrypted store key/);
  });
});

describe('the keys setup signs with', () => {
  it('opens the owner key, then the store key, or fails before anything else', () => {
    const keys = parseKeysFile(keysFileText(sealKeys(newKeys(), ['owner'], PASSPHRASE)));
    expect(() => openSetupKeys(keys, undefined)).toThrow(/encrypted owner key/);
    const opened = openSetupKeys(keys, PASSPHRASE);
    expect(getPublicKey(opened.ownerSecretKey)).toBe(keys.ownerPubkey);
    expect(getPublicKey(opened.storeSecretKey)).toBe(keys.storePubkey);
  });
});

describe('keys in the home', () => {
  it('init writes plain keys with their public keys, and encrypts both with a passphrase', () => {
    const plainHome = freshHome();
    const plain = initKeys(plainHome, undefined, false);
    expect(plain).toMatchObject({ created: true, keptPlain: false });
    expect(JSON.parse(readFileSync(plainHome.keys, 'utf8'))).toMatchObject({
      storePubkey: plain.keys.storePubkey,
      ownerPubkey: plain.keys.ownerPubkey,
    });
    expect(statSync(plainHome.keys).mode & 0o777).toBe(0o600);
    const sealedHome = freshHome();
    const sealed = initKeys(sealedHome, PASSPHRASE, false);
    const read = loadKeys(sealedHome);
    expect(isSealed(read, 'store') && isSealed(read, 'owner')).toBe(true);
    expect(getPublicKey(openSecret(read, 'owner', PASSPHRASE))).toBe(sealed.keys.ownerPubkey);
    const ownerOnlyHome = freshHome();
    initKeys(ownerOnlyHome, PASSPHRASE, true);
    const ownerOnly = loadKeys(ownerOnlyHome);
    expect([isSealed(ownerOnly, 'store'), isSealed(ownerOnly, 'owner')]).toEqual([false, true]);
  });

  it('init keeps an existing home as it is, and says it stayed plain', () => {
    const home = freshHome();
    initKeys(home, undefined, false);
    const before = readFileSync(home.keys, 'utf8');
    expect(initKeys(home, PASSPHRASE, false)).toMatchObject({ created: false, keptPlain: true });
    expect(readFileSync(home.keys, 'utf8')).toBe(before);
  });

  it('init on an encrypted home refuses a passphrase that does not open it', () => {
    const home = freshHome();
    initKeys(home, PASSPHRASE, false);
    expect(() => initKeys(home, 'a passphrase made anew by mistake', false)).toThrow(
      /wrong passphrase/,
    );
    expect(initKeys(home, PASSPHRASE, false)).toMatchObject({ created: false, keptPlain: false });
  });

  it('init on an owner-only home says nothing is left plain only for the mode asked', () => {
    const home = freshHome();
    initKeys(home, PASSPHRASE, true);
    // Owner-only again: nothing to encrypt, so no advice to encrypt both.
    expect(initKeys(home, PASSPHRASE, true)).toMatchObject({ created: false, keptPlain: false });
    // Both keys asked: the store key is still plain.
    expect(initKeys(home, PASSPHRASE, false)).toMatchObject({ created: false, keptPlain: true });
  });

  it('never rewrites a file from before 0.5.0 on load', () => {
    const home = freshHome();
    const old = `${JSON.stringify({ store: bytesToHex(generateSecretKey()), owner: bytesToHex(generateSecretKey()) })}\n`;
    createKeysFile(home, parseKeysFile(old).sealed);
    writeFileSync(home.keys, old);
    loadKeys(home);
    initKeys(home, undefined, false);
    expect(readFileSync(home.keys, 'utf8')).toBe(old);
  });

  it('encrypt-keys replaces the file atomically, under the lock, and run reads the new one', () => {
    const home = freshHome();
    const created = initKeys(home, undefined, false).keys;
    const storeBefore = bytesToHex(openSecret(created, 'store', undefined));
    const inodeBefore = statSync(home.keys).ino;
    expect(encryptHomeKeys(home, PASSPHRASE, false)).toEqual({ changed: true });
    // A new file renamed over the old one, never the old one rewritten in place.
    expect(statSync(home.keys).ino).not.toBe(inodeBefore);
    expect(statSync(home.keys).mode & 0o777).toBe(0o600);
    expect(readdirSync(home.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const after = loadKeys(home);
    expect(isSealed(after, 'store') && isSealed(after, 'owner')).toBe(true);
    expect(bytesToHex(openSecret(after, 'store', PASSPHRASE))).toBe(storeBefore);
    expect(encryptHomeKeys(home, PASSPHRASE, false)).toEqual({ changed: false });
    expect(() => encryptHomeKeys(home, 'another passphrase', false)).toThrow(/wrong passphrase/);
    // A running node holds the lock: encrypt-keys waits for it to stop.
    const other = freshHome();
    initKeys(other, undefined, false);
    const release = takeLock(other);
    try {
      expect(() => encryptHomeKeys(other, PASSPHRASE, false)).toThrow(/holds/);
    } finally {
      release();
    }
  });
});
