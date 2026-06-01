/**
 * BlossomService - BUD-11 authenticated blob uploads to a Blossom server.
 *
 * Blossom (https://github.com/hzrd149/blossom) is content-addressed: blobs are stored
 * by sha256 and writes are authorized with a signed Nostr event (BUD-11, kind 24242) -
 * NOT NIP-98 (kind 27235) like MediaService/nostr.build. This service uploads to the
 * self-hosted elisym relay and, if that fails, falls back to an injected uploader (the
 * client wires MediaService/nostr.build in) so uploads stay resilient.
 */
import { finalizeEvent } from 'nostr-tools';
import { DEFAULTS, LIMITS } from '../constants';
import type { ElisymIdentity } from '../primitives/identity';

const KIND_BLOSSOM_AUTH = 24242;
const DEFAULT_BLOSSOM_URL = 'https://files.elisym.network';
const AUTH_TTL_SECS = 600;

/** Result of an upload. */
export interface BlobDescriptor {
  /**
   * Publicly GET-able URL. Content-addressed (https://<host>/<sha256>.<ext>) ONLY when
   * `provider === 'blossom'`; on `'fallback'` it is a provider-assigned nostr.build URL
   * that may NOT be addressed by `sha256` (the host may re-encode the bytes).
   */
  url: string;
  /**
   * Lowercase-hex SHA-256 of the bytes the caller uploaded. On `'blossom'` it is also
   * verified to equal what the server stored (integrity check). On `'fallback'` it is the
   * local hash only - do NOT assume `url` resolves to it.
   */
  sha256: string;
  size: number;
  type: string;
  /** Unix seconds; only the Blossom path returns it. */
  uploaded?: number;
  provider: 'blossom' | 'fallback';
}

/** Fallback uploader invoked when the Blossom upload fails; returns the stored URL. */
export type BlossomUploadFallback = (identity: ElisymIdentity, file: Blob) => Promise<string>;

export class BlossomService {
  constructor(
    private serverUrl: string = DEFAULT_BLOSSOM_URL,
    private fallback?: BlossomUploadFallback,
  ) {}

  /**
   * The content-addressed GET URL for a blob, derivable from its sha256 BEFORE
   * upload (BUD-01: `<serverUrl>/<sha256>`, no extension for our octet-stream
   * ciphertext uploads - same form `delete` addresses by). Lets a caller build a
   * complete attachment descriptor and defer the actual byte upload (the descriptor
   * is submitted first, the bytes PUT later). `upload()` re-verifies the server
   * returns this exact url.
   */
  contentUrl(sha256: string): string {
    return `${this.serverUrl}/${sha256}`;
  }

