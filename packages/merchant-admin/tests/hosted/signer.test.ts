import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { describe, expect, it, vi } from 'vitest';
import * as signer from '../../src/hosted/lib/signer';

const TEMPLATE = { kind: 1, created_at: 1_700_000_000, tags: [], content: 'x' };

describe('a pasted owner key', () => {
  it('is read from an nsec or 64 hex characters, either case, trimmed', () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);
    for (const pasted of [nip19.nsecEncode(secretKey), hex, hex.toUpperCase(), `  ${hex}\n`]) {
      const parsed = signer.parseSecretKey(pasted);
      expect(parsed && bytesToHex(parsed)).toBe(hex);
    }
  });

  it('is refused when it is not a secret key, or zero or past the curve order', () => {
    expect(signer.parseSecretKey('0'.repeat(64))).toBeUndefined();
    expect(signer.parseSecretKey('f'.repeat(64))).toBeUndefined();
    expect(signer.parseSecretKey(`${'0'.repeat(63)}1`)).toBeDefined();
    expect(signer.parseSecretKey(nip19.npubEncode(getPublicKey(generateSecretKey())))).toBe(
      undefined,
    );
    expect(signer.parseSecretKey('nsec1nope')).toBeUndefined();
    expect(signer.parseSecretKey('a'.repeat(63))).toBeUndefined();
    expect(signer.publicKeyOf(new Uint8Array(32))).toBeUndefined();
  });
});

describe('the signer', () => {
  it('signs as the key, from its own copy: zeroing the caller’s bytes changes nothing', async () => {
    const secretKey = generateSecretKey();
    const owner = signer.secretKeySigner(secretKey);
    secretKey.fill(0);
    const event = await owner.signEvent(TEMPLATE);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(owner.pubkey);
  });

  it('signs nothing once closed (sign out)', async () => {
    const owner = signer.secretKeySigner(generateSecretKey());
    owner.close();
    await expect(owner.signEvent(TEMPLATE)).rejects.toThrow('signed out');
    expect(() => owner.close()).not.toThrow();
  });

  it('zeroes the copy it held when closed', () => {
    const secretKey = generateSecretKey();
    // The signer's copy is the one Uint8Array.from makes of the key.
    const from = vi.spyOn(Uint8Array, 'from');
    const owner = signer.secretKeySigner(secretKey);
    const copies = from.mock.results.map((result) => result.value);
    from.mockRestore();
    const copy = copies.find(
      (made): made is Uint8Array =>
        made instanceof Uint8Array && bytesToHex(made) === bytesToHex(secretKey),
    );
    expect(copy).toBeDefined();
    owner.close();
    expect(copy?.every((byte) => byte === 0)).toBe(true);
    expect(secretKey.some((byte) => byte !== 0)).toBe(true);
  });

  it('makes a new owner key shown as an nsec and an npub of the same key', () => {
    const made = signer.generateOwnerKey();
    const decoded = nip19.decode(made.nsec);
    expect(decoded.type === 'nsec' && bytesToHex(decoded.data)).toBe(bytesToHex(made.secretKey));
    expect(made.npub).toBe(nip19.npubEncode(getPublicKey(made.secretKey)));
  });

  it('takes a secret key only: no browser extension signer is offered', () => {
    for (const name of Object.keys(signer)) {
      expect(name).not.toMatch(/extension|windowNostr|nip07/i);
    }
  });
});
