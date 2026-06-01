/**
 * Customer-side helpers to send/receive ENCRYPTED file jobs over Blossom with no iroh/Node dependency
 * (browser-safe). These are the seams a web app calls.
 *
 * Encrypted-Blossom needs a recipient pubkey, so a file INPUT is only meaningful on a TARGETED job (a
 * chosen provider) - hence `buildEncryptedFileInput` requires `providerPubkey`. Broadcast file inputs
 * are not supported here (no recipient to encrypt to); those stay on iroh.
 */
import { LIMITS } from '../constants';
import { encryptBytesForRecipient } from '../primitives/file-crypto';
import type { ElisymIdentity } from '../primitives/identity';
import type { BlossomService } from '../services/blossom';
import type { FileAttachment, FileTransport } from './attachment';
import { createBlossomTransport } from './blossom-transport';

/** Hex SHA-256 of bytes (WebCrypto; matches what the Blossom server computes). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Best-effort, UX-only refusal of obviously-executable inputs. NOT a security control - once the bytes
// are ciphertext the relay cannot enforce anything; this just helps users avoid an obvious mistake.
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.sh',
  '.app',
  '.scr',
  '.ps1',
]);
const EXECUTABLE_MIMES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-mach-binary',
]);

function looksExecutable(name: string, type: string): boolean {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return EXECUTABLE_EXTENSIONS.has(ext) || EXECUTABLE_MIMES.has(type);
}

/**
 * Encrypt `file` to `providerPubkey` and build a complete `FileAttachment` WITHOUT uploading the bytes
 * yet. Because Blossom is content-addressed, the blob URL is derivable from the ciphertext sha256, so the
 * caller can submit the job request with this descriptor and DEFER the byte upload (via the returned
 * `upload()`) until the customer commits - e.g. after the provider quotes a price, so an unresponsive
 * provider never costs a wasted upload. TARGETED jobs only (a recipient pubkey is required to encrypt).
 *
 * `upload()` PUTs the ciphertext and verifies the server returns the precomputed url/sha256 (the request
 * already carries them, so a mismatch must fail loudly - pre-commit - rather than 404 the provider).
 */
export async function prepareEncryptedFileInput(args: {
  file: Blob & { name?: string };
  providerPubkey: string;
  identity: ElisymIdentity;
  blossom: BlossomService;
}): Promise<{ attachment: FileAttachment; upload: () => Promise<void> }> {
  const { file, providerPubkey, identity, blossom } = args;
  const name = file.name ?? 'upload';
  if (looksExecutable(name, file.type)) {
    throw new Error('Refusing to upload an executable file.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES) {
    throw new Error(
      `File too large for the encrypted-Blossom transport: ${bytes.byteLength} bytes ` +
        `(max ${LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES}).`,
    );
  }
  const { ciphertext, wrappedKey, iv } = await encryptBytesForRecipient(
    bytes,
    identity.secretKey,
    providerPubkey,
  );
  const sha256 = await sha256Hex(ciphertext);
  const member: Extract<FileTransport, { kind: 'blossom' }> = {
    kind: 'blossom',
    url: blossom.contentUrl(sha256),
    sha256,
    enc: { alg: 'AES-256-GCM', iv, key: wrappedKey },
  };
  const attachment: FileAttachment = {
    name,
    size: bytes.byteLength,
    mime: file.type || 'application/octet-stream',
    transports: [member],
  };
  const upload = async (): Promise<void> => {
    const descriptor = await blossom.upload(
      identity,
      new Blob([ciphertext], { type: 'application/octet-stream' }),
    );
    if (descriptor.provider !== 'blossom') {
      throw new Error('Blossom upload fell back to a non-content-addressed provider.');
    }
    if (descriptor.sha256 !== sha256 || descriptor.url !== member.url) {
      throw new Error(
        `Blossom upload descriptor mismatch (expected ${member.url} / ${sha256}, ` +
          `got ${descriptor.url} / ${descriptor.sha256}).`,
      );
    }
  };
  return { attachment, upload };
}

/**
 * Encrypt `file` to `providerPubkey` AND upload it immediately, returning the `FileAttachment`
 * (prepare + upload in one step). Use `prepareEncryptedFileInput` when you want to defer the upload.
 */
export async function buildEncryptedFileInput(args: {
  file: Blob & { name?: string };
  providerPubkey: string;
  identity: ElisymIdentity;
  blossom: BlossomService;
}): Promise<FileAttachment> {
  const prepared = await prepareEncryptedFileInput(args);
  await prepared.upload();
  return prepared.attachment;
}

/**
 * Download + decrypt a `blossom` file output from an attachment (sent by `providerPubkey`). Returns the
 * plaintext bytes plus the envelope-carried name/mime. Throws if there is no blossom transport.
 */
export async function fetchEncryptedFileOutput(args: {
  attachment: FileAttachment;
  providerPubkey: string;
  identity: ElisymIdentity;
  blossom: BlossomService;
  maxBytes?: number;
}): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
  const { attachment, providerPubkey, identity, blossom, maxBytes } = args;
  const member = attachment.transports.find(
    (t): t is Extract<FileTransport, { kind: 'blossom' }> => t.kind === 'blossom',
  );
  if (member === undefined) {
    throw new Error('Attachment has no blossom transport.');
  }
  const transport = createBlossomTransport({ blossom, identity });
  const bytes = await transport.fetchToBytes({
    transport: member,
    senderPubkey: providerPubkey,
    maxBytes,
  });
  return { bytes, name: attachment.name, mime: attachment.mime };
}
