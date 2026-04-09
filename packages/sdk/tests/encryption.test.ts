import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncrypted } from '../src/primitives/encryption';

describe('isEncrypted', () => {
  it('returns true for encrypted values', () => {
    expect(isEncrypted('encrypted:v1:abc123')).toBe(true);
  });

  it('returns false for plain values', () => {
    expect(isEncrypted('abc123')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted('encrypted:v2:abc')).toBe(false);
  });
});

describe('encryptSecret / decryptSecret', () => {
  const passphrase = 'test-passphrase-123';

  it('round-trips a secret', () => {
    const plaintext = 'my-secret-key-hex-1234567890abcdef';
    const encrypted = encryptSecret(plaintext, passphrase);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    const decrypted = decryptSecret(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext each time (random salt/iv)', () => {
    const plaintext = 'same-secret';
    const a = encryptSecret(plaintext, passphrase);
    const b = encryptSecret(plaintext, passphrase);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, passphrase)).toBe(plaintext);
    expect(decryptSecret(b, passphrase)).toBe(plaintext);
  });

  it('throws on wrong passphrase', () => {
    const encrypted = encryptSecret('secret', passphrase);
    expect(() => decryptSecret(encrypted, 'wrong-passphrase')).toThrow('Decryption failed');
  });

  it('throws on corrupted data', () => {
    expect(() => decryptSecret('encrypted:v1:invalid-base64!!!', passphrase)).toThrow();
  });

  it('throws on non-encrypted input', () => {
    expect(() => decryptSecret('plaintext', passphrase)).toThrow('not encrypted');
  });

  it('throws on truncated payload', () => {
    const short = 'encrypted:v1:' + Buffer.from('short').toString('base64');
    expect(() => decryptSecret(short, passphrase)).toThrow('too short');
  });

  it('handles empty string secret', () => {
    const encrypted = encryptSecret('', passphrase);
    expect(decryptSecret(encrypted, passphrase)).toBe('');
  });

  it('handles unicode secrets', () => {
    const plaintext = 'secret with unicode - test';
    const encrypted = encryptSecret(plaintext, passphrase);
    expect(decryptSecret(encrypted, passphrase)).toBe(plaintext);
  });
});
