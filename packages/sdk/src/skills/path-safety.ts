import { realpathSync } from 'node:fs';
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

/**
 * `resolveInsidePath` plus a symlink-aware re-check: dereference the candidate
 * (and the root) and verify the physical path still stays inside the root.
 * The string check alone lets a symlink planted inside the root pass while
 * pointing at `.secrets.json` or anything else on disk.
 *
 * A candidate that does not exist yet passes through as the string-checked
 * path - there is nothing to dereference, and nothing to leak. Sites that
 * read the file later must run this guard again at read time.
 */
export function resolveInsidePathReal(rootDir: string, value: string): string | null {
  // Anchor the string check on the PHYSICAL root: callers may re-run this
  // guard with an already-dereferenced absolute path (e.g. a read-time
  // re-check), which would spuriously fail against the logical root when the
  // root itself sits behind a symlink (macOS /var -> /private/var).
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(rootDir));
  } catch {
    return null;
  }
  const candidate = resolveInsidePath(realRoot, value);
  if (candidate === null) {
    return null;
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return candidate;
  }
  const rel = relative(realRoot, realCandidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return null;
  }
  return realCandidate;
}
