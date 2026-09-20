import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

    const url = await uploadOrReuse(
      'picture',
      filePath,
      dir,
      cache,
      blossom,
      identity,
      onCacheUpdate,
    );

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

    const url = await uploadOrReuse(
      'picture',
      filePath,
      dir,
      cache,
      blossom,
      identity,
      onCacheUpdate,
    );

    expect(url).toBe(cachedUrl);
    expect(upload).not.toHaveBeenCalled();
    expect(onCacheUpdate).not.toHaveBeenCalled();
  });

  describe('a path that is not an image', () => {
    // Everything this function reads goes to a PUBLIC media host, and the URL is
    // published in the agent's profile. Its only containment used to be "stays
    // inside the agent directory" - and `.secrets.json` lives in that directory.
    function freshUploader() {
      const { blossom, upload } = makeBlossom({
        url: 'https://files.elisym.network/leak',
        sha256: SHA256,
        size: CONTENT.byteLength,
        type: 'application/octet-stream',
        provider: 'blossom',
      });
      return { blossom, upload, identity: ElisymIdentity.generate() };
    }

    it.each([
      ['.secrets.json', 'the agent keys'],
      ['.contacts.json', 'who the agent talks to'],
      ['.jobs.json', 'customer inputs and results'],
      ['elisym.yaml', 'a file with no business being a picture'],
      ['avatar', 'a name with no extension at all'],
    ])('never uploads %s (%s)', async (name) => {
      // `picture: .secrets.json` in a template handed to `elisym init --config`
      // was all it took: the path is inside the root, the mime fell back to
      // `application/octet-stream`, and the upload went ahead.
      const target = join(dir, name);
      writeFileSync(target, JSON.stringify({ nostr_secret_key: 'a'.repeat(64) }));
      const { blossom, upload, identity } = freshUploader();
      const onCacheUpdate = vi.fn();
      const cache: MediaCache = {};

      const url = await uploadOrReuse(
        'picture',
        target,
        dir,
        cache,
        blossom,
        identity,
        onCacheUpdate,
      );

      expect(url).toBeUndefined();
      expect(upload).not.toHaveBeenCalled();
      expect(cache).toEqual({});
    });

    it('never uploads the keys through a symlink that is NAMED like an image', async () => {
      // The check is made on the dereferenced path for this: a committed
      // `avatar.png` pointing at `.secrets.json` stays inside the root as well,
      // and resolves to the operator's OWN keys on the machine that runs it.
      const secrets = join(dir, '.secrets.json');
      writeFileSync(secrets, JSON.stringify({ nostr_secret_key: 'a'.repeat(64) }));
      const disguised = join(dir, 'avatar.png');
      symlinkSync(secrets, disguised);
      const { blossom, upload, identity } = freshUploader();

      try {
        const url = await uploadOrReuse('picture', disguised, dir, {}, blossom, identity, vi.fn());

        expect(url).toBeUndefined();
        expect(upload).not.toHaveBeenCalled();
      } finally {
        rmSync(disguised, { force: true });
      }
    });

    it('still uploads every extension the mime table knows', async () => {
      // The other direction: an allowlist that lost an entry would silently
      // stop publishing a provider's picture.
      for (const extension of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.PNG']) {
        const target = join(dir, `picture${extension}`);
        writeFileSync(target, CONTENT);
        const { blossom, upload, identity } = freshUploader();

        const url = await uploadOrReuse(
          `key${extension}`,
          target,
          dir,
          {},
          blossom,
          identity,
          vi.fn(),
        );

        expect(url, extension).toBe('https://files.elisym.network/leak');
        expect(upload, extension).toHaveBeenCalledTimes(1);
      }
    });
  });
});
