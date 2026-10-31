import { describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../../src/cloud/lib/download';

describe('the key file download', () => {
  it('clicks a download link for the text; the object URL is revoked only after the click returns', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:console/1');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicks: { download: string; href: string; rel: string; revokedYet: number }[] = [];
    const onClick = (event: Event) => {
      const link = event.target;
      if (link instanceof HTMLAnchorElement) {
        clicks.push({
          download: link.download,
          href: link.href,
          rel: link.rel,
          revokedYet: revoked.mock.calls.length,
        });
        event.preventDefault();
      }
    };
    document.addEventListener('click', onClick);
    try {
      downloadFile(document, 'nsec1secret\n', 'owner.txt');
      expect(clicks).toEqual([
        { download: 'owner.txt', href: 'blob:console/1', rel: 'noopener', revokedYet: 0 },
      ]);
      const blob = created.mock.calls[0]?.[0];
      expect(blob instanceof Blob ? await blob.text() : undefined).toBe('nsec1secret\n');
      expect(blob instanceof Blob ? blob.type : undefined).toBe('text/plain');
      // The link is gone; the URL still lives until the click has been handled.
      expect(document.querySelector('a')).toBeNull();
      expect(revoked).toHaveBeenCalledTimes(0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(revoked.mock.calls).toEqual([['blob:console/1']]);
    } finally {
      document.removeEventListener('click', onClick);
      created.mockRestore();
      revoked.mockRestore();
    }
  });

  it('saves bytes as they are, typed as a binary file', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:console/2');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const onClick = (event: Event) => event.preventDefault();
    document.addEventListener('click', onClick);
    try {
      const bytes = new Uint8Array([0x1f, 0x8b, 0xff, 0x00]);
      downloadFile(document, bytes, 'store-handover.tar.gz');
      const blob = created.mock.calls[0]?.[0];
      expect(blob instanceof Blob ? blob.type : undefined).toBe('application/octet-stream');
      expect(blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : undefined).toEqual(
        bytes,
      );
    } finally {
      document.removeEventListener('click', onClick);
      created.mockRestore();
      revoked.mockRestore();
    }
  });
});
