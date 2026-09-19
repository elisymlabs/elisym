import { extname } from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/** Best-effort MIME for a file path's extension; used as the upload Content-Type. */
export function mimeFromPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** The extensions an agent's picture, banner or skill image may carry. */
export const IMAGE_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXT);

/**
 * Whether a path names an image by its extension.
 *
 * An ALLOWLIST, and deliberately not a denylist of sensitive names. What this
 * gates is a file being read off the operator's disk and published to a public
 * media host, so the question worth asking is "is this a picture" - a list of
 * names that must never go up is a list somebody has to keep complete, and the
 * file it would have to name first, `.secrets.json`, sits in the very directory
 * these paths are confined to.
 */
export function isImagePath(path: string): boolean {
  return Object.hasOwn(MIME_BY_EXT, extname(path).toLowerCase());
}
