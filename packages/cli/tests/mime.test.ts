import { describe, it, expect } from 'vitest';
import { mimeFromPath } from '../src/mime';

describe('mimeFromPath', () => {
  it('maps known image extensions', () => {
    expect(mimeFromPath('hero.png')).toBe('image/png');
    expect(mimeFromPath('a.jpg')).toBe('image/jpeg');
    expect(mimeFromPath('a.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('a.gif')).toBe('image/gif');
    expect(mimeFromPath('a.webp')).toBe('image/webp');
    expect(mimeFromPath('a.svg')).toBe('image/svg+xml');
    expect(mimeFromPath('a.avif')).toBe('image/avif');
  });

  it('is case-insensitive and handles full paths', () => {
    expect(mimeFromPath('LOGO.PNG')).toBe('image/png');
    expect(mimeFromPath('/abs/skills/foo/hero.JPEG')).toBe('image/jpeg');
  });

  it('defaults to application/octet-stream for unknown or missing extensions', () => {
    expect(mimeFromPath('file.bin')).toBe('application/octet-stream');
    expect(mimeFromPath('noext')).toBe('application/octet-stream');
    expect(mimeFromPath('archive.tar.zz')).toBe('application/octet-stream');
  });
});
