import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElisymIdentity } from '../src/primitives/identity';
import { BlossomService } from '../src/services/blossom';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: any, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(response),
  });
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A Blossom descriptor whose sha256 matches `bytes` so the integrity check passes. */
async function descriptorFor(bytes: Uint8Array, type: string): Promise<Record<string, unknown>> {
  const sha256 = await sha256Hex(bytes);
  return {
    url: `https://files.elisym.network/${sha256}.bin`,
    sha256,
    size: bytes.byteLength,
    type,
    uploaded: 1_700_000_000,
  };
}

const VALID_HASH = 'a'.repeat(64);

describe('BlossomService', () => {
  it('uploads file with kind-24242 BUD-11 auth header', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    mockFetch(await descriptorFor(bytes, 'image/jpeg'));

    const descriptor = await service.upload(identity, blob);

    expect(descriptor.provider).toBe('blossom');
    expect(descriptor.sha256).toBe(await sha256Hex(bytes));
    expect(descriptor.url).toMatch(/^https:\/\/files\.elisym\.network\//);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe('https://files.elisym.network/upload');
    expect(fetchCall[1].method).toBe('PUT');
    expect(fetchCall[1].headers['Content-Type']).toBe('image/jpeg');

    const authHeader = fetchCall[1].headers.Authorization as string;
    expect(authHeader).toMatch(/^Nostr /);
    const event = JSON.parse(atob(authHeader.slice(6)));
    expect(event.kind).toBe(24242);
    expect(event.tags).toContainEqual(['t', 'upload']);
    expect(event.tags).toContainEqual(['x', await sha256Hex(bytes)]);
    expect(event.tags.some((t: string[]) => t[0] === 'expiration')).toBe(true);
    expect(event.pubkey).toBe(identity.publicKey);
  });

  it('sends raw bytes as the PUT body (not FormData)', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    const bytes = new Uint8Array([10, 20, 30]);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    mockFetch(await descriptorFor(bytes, 'application/octet-stream'));

    await service.upload(identity, blob);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].body).toBeInstanceOf(Uint8Array);
    expect(fetchCall[1].body instanceof FormData).toBe(false);
    expect([...(fetchCall[1].body as Uint8Array)]).toEqual([10, 20, 30]);
  });

  it('uses a custom server URL', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService('https://custom.host');

    const bytes = new Uint8Array([1]);
    const blob = new Blob([bytes], { type: 'text/plain' });
    mockFetch(await descriptorFor(bytes, 'text/plain'));

    await service.upload(identity, blob);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe('https://custom.host/upload');
  });

  it('defaults Content-Type to application/octet-stream when the blob has no type', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    const bytes = new Uint8Array([7]);
    const blob = new Blob([bytes]);
    mockFetch(await descriptorFor(bytes, 'application/octet-stream'));

    await service.upload(identity, blob);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers['Content-Type']).toBe('application/octet-stream');
  });

  it('throws on HTTP error when no fallback is configured', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    mockFetch({}, 500);

    const blob = new Blob(['boom']);
    await expect(service.upload(identity, blob)).rejects.toThrow('Upload failed: 500');
  });

  it('throws on integrity mismatch when no fallback is configured', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    mockFetch({ url: 'https://files.elisym.network/x.bin', sha256: '0'.repeat(64) });

    const blob = new Blob(['data']);
    await expect(service.upload(identity, blob)).rejects.toThrow('integrity check failed');
  });

  it('throws when the descriptor is missing url/sha256', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    mockFetch({});

    const blob = new Blob(['data']);
    await expect(service.upload(identity, blob)).rejects.toThrow('No descriptor returned');
  });

  it('throws on a malformed JSON response', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new Error('bad json')),
    });

    const blob = new Blob(['data']);
    await expect(service.upload(identity, blob)).rejects.toThrow('Invalid response from Blossom');
  });

  it('falls back to the configured uploader when Blossom fails', async () => {
    const identity = ElisymIdentity.generate();
    const fallbackUrl = 'https://nostr.build/i/fallback.jpg';
    const service = new BlossomService('https://files.elisym.network', async () => fallbackUrl);

    mockFetch({}, 503);

    const bytes = new Uint8Array([9, 9, 9]);
    const blob = new Blob([bytes], { type: 'image/png' });
    const descriptor = await service.upload(identity, blob);

    expect(descriptor.provider).toBe('fallback');
    expect(descriptor.url).toBe(fallbackUrl);
    expect(descriptor.sha256).toBe(await sha256Hex(bytes));
    expect(descriptor.size).toBe(blob.size);
    expect(descriptor.type).toBe('image/png');
  });

  it('deletes a blob with a t=delete BUD-11 auth event', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    mockFetch({});

    await service.delete(identity, VALID_HASH);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe(`https://files.elisym.network/${VALID_HASH}`);
    expect(fetchCall[1].method).toBe('DELETE');

    const event = JSON.parse(atob((fetchCall[1].headers.Authorization as string).slice(6)));
    expect(event.kind).toBe(24242);
    expect(event.tags).toContainEqual(['t', 'delete']);
    expect(event.tags).toContainEqual(['x', VALID_HASH]);
  });

  it('rejects a malformed sha256 in delete before any request', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    mockFetch({});

    await expect(service.delete(identity, 'not-a-hash')).rejects.toThrow('64 lowercase hex');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws when delete returns an HTTP error', async () => {
    const identity = ElisymIdentity.generate();
    const service = new BlossomService();

    mockFetch({}, 404);

    await expect(service.delete(identity, VALID_HASH)).rejects.toThrow('Delete failed: 404');
  });

  it('download refuses a URL whose origin is not the configured Blossom server (SSRF)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    const service = new BlossomService('https://files.elisym.network');

    // Classic SSRF targets a remote counterparty could place in an attachment's
    // transport.url; the origin pin must refuse them before any network call.
    const hostileUrls = [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:11434/api/tags',
      `http://files.elisym.network.evil.com/${VALID_HASH}`,
      `https://evil.example/${VALID_HASH}`,
    ];
    for (const url of hostileUrls) {
      await expect(service.download(url)).rejects.toThrow(/non-Blossom origin/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('download refuses redirects and accepts a same-origin content URL', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await sha256Hex(bytes);
    let read = false;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => String(bytes.byteLength) },
      body: {
        getReader() {
          return {
            read() {
              if (read) {
                return Promise.resolve({ done: true, value: undefined });
              }
              read = true;
              return Promise.resolve({ done: false, value: bytes });
            },
            cancel() {
              return Promise.resolve();
            },
          };
        },
      },
    });
    globalThis.fetch = fetchSpy as any;

    const service = new BlossomService('https://files.elisym.network');
    const out = await service.download(`https://files.elisym.network/${sha256}`, {
      expectedSha256: sha256,
    });

    expect([...out]).toEqual([1, 2, 3, 4]);
    // redirect:'error' so a 30x from the host can't escape the pinned origin mid-fetch.
    expect(fetchSpy.mock.calls[0][1].redirect).toBe('error');
  });

  it('download aborts the in-flight fetch when an external signal fires', async () => {
    const service = new BlossomService('https://files.elisym.network');
    const controller = new AbortController();
    // A fetch that only settles when its request signal aborts - proves download wires the
    // external caller signal into the request (true cancellation, no orphan).
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const promise = service.download(`https://files.elisym.network/${VALID_HASH}`, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
