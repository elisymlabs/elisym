/**
 * Atomic file write helper.
 *
 * Node's default `writeFile(path, data)` opens the target file, truncates it, then
 * writes bytes. A crash, SIGKILL, or power loss between open and final write leaves the
 * file half-written (or empty) - unacceptable for config files that hold the only copy
 * of an agent's secret keys.
 *
 * `writeFileAtomic` writes to a sibling temp file in the same directory, then
 * `rename`s over the target. POSIX guarantees rename atomicity within a single
 * filesystem, so readers see either the old file or the new file, never a torn one.
 *
 * The temp file is created with the final mode (not 0644), so the 0600 permission
 * applies from the first byte on disk. On rename failure the temp file is removed.
 */
import { writeFile, rename, unlink } from 'node:fs/promises';

export async function writeFileAtomic(
  path: string,
  content: string,
  mode: number = 0o600,
): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmpPath, content, { mode });
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup - if tmp was never created, unlink will throw ENOENT which we ignore.
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
