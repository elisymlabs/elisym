import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyVault, MAX_SECRET_BYTES } from '../src/db/keys';

const MASTER = '11'.repeat(32);
const OWNER = 'a'.repeat(64);
const OTHER_OWNER = 'b'.repeat(64);

/** A ciphertext in the vault's layout under AD `<prefix>:<purpose>:<owner>`, of any length. */
function sealedAs(prefix: string, secret: Uint8Array, owner: string, purpose: string): Uint8Array {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(MASTER, 'hex'), nonce);
  cipher.setAAD(Buffer.from(`${prefix}:${purpose}:${owner}`, 'utf8'));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, body, cipher.getAuthTag()]);
}

/** A ciphertext as askr-server's vault seals it: same layout, AD `askr:<purpose>:<owner>`. */
function askrSealed(secret: Uint8Array, owner: string, purpose: string): Uint8Array {
  return sealedAs('askr', secret, owner, purpose);
}

describe('KeyVault', () => {
  const vault = new KeyVault(MASTER);

  it('round-trips a store key (32 bytes) and a webhook secret (64 bytes)', () => {
    const storeKey = randomBytes(32);
    const webhookSecret = Buffer.from('f'.repeat(64), 'utf8');
    expect(vault.open(vault.seal(storeKey, OWNER, 'store'), OWNER, 'store')).toEqual(
      new Uint8Array(storeKey),
    );
    expect(vault.open(vault.seal(webhookSecret, OWNER, 'webhook'), OWNER, 'webhook')).toEqual(
      new Uint8Array(webhookSecret),
    );
  });

  it('seals 1 to 256 bytes only', () => {
    expect(() => vault.seal(new Uint8Array(0), OWNER, 'store')).toThrow();
    expect(() => vault.seal(new Uint8Array(MAX_SECRET_BYTES + 1), OWNER, 'store')).toThrow();
    const one = new Uint8Array([7]);
    expect(vault.open(vault.seal(one, OWNER, 'store'), OWNER, 'store')).toEqual(one);
    const most = new Uint8Array(randomBytes(MAX_SECRET_BYTES));
    expect(vault.open(vault.seal(most, OWNER, 'webhook'), OWNER, 'webhook')).toEqual(most);
  });

  it('a sealed secret does not open for another owner, purpose, prefix or master key', () => {
    const sealed = vault.seal(randomBytes(32), OWNER, 'store');
    expect(() => vault.open(sealed, OTHER_OWNER, 'store')).toThrow();
    expect(() => vault.open(sealed, OWNER, 'webhook')).toThrow();
    expect(() => new KeyVault(MASTER, 'askr').open(sealed, OWNER, 'store')).toThrow();
    expect(() => new KeyVault('22'.repeat(32)).open(sealed, OWNER, 'store')).toThrow();
    const tampered = new Uint8Array(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => vault.open(tampered, OWNER, 'store')).toThrow();
    expect(() => vault.open(sealed.subarray(0, 28), OWNER, 'store')).toThrow('Not a sealed secret');
  });

  it('refuses a sealed value under another version byte', () => {
    const sealed = new Uint8Array(vault.seal(randomBytes(32), OWNER, 'store'));
    for (const version of [0, 2, 255]) {
      const changed = new Uint8Array(sealed);
      changed[0] = version;
      expect(() => vault.open(changed, OWNER, 'store')).toThrow('Not a sealed secret');
    }
  });

  it('opens a well-formed ciphertext of 1 to 256 bytes only', () => {
    const at = (length: number) => sealedAs('paycore', randomBytes(length), OWNER, 'store');
    expect(vault.open(at(MAX_SECRET_BYTES), OWNER, 'store')).toHaveLength(MAX_SECRET_BYTES);
    expect(vault.open(at(1), OWNER, 'store')).toHaveLength(1);
    expect(() => vault.open(at(MAX_SECRET_BYTES + 1), OWNER, 'store')).toThrow(
      'Not a sealed secret',
    );
    expect(() => vault.open(at(0), OWNER, 'store')).toThrow('Not a sealed secret');
  });

  it('an askr ciphertext under the same master key does not open', () => {
    const secret = randomBytes(32);
    const fromAskr = askrSealed(secret, OWNER, 'store');
    expect(() => vault.open(fromAskr, OWNER, 'store')).toThrow();
    // The layout is the same: only the prefix keeps it out.
    expect(new KeyVault(MASTER, 'askr').open(fromAskr, OWNER, 'store')).toEqual(
      new Uint8Array(secret),
    );
  });

  it('refuses a master key that is not 32 bytes of lowercase hex, and a bad prefix', () => {
    expect(() => new KeyVault('11'.repeat(31))).toThrow();
    expect(() => new KeyVault('AA'.repeat(32))).toThrow();
    expect(() => new KeyVault(MASTER, '')).toThrow();
    expect(() => new KeyVault(MASTER, 'pay:core')).toThrow();
  });
});
