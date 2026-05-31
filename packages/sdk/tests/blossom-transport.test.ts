import { describe, it, expect } from 'vitest';
import { LIMITS } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import type { BlossomService } from '../src/services/blossom';
import { createBlossomTransport } from '../src/transport/blossom-transport';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// In-memory fake BlossomService: stores the uploaded ciphertext by sha256 and serves it via download(),
// faithfully re-verifying the sha256 of the bytes it returns (like the real bounded download).
function fakeBlossom(provider: 'blossom' | 'fallback' = 'blossom') {
  const store = new Map<string, Uint8Array>();
  const svc = {
    async upload(_identity: ElisymIdentity, blob: Blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = await sha256Hex(bytes);
      store.set(sha256, bytes);
      return {
        url: `https://files.elisym.network/${sha256}.bin`,
        sha256,
        size: bytes.byteLength,
        type: blob.type,
        provider,
      };
    },
    async download(url: string, opts?: { maxBytes?: number; expectedSha256?: string }) {
      const sha = url.split('/').pop()?.replace('.bin', '') ?? '';
      const bytes = store.get(sha);
      if (!bytes) {
        throw new Error('not found');
      }
      if (opts?.maxBytes !== undefined && bytes.byteLength > opts.maxBytes) {
        throw new Error('Blob too large');
      }
      if (opts?.expectedSha256 !== undefined && opts.expectedSha256 !== (await sha256Hex(bytes))) {
        throw new Error('Download integrity check failed');
      }
      return bytes;
    },
  };
  return { svc: svc as unknown as BlossomService, store };
}

describe('blossom blob transport', () => {
  it('round-trips: seed encrypts to recipient, fetch decrypts', async () => {
    const sender = ElisymIdentity.generate();
    const recipient = ElisymIdentity.generate();
    const { svc } = fakeBlossom();
    const senderT = createBlossomTransport({ blossom: svc, identity: sender });
    const recipientT = createBlossomTransport({ blossom: svc, identity: recipient });

    const plaintext = new TextEncoder().encode('blossom job file');
    const transport = await senderT.seedBytes({
      bytes: plaintext,
      recipientPubkey: recipient.publicKey,
    });
    expect(transport.kind).toBe('blossom');
    expect(transport.url).toContain('files.elisym.network');
    expect(transport.enc.alg).toBe('AES-256-GCM');

    const got = await recipientT.fetchToBytes({ transport, senderPubkey: sender.publicKey });
    expect(new TextDecoder().decode(got)).toBe('blossom job file');
  });

  it('rejects seeding bytes over the encrypted cap', async () => {
    const id = ElisymIdentity.generate();
    const { svc } = fakeBlossom();
    const t = createBlossomTransport({ blossom: svc, identity: id });
    // Fake oversized input - seedBytes checks byteLength before touching the bytes.
    const tooBig = { byteLength: LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES + 1 } as unknown as Uint8Array;
    await expect(t.seedBytes({ bytes: tooBig, recipientPubkey: id.publicKey })).rejects.toThrow(
      /too large/i,
    );
  });

  it('refuses a nostr.build fallback descriptor (so the caller stays iroh-only)', async () => {
    const id = ElisymIdentity.generate();
    const { svc } = fakeBlossom('fallback');
    const t = createBlossomTransport({ blossom: svc, identity: id });
    await expect(
      t.seedBytes({ bytes: new TextEncoder().encode('x'), recipientPubkey: id.publicKey }),
    ).rejects.toThrow(/fell back/i);
  });

  it('rejects a download whose ciphertext sha256 no longer matches', async () => {
    const sender = ElisymIdentity.generate();
    const recipient = ElisymIdentity.generate();
    const { svc, store } = fakeBlossom();
    const senderT = createBlossomTransport({ blossom: svc, identity: sender });
    const recipientT = createBlossomTransport({ blossom: svc, identity: recipient });

    const transport = await senderT.seedBytes({
      bytes: new TextEncoder().encode('data'),
      recipientPubkey: recipient.publicKey,
    });
    const stored = store.get(transport.sha256);
    if (stored) {
      stored[0] ^= 0xff; // tamper after seeding
    }
    await expect(
      recipientT.fetchToBytes({ transport, senderPubkey: sender.publicKey }),
    ).rejects.toThrow(/integrity/i);
  });
});
