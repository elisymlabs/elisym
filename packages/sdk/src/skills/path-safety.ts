import { relative, resolve, sep } from 'node:path';

/**
 * Resolve `value` relative to `rootDir` and reject anything that escapes
 * the root (`..` segments, absolute paths outside it, or the root itself).
 *
 * Returns the absolute path on success, or null on rejection so callers
 * can surface a precise error message.
 */
export function resolveInsidePath(rootDir: string, value: string): string | null {
  const root = resolve(rootDir);
  const candidate = resolve(root, value);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return null;
  }
  return candidate;
}
