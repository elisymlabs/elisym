/**
 * MediaService - NIP-98 authenticated file uploads to nostr.build.
 * Used for avatar, banner, and capability card images.
 */
import { finalizeEvent } from 'nostr-tools';
import type { ElisymIdentity } from '../primitives/identity';

const KIND_HTTP_AUTH = 27235;
const DEFAULT_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

export class MediaService {
  constructor(private uploadUrl: string = DEFAULT_UPLOAD_URL) {}

  /**
   * Upload a file with NIP-98 authentication.
   * Works with browser File objects and Node.js/Bun Blobs.
   *
   * @param identity - Nostr identity used to sign the NIP-98 auth event.
   * @param file - File or Blob to upload.
   * @param filename - Optional filename for the upload (defaults to "upload").
   * @returns URL of the uploaded file.
   */
  async upload(identity: ElisymIdentity, file: Blob, filename?: string): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const hashHex = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const authEvent = finalizeEvent(
      {
        kind: KIND_HTTP_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', this.uploadUrl],
          ['method', 'POST'],
          ['payload', hashHex],
        ],
        content: '',
      },
      identity.secretKey,
    );

    const authHeader = 'Nostr ' + btoa(JSON.stringify(authEvent));

    const formData = new FormData();
    formData.append('file', file, filename ?? 'upload');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(this.uploadUrl, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      }

      let data: { data?: { url?: string }[] };
      try {
        data = await res.json();
      } catch {
        throw new Error('Invalid response from upload service.');
      }
      const url = data?.data?.[0]?.url;
      if (!url) {
        throw new Error('No URL returned from upload service.');
      }
      return url;
    } finally {
      clearTimeout(timer);
    }
  }
}
