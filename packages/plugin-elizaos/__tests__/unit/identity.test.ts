import { ElisymIdentity } from '@elisym/sdk';
import { describe, it, expect } from 'vitest';
import { identityFromHex, identityToHex } from '../../src/lib/identity';

describe('identity helpers', () => {
  it('round-trips via hex', () => {
    const fresh = ElisymIdentity.generate();
    const hex = identityToHex(fresh);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const restored = identityFromHex(hex);
    expect(restored.publicKey).toBe(fresh.publicKey);
  });

  it('rejects malformed hex', () => {
    expect(() => identityFromHex('zz')).toThrow();
  });
});
