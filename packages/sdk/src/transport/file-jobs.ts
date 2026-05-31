/**
 * Customer-side helpers to send/receive ENCRYPTED file jobs over Blossom with no iroh/Node dependency
 * (browser-safe). These are the seams a web app calls.
 *
 * Encrypted-Blossom needs a recipient pubkey, so a file INPUT is only meaningful on a TARGETED job (a
 * chosen provider) - hence `buildEncryptedFileInput` requires `providerPubkey`. Broadcast file inputs
 * are not supported here (no recipient to encrypt to); those stay on iroh.
 */
import type { ElisymIdentity } from '../primitives/identity';
import type { BlossomService } from '../services/blossom';
import type { FileAttachment, FileTransport } from './attachment';
import { createBlossomTransport } from './blossom-transport';

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
 * Encrypt `file` to `providerPubkey` and upload the ciphertext to Blossom, returning a `FileAttachment`
 * with a single `blossom` transport. TARGETED jobs only (a recipient pubkey is required to encrypt).
 */
export async function buildEncryptedFileInput(args: {
  file: Blob & { name?: string };
  providerPubkey: string;
  identity: ElisymIdentity;
  blossom: BlossomService;
}): Promise<FileAttachment> {
  const { file, providerPubkey, identity, blossom } = args;
  const name = file.name ?? 'upload';
  if (looksExecutable(name, file.type)) {
    throw new Error('Refusing to upload an executable file.');
  }
  const transport = createBlossomTransport({ blossom, identity });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const member = await transport.seedBytes({ bytes, recipientPubkey: providerPubkey });
  return {
    name,
    size: bytes.byteLength,
    mime: file.type || 'application/octet-stream',
    transports: [member],
  };
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
