import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { describe, it, expect } from 'vitest';
import { encryptBytesForRecipient, decryptBytesFromSender } from '../src/primitives/file-crypto';

function newIdentity() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

describe('file-crypto hybrid encryption', () => {
  it('round-trips bytes between sender and recipient', async () => {
    const sender = newIdentity();
    const recipient = newIdentity();
    const plaintext = new TextEncoder().encode('hello blossom file 🌸');

    const { ciphertext, wrappedKey, iv } = await encryptBytesForRecipient(
      plaintext,
      sender.sk,
      recipient.pk,
    );
    const decrypted = await decryptBytesFromSender(
      ciphertext,
      wrappedKey,
      iv,
      recipient.sk,
      sender.pk,
    );

    expect(new TextDecoder().decode(decrypted)).toBe('hello blossom file 🌸');
  });

  it('appends a 16-byte GCM tag and uses a distinct IV per call', async () => {
    const sender = newIdentity();
    const recipient = newIdentity();
    const pt = crypto.getRandomValues(new Uint8Array(100));

    const a = await encryptBytesForRecipient(pt, sender.sk, recipient.pk);
    const b = await encryptBytesForRecipient(pt, sender.sk, recipient.pk);

    expect(a.ciphertext.length).toBe(pt.length + 16);
    expect(a.iv).not.toBe(b.iv);
    expect([...a.ciphertext]).not.toEqual([...b.ciphertext]);
  });

  it('rejects a flipped ciphertext byte (GCM auth)', async () => {
    const sender = newIdentity();
    const recipient = newIdentity();
    const { ciphertext, wrappedKey, iv } = await encryptBytesForRecipient(
      new TextEncoder().encode('secret'),
      sender.sk,
      recipient.pk,
    );
    ciphertext[0] ^= 0xff;
    await expect(
      decryptBytesFromSender(ciphertext, wrappedKey, iv, recipient.sk, sender.pk),
    ).rejects.toThrow();
  });

  it('rejects a corrupted wrapped key', async () => {
    const sender = newIdentity();
    const recipient = newIdentity();
    const { ciphertext, wrappedKey, iv } = await encryptBytesForRecipient(
      new TextEncoder().encode('secret'),
      sender.sk,
      recipient.pk,
    );
    const corrupt = `${wrappedKey.slice(0, -2)}${wrappedKey.endsWith('aa') ? 'bb' : 'aa'}`;
    await expect(
      decryptBytesFromSender(ciphertext, corrupt, iv, recipient.sk, sender.pk),
    ).rejects.toThrow();
  });

  it('rejects the wrong recipient key', async () => {
    const sender = newIdentity();
    const recipient = newIdentity();
    const attacker = newIdentity();
    const { ciphertext, wrappedKey, iv } = await encryptBytesForRecipient(
      new TextEncoder().encode('secret'),
      sender.sk,
      recipient.pk,
    );
    await expect(
      decryptBytesFromSender(ciphertext, wrappedKey, iv, attacker.sk, sender.pk),
    ).rejects.toThrow();
  });
});
