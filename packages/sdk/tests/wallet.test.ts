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
});
