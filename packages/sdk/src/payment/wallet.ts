import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
  type KeyPairSigner,
} from '@solana/kit';

/**
 * Extract the 64-byte secret key (32-byte private seed + 32-byte public key)
 * from an extractable KeyPairSigner. This matches the format used by
 * solana-keygen and `createKeyPairSignerFromBytes`, and - base58-encoded -
 * the at-rest `solana_secret_key` format in `.secrets.json`.
 */
export async function exportKeyPairBytes(signer: KeyPairSigner): Promise<Uint8Array> {
  const { privateKey, publicKey } = signer.keyPair;
  const [pkcs8, rawPub] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', privateKey),
    crypto.subtle.exportKey('raw', publicKey),
  ]);
  // PKCS#8 has a fixed 16-byte Ed25519 header; the raw 32-byte seed follows.
  const privateBytes = new Uint8Array(pkcs8).slice(16);
  const publicBytes = new Uint8Array(rawPub);
  const bytes = new Uint8Array(64);
  bytes.set(privateBytes, 0);
  bytes.set(publicBytes, 32);
  return bytes;
}

/** Encode raw 64 keypair bytes (e.g. a solana-keygen JSON array) into the at-rest base58 form. */
export function encodeSecretKeyBase58(bytes: Uint8Array): string {
  // Codecs are constructed per call (not at module scope) so importing the
  // SDK entry stays side-effect-free under partially-mocked @solana/kit.
  return getBase58Decoder().decode(bytes);
}

/** Decode the at-rest base58 `solana_secret_key` (64 bytes: seed + public key) into a signer. */
export async function signerFromSecretKeyBase58(secretKeyBase58: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(new Uint8Array(getBase58Encoder().encode(secretKeyBase58)));
}

/** Generate a fresh extractable Solana wallet plus its at-rest base58 secret. */
export async function generateSolanaWallet(): Promise<{
  signer: KeyPairSigner;
  secretKeyBase58: string;
}> {
  const signer = await generateKeyPairSigner(true);
  const bytes = await exportKeyPairBytes(signer);
  return { signer, secretKeyBase58: encodeSecretKeyBase58(bytes) };
}
