import { describe, expect, it } from 'vitest';
import {
  encodeSecretKeyBase58,
  exportKeyPairBytes,
  generateSolanaWallet,
  signerFromSecretKeyBase58,
} from '../src/payment/wallet';

describe('payment/wallet helpers', () => {
  it('round-trips a generated wallet through the base58 at-rest format', async () => {
    const { signer, secretKeyBase58 } = await generateSolanaWallet();
    const restored = await signerFromSecretKeyBase58(secretKeyBase58);
    expect(restored.address).toBe(signer.address);
  });

  it('exportKeyPairBytes produces the 64-byte solana-keygen layout', async () => {
    const { signer, secretKeyBase58 } = await generateSolanaWallet();
    const bytes = await exportKeyPairBytes(signer);
    expect(bytes).toHaveLength(64);
    expect(encodeSecretKeyBase58(bytes)).toBe(secretKeyBase58);
  });

  // The material must never ride the failure out of this function. Callers
  // print `error.message`: the CLI's `safe()` wrapper does it for any uncaught
  // command error, and `start` does it deliberately when a delegate key will
  // not read. kit's own message for a bad-base58 string is "Invalid value
  // <the whole key> for base 58 ...", so quoting it put the agent's secret key
  // on the terminal and in the scrollback.
  it('refuses a key that is not base58 without repeating it back', async () => {
    // `0`, `O`, `I` and `l` are the four characters base58 leaves out, so this
    // fails inside the ENCODER - the path whose error context holds the string.
    const secretish = `S3cr3tKeyMaterial${'0'.repeat(20)}${'O'.repeat(20)}`;
    const error = await signerFromSecretKeyBase58(secretish).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('not a readable base58-encoded 64-byte Solana key');
    expect(error.message).not.toContain(secretish);
    expect(error.message).not.toContain('S3cr3tKeyMaterial');
    // Not attached as `cause` either: a cause still holds the value, and Node
    // prints the cause chain for an uncaught error.
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('refuses valid base58 of the wrong length without repeating it back', async () => {
    const tooShort = encodeSecretKeyBase58(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const error = await signerFromSecretKeyBase58(tooShort).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('not a readable base58-encoded 64-byte Solana key');
    expect(error.message).not.toContain(tooShort);
  });
});
