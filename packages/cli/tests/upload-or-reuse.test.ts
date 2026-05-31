import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElisymIdentity, type BlobDescriptor, type BlossomService } from '@elisym/sdk';
import type { MediaCache } from '@elisym/sdk/agent-store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uploadOrReuse } from '../src/commands/start';

const CONTENT = Buffer.from('fake-image-bytes-for-test');
const SHA256 = createHash('sha256').update(CONTENT).digest('hex');

let dir: string;
let filePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elisym-upload-test-'));
  filePath = join(dir, 'hero.png');
  writeFileSync(filePath, CONTENT);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeBlossom(descriptor: BlobDescriptor) {
  let capturedType: string | undefined;
  const upload = vi.fn(async (_identity: ElisymIdentity, file: Blob): Promise<BlobDescriptor> => {
    capturedType = file.type;
    return descriptor;
  });
  const blossom: Pick<BlossomService, 'upload'> = { upload };
  return { blossom, upload, getCapturedType: () => capturedType };
}

describe('uploadOrReuse', () => {
  it('uploads on cache miss, sets the Blob mime, and caches the descriptor URL', async () => {
    const identity = ElisymIdentity.generate();
    const cache: MediaCache = {};
    const descriptor: BlobDescriptor = {
      url: 'https://files.elisym.network/abc.png',
      sha256: SHA256,
      size: CONTENT.byteLength,
      type: 'image/png',
      provider: 'blossom',
    };
    const { blossom, upload, getCapturedType } = makeBlossom(descriptor);
    const onCacheUpdate = vi.fn();

    const url = await uploadOrReuse('picture', filePath, cache, blossom, identity, onCacheUpdate);

    expect(url).toBe(descriptor.url);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(getCapturedType()).toBe('image/png');
    expect(cache.picture).toEqual({
      url: descriptor.url,
      sha256: SHA256,
      uploaded_at: expect.any(String),
    });
    expect(onCacheUpdate).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached URL on a hash hit without uploading', async () => {
    const identity = ElisymIdentity.generate();
    const cachedUrl = 'https://files.elisym.network/cached.png';
    const cache: MediaCache = {
      picture: { url: cachedUrl, sha256: SHA256, uploaded_at: '2026-01-01T00:00:00.000Z' },
    };
    const descriptor: BlobDescriptor = {
      url: 'https://files.elisym.network/new.png',
      sha256: SHA256,
      size: CONTENT.byteLength,
      type: 'image/png',
      provider: 'blossom',
    };
    const { blossom, upload } = makeBlossom(descriptor);
    const onCacheUpdate = vi.fn();

    const url = await uploadOrReuse('picture', filePath, cache, blossom, identity, onCacheUpdate);

    expect(url).toBe(cachedUrl);
    expect(upload).not.toHaveBeenCalled();
    expect(onCacheUpdate).not.toHaveBeenCalled();
  });
});
