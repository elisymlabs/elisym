import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE = process.cwd();
const PAGES = ['index.html', 'privacy.html', 'terms-of-service.html'];
const IMAGE_URL = 'https://askr.elisym.network/og-image.jpg';
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function metaContent(
  html: string,
  attribute: 'property' | 'name',
  key: string,
): string | undefined {
  const pattern = new RegExp(
    `<meta\\s+${attribute}="${key.replace(/\./g, '\\.')}"\\s+content="([^"]*)"\\s*/>`,
    'u',
  );
  return pattern.exec(html)?.[1];
}

/** Width and height from a JPEG's start-of-frame segment. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error(`not a JPEG segment at ${offset}`);
    }
    const marker = bytes[offset + 1] ?? 0;
    const length = bytes.readUInt16BE(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('no start-of-frame segment');
}

describe('the share image', () => {
  it.each(PAGES)('%s names the large share image for Open Graph and X', (page) => {
    const html = readFileSync(join(PACKAGE, page), 'utf8');
    expect(metaContent(html, 'property', 'og:image')).toBe(IMAGE_URL);
    expect(metaContent(html, 'property', 'og:image:type')).toBe('image/jpeg');
    expect(metaContent(html, 'property', 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
    expect(metaContent(html, 'property', 'og:image:alt')).toMatch(/AI shopping assistant/u);
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'name', 'twitter:site')).toBe('@elisymlabs');
    expect(metaContent(html, 'name', 'twitter:image')).toBe(IMAGE_URL);
    expect(metaContent(html, 'name', 'twitter:image:alt')).toBe(
      metaContent(html, 'property', 'og:image:alt'),
    );
  });

  it('ships the image the tags name, at the size they state', () => {
    const bytes = readFileSync(join(PACKAGE, 'public', 'og-image.jpg'));
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(bytes)).toEqual({ width: 1200, height: 630 });
  });
});
