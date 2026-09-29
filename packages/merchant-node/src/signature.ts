import { type Signature, isSignature } from '@solana/kit';

/** Whether `value` is a Solana signature: kit's own check throws on text outside base58. */
export function isSolanaSignature(value: string): value is Signature {
  try {
    return isSignature(value);
  } catch {
    return false;
  }
}
