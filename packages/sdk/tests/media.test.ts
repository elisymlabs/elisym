import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElisymIdentity } from '../src/primitives/identity';
import { MediaService } from '../src/services/media';

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

describe('MediaService', () => {
  it('uploads file with NIP-98 auth header', async () => {
    const identity = ElisymIdentity.generate();
    const service = new MediaService();

    mockFetch({ data: [{ url: 'https://nostr.build/i/abc123.jpg' }] });

    const blob = new Blob(['test-image-data'], { type: 'image/jpeg' });
    const url = await service.upload(identity, blob, 'test.jpg');

    expect(url).toBe('https://nostr.build/i/abc123.jpg');

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe('https://nostr.build/api/v2/upload/files');
    expect(fetchCall[1].method).toBe('POST');

    const authHeader = fetchCall[1].headers.Authorization as string;
    expect(authHeader).toMatch(/^Nostr /);

    // Decode and verify NIP-98 event
    const eventJson = atob(authHeader.slice(6));
    const event = JSON.parse(eventJson);
    expect(event.kind).toBe(27235);
    expect(event.tags).toContainEqual(['u', 'https://nostr.build/api/v2/upload/files']);
    expect(event.tags).toContainEqual(['method', 'POST']);
    expect(event.pubkey).toBe(identity.publicKey);
  });

  it('uses custom upload URL', async () => {
    const identity = ElisymIdentity.generate();
    const service = new MediaService('https://custom.host/upload');

    mockFetch({ data: [{ url: 'https://custom.host/file.png' }] });

    const blob = new Blob(['data']);
    await service.upload(identity, blob);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe('https://custom.host/upload');

    const authHeader = fetchCall[1].headers.Authorization as string;
    const event = JSON.parse(atob(authHeader.slice(6)));
    expect(event.tags).toContainEqual(['u', 'https://custom.host/upload']);
  });

  it('throws on HTTP error', async () => {
    const identity = ElisymIdentity.generate();
    const service = new MediaService();

    mockFetch({}, 413);

    const blob = new Blob(['too-large']);
    await expect(service.upload(identity, blob)).rejects.toThrow('Upload failed: 413');
  });

  it('throws when no URL in response', async () => {
    const identity = ElisymIdentity.generate();
    const service = new MediaService();

    mockFetch({ data: [] });

    const blob = new Blob(['data']);
    await expect(service.upload(identity, blob)).rejects.toThrow('No URL returned');
  });

  it('throws on malformed response', async () => {
    const identity = ElisymIdentity.generate();
    const service = new MediaService();

    mockFetch({});

    const blob = new Blob(['data']);
    await expect(service.upload(identity, blob)).rejects.toThrow('No URL returned');
  });

  it('uses default filename when not provided', async () => {
    const identity = ElisymIdentity.generate();
    const service = new MediaService();

    mockFetch({ data: [{ url: 'https://nostr.build/i/x.jpg' }] });

    const blob = new Blob(['data']);
    await service.upload(identity, blob);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const formData = fetchCall[1].body as FormData;
    const file = formData.get('file') as File;
    expect(file.name).toBe('upload');
  });
});
