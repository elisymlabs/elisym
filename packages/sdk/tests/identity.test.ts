import { describe, it, expect } from 'vitest';
import { ElisymIdentity } from '../src/primitives/identity';

describe('ElisymIdentity', () => {
  describe('generate', () => {
    it('produces a valid identity', () => {
      const id = ElisymIdentity.generate();
      expect(id.secretKey).toBeInstanceOf(Uint8Array);
      expect(id.secretKey.length).toBe(32);
      expect(id.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(id.npub).toMatch(/^npub1/);
    });

    it('produces unique identities', () => {
      const a = ElisymIdentity.generate();
      const b = ElisymIdentity.generate();
      expect(a.publicKey).not.toBe(b.publicKey);
    });
  });

  describe('fromHex', () => {
    it('roundtrips correctly', () => {
      const original = ElisymIdentity.generate();
      const hex = Array.from(original.secretKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const restored = ElisymIdentity.fromHex(hex);
      expect(restored.publicKey).toBe(original.publicKey);
      expect(restored.npub).toBe(original.npub);
    });

    it('rejects hex with wrong length', () => {
      expect(() => ElisymIdentity.fromHex('abcd')).toThrow('Invalid secret key hex');
      expect(() => ElisymIdentity.fromHex('a'.repeat(62))).toThrow('Invalid secret key hex');
      expect(() => ElisymIdentity.fromHex('a'.repeat(66))).toThrow('Invalid secret key hex');
    });

    it('rejects non-hex characters', () => {
      expect(() => ElisymIdentity.fromHex('g'.repeat(64))).toThrow('Invalid secret key hex');
      expect(() => ElisymIdentity.fromHex('z'.repeat(64))).toThrow('Invalid secret key hex');
    });

    it('accepts uppercase hex', () => {
      const id = ElisymIdentity.generate();
      const hex = Array.from(id.secretKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
      const restored = ElisymIdentity.fromHex(hex);
      expect(restored.publicKey).toBe(id.publicKey);
    });
  });

  describe('scrub', () => {
    it('zeros secret key bytes', () => {
      const id = ElisymIdentity.generate();
      expect(id.secretKey.some((b) => b !== 0)).toBe(true);
      id.scrub();
      expect(id.secretKey.every((b) => b === 0)).toBe(true);
    });
  });

  describe('fromSecretKey', () => {
    it('produces matching public key', () => {
      const original = ElisymIdentity.generate();
      const restored = ElisymIdentity.fromSecretKey(original.secretKey);
      expect(restored.publicKey).toBe(original.publicKey);
      expect(restored.npub).toBe(original.npub);
    });

    it('rejects wrong length', () => {
      expect(() => ElisymIdentity.fromSecretKey(new Uint8Array(16))).toThrow('exactly 32 bytes');
      expect(() => ElisymIdentity.fromSecretKey(new Uint8Array(64))).toThrow('exactly 32 bytes');
      expect(() => ElisymIdentity.fromSecretKey(new Uint8Array(0))).toThrow('exactly 32 bytes');
    });
  });
});
