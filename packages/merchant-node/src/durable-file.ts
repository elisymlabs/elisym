import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Replace `path` with `text` atomically and durably: a temporary file next to
 * it (same directory, so the rename stays on one file system), `0600`,
 * flushed, renamed over, and the rename flushed too. A crash, even a power
 * loss, leaves the old file or the new one, never half of either.
 */
export function replaceFileDurably(path: string, temporary: string, text: string): void {
  // A temporary file left by a failed write never survives, whether this write
  // fails (removed below) or an earlier one did.
  rmSync(temporary, { force: true });
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      // Writes until every byte is written, or throws: one `writeSync` may write
      // part of it on a nearly full disk, and the rename would then keep half a file.
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // A platform that cannot sync a directory (Windows) skips it: the file is
  // already replaced, and failing now would say otherwise.
  if (process.platform === 'win32') {
    return;
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