  /**
   * Upload a file to the Blossom server, returning its descriptor. On any failure, falls
   * back to the configured uploader (if any) and returns a normalized descriptor with
   * `provider: 'fallback'`. Works with browser File objects and Node.js/Bun Blobs.
   */
  async upload(identity: ElisymIdentity, file: Blob): Promise<BlobDescriptor> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > LIMITS.MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${bytes.byteLength} bytes exceeds limit of ${LIMITS.MAX_FILE_SIZE}.`,
      );
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashHex = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    try {
      return await this.uploadToBlossom(identity, bytes, hashHex, file.type);
    } catch (err) {
      if (!this.fallback) {
        throw err;
      }
      const url = await this.fallback(identity, file);
      return {
        url,
        sha256: hashHex,
        size: file.size,
        type: file.type || 'application/octet-stream',
        provider: 'fallback',
      };
    }
  }

  /** Delete a blob by sha256 (BUD-02). Blossom only - there is no fallback for deletes. */
  async delete(identity: ElisymIdentity, sha256: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error('sha256 must be 64 lowercase hex chars.');
    }

    const authHeader = this.authHeader(identity, 'delete', sha256);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULTS.BLOSSOM_UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.serverUrl}/${sha256}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Delete failed: ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Download a content-addressed blob from THIS Blossom server (BUD-01 GET, no auth). Bounds memory
   * on the ACTUAL streamed bytes (never the declared Content-Length) and verifies the sha256 when
   * `expectedSha256` is given. Browser-safe.
   *
   * SSRF guard: `url` typically arrives inside a remote counterparty's encrypted job envelope, so it
   * is untrusted. elisym blobs are content-addressed on the single configured server (`seedBytes`
   * refuses non-content-addressed fallbacks), so a legitimate URL is always `<serverUrl>/<sha256>`.
   * The origin is pinned to `serverUrl` and redirects are refused, so a crafted url (or a 30x from
   * the host) can't coerce a fetch to loopback, cloud-metadata, or internal addresses. Federation
   * across Blossom servers would replace this single-origin pin with an explicit allowlist.
   */
  async download(
    url: string,
    opts: {
      maxBytes?: number;
      timeoutMs?: number;
      expectedSha256?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Uint8Array> {
    if (new URL(url).origin !== new URL(this.serverUrl).origin) {
      throw new Error(`Refusing to download from a non-Blossom origin: ${url}`);
    }
    const maxBytes = opts.maxBytes ?? LIMITS.MAX_FILE_SIZE;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULTS.BLOSSOM_FETCH_TIMEOUT_MS,
    );
    // Abort the in-flight fetch when an external caller signal fires (e.g. job stop() or
    // the runtime's input-fetch budget), alongside the internal timeout above.
    const externalSignal = opts.signal;
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`Blob too large: ${declared} bytes exceeds limit of ${maxBytes}.`);
      }
      if (!res.body) {
        throw new Error('Download response has no body.');
      }

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let chunk = await reader.read();
      while (!chunk.done) {
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Blob exceeds limit of ${maxBytes} bytes.`);
        }
        chunks.push(chunk.value);
        chunk = await reader.read();
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }

      if (opts.expectedSha256 !== undefined) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hashHex = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        if (hashHex !== opts.expectedSha256) {
          throw new Error(
            `Download integrity check failed: got ${hashHex}, expected ${opts.expectedSha256}.`,
          );
        }
      }
      return bytes;
    } finally {
      clearTimeout(timer);
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  private async uploadToBlossom(
    identity: ElisymIdentity,
    bytes: Uint8Array,
    hashHex: string,
    mime: string,
  ): Promise<BlobDescriptor> {
    const contentType = mime || 'application/octet-stream';
    const authHeader = this.authHeader(identity, 'upload', hashHex);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULTS.BLOSSOM_UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.serverUrl}/upload`, {
        method: 'PUT',
        headers: { Authorization: authHeader, 'Content-Type': contentType },
        body: bytes,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      }

      let data: {
        url?: string;
        sha256?: string;
        size?: number;
        type?: string;
        uploaded?: number;
      };
      try {
        data = await res.json();
      } catch {
        throw new Error('Invalid response from Blossom server.');
      }

      if (!data.url || !data.sha256) {
        throw new Error('No descriptor returned from Blossom server.');
      }
      if (data.sha256 !== hashHex) {
        throw new Error(
          `Blossom upload integrity check failed: server returned ${data.sha256}, expected ${hashHex}.`,
        );
      }

      return {
        url: data.url,
        sha256: data.sha256,
        size: data.size ?? bytes.byteLength,
        type: data.type ?? contentType,
        uploaded: data.uploaded,
        provider: 'blossom',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private authHeader(identity: ElisymIdentity, verb: 'upload' | 'delete', sha256: string): string {
    const now = Math.floor(Date.now() / 1000);
    const authEvent = finalizeEvent(
      {
        kind: KIND_BLOSSOM_AUTH,
        created_at: now,
        tags: [
          ['t', verb],
          ['x', sha256],
          ['expiration', String(now + AUTH_TTL_SECS)],
        ],
        content: `${verb} blob via elisym SDK`,
      },
      identity.secretKey,
    );
    // btoa is safe here: a signed Nostr event serializes to pure ASCII (hex ids/keys,
    // integer timestamps, ASCII tag strings and content).
    return 'Nostr ' + btoa(JSON.stringify(authEvent));
  }
}
