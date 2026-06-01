/**
 * Encrypted Blossom blob transport - the browser-safe peer to the (Node-only) iroh transport.
 *
 * Seeds a file by encrypting it to a recipient (hybrid AES-256-GCM + NIP-44 key-wrap) and uploading
 * the ciphertext to a Blossom relay; fetches by downloading the ciphertext (bounded + sha256-verified)
 * and decrypting it. The local party's `identity` is both the BUD-11 upload signer AND the
 * encryption sender/receiver; the counterparty pubkey is passed per call.
 */
import { LIMITS } from '../constants';
import { decryptBytesFromSender, encryptBytesForRecipient } from '../primitives/file-crypto';
import type { ElisymIdentity } from '../primitives/identity';
import type { BlossomService } from '../services/blossom';
import type { FileTransport } from './attachment';

type BlossomTransport = Extract<FileTransport, { kind: 'blossom' }>;

// AES-256-GCM appends a 16-byte auth tag, so the uploaded ciphertext is exactly 16 bytes larger than
// the plaintext. The size caps are expressed in PLAINTEXT bytes (the seed side gates on plaintext
// length), so the ciphertext-download bound is widened by the tag - otherwise a file at exactly the
// cap seeds fine but its (cap + 16) ciphertext trips the streamed-bytes guard and can't be fetched.
const AES_GCM_TAG_BYTES = 16;

export interface BlossomBlobTransport {
  /** Encrypt `bytes` to `recipientPubkey`, upload the ciphertext, return a `blossom` transport member. */
  seedBytes(args: { bytes: Uint8Array; recipientPubkey: string }): Promise<BlossomTransport>;
  /** Download the ciphertext (bounded + sha256-verified) and decrypt it (sent by `senderPubkey`). */
  fetchToBytes(args: {
    transport: BlossomTransport;
    senderPubkey: string;
    maxBytes?: number;
    /** Abort the in-flight download (e.g. job stop() / input-fetch budget). */
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export function createBlossomTransport(opts: {
  blossom: BlossomService;
  identity: ElisymIdentity;
}): BlossomBlobTransport {
  const { blossom, identity } = opts;
  return {
    async seedBytes({ bytes, recipientPubkey }) {
      if (bytes.byteLength > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES) {
        throw new Error(
          `File too large for encrypted Blossom: ${bytes.byteLength} bytes exceeds ${LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES}.`,
        );
      }
      const { ciphertext, wrappedKey, iv } = await encryptBytesForRecipient(
        bytes,
        identity.secretKey,
        recipientPubkey,
      );
      // Upload the ciphertext as opaque octet-stream - the plaintext mime never reaches the relay.
      const blob = new Blob([ciphertext], { type: 'application/octet-stream' });
      const descriptor = await blossom.upload(identity, blob);
      if (descriptor.provider !== 'blossom') {
        // Fell back to nostr.build: its URL is not content-addressed by our ciphertext sha256, so the
        // fetch-time integrity check would fail. Refuse so the caller emits an iroh-only attachment.
        throw new Error('Blossom upload fell back to a non-content-addressed provider.');
      }
      return {
        kind: 'blossom',
        url: descriptor.url,
        sha256: descriptor.sha256,
        enc: { alg: 'AES-256-GCM', iv, key: wrappedKey },
      };
    },

    async fetchToBytes({ transport, senderPubkey, maxBytes, signal }) {
      const plaintextCap = maxBytes ?? LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES;
      const ciphertext = await blossom.download(transport.url, {
        maxBytes: plaintextCap + AES_GCM_TAG_BYTES,
        expectedSha256: transport.sha256,
        signal,
      });
      return decryptBytesFromSender(
        ciphertext,
        transport.enc.key,
        transport.enc.iv,
        identity.secretKey,
        senderPubkey,
      );
    },
  };
}
