/**
 * Media cache: maps local image paths to uploaded URLs + sha256.
 * On each start, the CLI hashes the file and skips re-upload if the hash matches.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { agentPaths } from './paths';
import { MediaCacheSchema, type MediaCache, type MediaCacheEntry } from './schema';
import { writeFileAtomic } from './writer';

/** Read .media-cache.json. Returns empty object if missing or corrupt. */
export async function readMediaCache(agentDir: string): Promise<MediaCache> {
  const path = agentPaths(agentDir).mediaCache;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    const result = MediaCacheSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

export async function writeMediaCache(agentDir: string, cache: MediaCache): Promise<void> {
  const path = agentPaths(agentDir).mediaCache;
  const body = JSON.stringify(cache, null, 2) + '\n';
  await writeFileAtomic(path, body, 0o600);
}

/** Compute sha256 hex of a file's contents. */
export async function hashFile(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Look up a cached URL for a local file path. Returns the cached URL if
 * the file's current hash matches the cache entry; otherwise null.
 */
export async function lookupCachedUrl(
  cache: MediaCache,
  relativePath: string,
  absolutePath: string,
): Promise<string | null> {
  const entry = cache[relativePath];
  if (!entry) {
    return null;
  }
  let hash: string;
  try {
    hash = await hashFile(absolutePath);
  } catch {
    return null;
  }
  return hash === entry.sha256 ? entry.url : null;
}

export function newCacheEntry(url: string, sha256: string): MediaCacheEntry {
  return { url, sha256, uploaded_at: new Date().toISOString() };
}
