import { describe, it, expect } from 'vitest';
import { nip44Encrypt, nip44Decrypt } from '../src/primitives/crypto';
import { ElisymIdentity } from '../src/primitives/identity';

describe('NIP-44 encryption', () => {
  it('encrypt then decrypt roundtrip', () => {
    const sender = ElisymIdentity.generate();
    const receiver = ElisymIdentity.generate();

    const plaintext = 'Hello, agent!';
    const ciphertext = nip44Encrypt(plaintext, sender.secretKey, receiver.publicKey);

    expect(ciphertext).not.toBe(plaintext);

    const decrypted = nip44Decrypt(ciphertext, receiver.secretKey, sender.publicKey);
    expect(decrypted).toBe(plaintext);
  });

  it('decrypt with wrong key throws', () => {
    const sender = ElisymIdentity.generate();
    const receiver = ElisymIdentity.generate();
    const wrong = ElisymIdentity.generate();

    const ciphertext = nip44Encrypt('secret', sender.secretKey, receiver.publicKey);

    expect(() => nip44Decrypt(ciphertext, wrong.secretKey, sender.publicKey)).toThrow();
  });

  it('different sender/receiver pairs produce different ciphertexts', () => {
    const a = ElisymIdentity.generate();
    const b = ElisymIdentity.generate();
    const c = ElisymIdentity.generate();

    const plaintext = 'same message';
    const ct1 = nip44Encrypt(plaintext, a.secretKey, b.publicKey);
    const ct2 = nip44Encrypt(plaintext, a.secretKey, c.publicKey);

    expect(ct1).not.toBe(ct2);
  });

  it('rejects empty string (NIP-44 requires 1-65535 bytes)', () => {
    const sender = ElisymIdentity.generate();
    const receiver = ElisymIdentity.generate();

    expect(() => nip44Encrypt('', sender.secretKey, receiver.publicKey)).toThrow();
  });

  it('handles unicode content', () => {
    const sender = ElisymIdentity.generate();
    const receiver = ElisymIdentity.generate();

    const plaintext = 'Hello \u{1F30D} \u{1F916} \u0410\u0411\u0412';
    const ciphertext = nip44Encrypt(plaintext, sender.secretKey, receiver.publicKey);
    const decrypted = nip44Decrypt(ciphertext, receiver.secretKey, sender.publicKey);
    expect(decrypted).toBe(plaintext);
  });
});
