import { describe, expect, it, vi } from 'vitest';
import { ElisymIdentity } from '../src/primitives/identity';
import type { BlobDescriptor, BlossomService } from '../src/services/blossom';
import { fetchEncryptedFileOutput, prepareEncryptedFileInput } from '../src/transport/file-jobs';

const SERVER = 'https://files.test';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A content-addressed fake: `contentUrl` and the upload-returned url both = SERVER/sha256
// (no extension - matching the real relay for octet-stream uploads). Stores bytes by url
// so fetchEncryptedFileOutput can round-trip.
function makeFakeBlossom() {
  const store = new Map<string, Uint8Array>();
  const upload = vi.fn(async (_identity: ElisymIdentity, blob: Blob): Promise<BlobDescriptor> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    const url = `${SERVER}/${sha256}`;
    store.set(url, bytes);
    return {
      url,
      sha256,
      size: bytes.byteLength,
      type: 'application/octet-stream',
      provider: 'blossom',
    };
  });
  const blossom = {
    contentUrl: (sha256: string) => `${SERVER}/${sha256}`,
    upload,
    download: vi.fn(async (url: string) => {
      const bytes = store.get(url);
      if (bytes === undefined) {
        throw new Error(`404 ${url}`);
      }
      return bytes;
    }),
  } as unknown as BlossomService;
  return { blossom, upload };
}

function fileOf(bytes: Uint8Array, name: string, type: string): Blob & { name?: string } {
  return Object.assign(new Blob([bytes], { type }), { name });
}

describe('prepareEncryptedFileInput (deferred upload)', () => {
  it('builds a content-addressed descriptor and does NOT upload until upload() is called', async () => {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const { blossom, upload } = makeFakeBlossom();

    const { attachment, upload: deferredUpload } = await prepareEncryptedFileInput({
      file: fileOf(new Uint8Array([1, 2, 3, 4]), 'pic.png', 'image/png'),
      providerPubkey: provider.publicKey,
      identity: customer,
      blossom,
    });

    const member = attachment.transports[0]!;
    expect(member.kind).toBe('blossom');
    expect(attachment.name).toBe('pic.png');
    // url is derived from the ciphertext sha256 BEFORE any upload.
    if (member.kind === 'blossom') {
      expect(member.url).toBe(`${SERVER}/${member.sha256}`);
    }
    expect(upload).not.toHaveBeenCalled();

    await deferredUpload();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('round-trips: the customer can fetch + decrypt its own uploaded input', async () => {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const { blossom } = makeFakeBlossom();
    const original = new Uint8Array([9, 8, 7, 6, 5]);

    const { attachment, upload } = await prepareEncryptedFileInput({
      file: fileOf(original, 'in.bin', 'application/octet-stream'),
      providerPubkey: provider.publicKey,
      identity: customer,
      blossom,
    });
    await upload();

    // NIP-44 is symmetric, so the sender (customer) decrypts with its own key + the
    // recipient (provider) pubkey - exactly what the input-preview feature relies on.
    const out = await fetchEncryptedFileOutput({
      attachment,
      providerPubkey: provider.publicKey,
      identity: customer,
      blossom,
    });
    expect(out.bytes).toEqual(original);
  });

  it('upload() throws if the server returns a mismatched url/sha256', async () => {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const blossom = {
      contentUrl: (sha256: string) => `${SERVER}/${sha256}`,
      upload: vi.fn(
        async (): Promise<BlobDescriptor> => ({
          url: `${SERVER}/deadbeef`,
          sha256: 'deadbeef',
          size: 1,
          type: 'application/octet-stream',
          provider: 'blossom',
        }),
      ),
    } as unknown as BlossomService;

    const { upload } = await prepareEncryptedFileInput({
      file: fileOf(new Uint8Array([1]), 'x.bin', 'application/octet-stream'),
      providerPubkey: provider.publicKey,
      identity: customer,
      blossom,
    });
    await expect(upload()).rejects.toThrow(/mismatch/);
  });

  it('refuses an executable input before any encryption/upload', async () => {
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const { blossom, upload } = makeFakeBlossom();
    await expect(
      prepareEncryptedFileInput({
        file: fileOf(new Uint8Array([1]), 'evil.exe', 'application/x-msdownload'),
        providerPubkey: provider.publicKey,
        identity: customer,
        blossom,
      }),
    ).rejects.toThrow(/executable/);
    expect(upload).not.toHaveBeenCalled();
  });
});
