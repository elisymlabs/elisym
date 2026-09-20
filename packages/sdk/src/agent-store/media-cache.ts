/**
 * Media cache: maps local image paths to uploaded URLs + sha256.
 * On each start, the CLI hashes the file and skips re-upload if the hash matches.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isBlockingNode } from './node-type';
import { agentPaths } from './paths';
import { MediaCacheSchema, type MediaCache, type MediaCacheEntry } from './schema';
import { writeFileAtomic } from './writer';

/** Read .media-cache.json. Returns empty object if missing or corrupt. */
export async function readMediaCache(agentDir: string): Promise<MediaCache> {
  const path = agentPaths(agentDir).mediaCache;
  // Same answer as an absent or corrupt cache, which is what this function
  // promises - and the only safe one: a FIFO here never settles the read, so
  // the `catch` below would never run and a libuv worker would be gone for the
  // life of the process.
  //
  // Read only. `writeMediaCache` will happily rename a regular file over such a
  // node the next time anything is cached, and that is deliberate: this file
  // belongs to the agent, unlike the `.gitignore` of a shared `.elisym` root,
  // which the writer leaves exactly as it found it.
  if (await isBlockingNode(path)) {
    return {};
  }
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

/**
 * Compute sha256 hex of a file's contents.
 *
 * THROWS on a path that is a pipe, socket or device, as well as on the ordinary
 * read errors: a blocking node never settles the read, so refusing is the only
 * answer that returns. `lookupCachedUrl` turns that into "not cached", which is
 * what an unreadable file already gets.
 */
export async function hashFile(filePath: string): Promise<string> {
  // The path comes from `elisym.yaml` (a picture, a banner), which nobody
  // validates as a node type. `lookupCachedUrl` turns this throw into "not
  // cached", which is the same answer an unreadable file already gets.
  if (await isBlockingNode(filePath)) {
    throw new Error(`Refusing to read ${filePath}: it is a pipe, socket or device, not a file`);
  }
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
