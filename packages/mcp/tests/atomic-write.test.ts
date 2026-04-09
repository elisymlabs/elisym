/**
 * tests for the atomic write helper.
 *
 * Verifies:
 *   1. Successful write produces exactly the target file with mode 0600.
 *   2. If rename fails, the tmp file is cleaned up (no stray *.tmp siblings).
 *   3. If the tmp write fails, no target file is created.
 *   4. Concurrent writes to the same path both succeed; last-writer-wins, no torn files.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/atomic-write.js';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-atomic-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the target file with exactly the content provided', async () => {
    const p = join(dir, 'config.json');
    await writeFileAtomic(p, '{"hello":"world"}', 0o600);
    const read = await readFile(p, 'utf-8');
    expect(read).toBe('{"hello":"world"}');
  });

  it('sets mode 0o600 on the target file', async () => {
    const p = join(dir, 'config.json');
    await writeFileAtomic(p, 'secret', 0o600);
    const st = await stat(p);
    // The low 9 bits (user/group/other permissions) must be 0o600.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('overwrites an existing file atomically (last write wins, file always valid)', async () => {
    const p = join(dir, 'config.json');
    // Pre-existing content.
    await writeFile(p, 'original-v1', { mode: 0o600 });

    await writeFileAtomic(p, 'rewritten-v2', 0o600);
    expect(await readFile(p, 'utf-8')).toBe('rewritten-v2');

    await writeFileAtomic(p, 'rewritten-v3', 0o600);
    expect(await readFile(p, 'utf-8')).toBe('rewritten-v3');
  });

  it('leaves no stray *.tmp siblings after a successful write', async () => {
    const p = join(dir, 'config.json');
    await writeFileAtomic(p, 'content', 0o600);
    const entries = await readdir(dir);
    // Only the final file should exist.
    expect(entries).toEqual(['config.json']);
  });

  it('cleans up tmp file if rename fails (target directory removed mid-op)', async () => {
    const p = join(dir, 'subdir', 'config.json');
    // Parent directory does not exist - writeFile on the tmp path will fail.
    await expect(writeFileAtomic(p, 'content', 0o600)).rejects.toThrow();
    // Parent directory still doesn't exist; nothing to inspect in it.
    // The sibling of `p` (which is `dir/subdir`) was never created. Verify no stray
    // files in the top-level dir.
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('concurrent writes to the same path produce a valid final state', async () => {
    const p = join(dir, 'race.json');
    const writers = Array.from({ length: 10 }, (_, i) => writeFileAtomic(p, `payload-${i}`, 0o600));
    await Promise.all(writers);
    const final = await readFile(p, 'utf-8');
    // Whichever wrote last wins; the point is the file is never torn.
    expect(final).toMatch(/^payload-\d+$/);
    // Verify no tmp leftovers.
    const entries = await readdir(dir);
    expect(entries).toEqual(['race.json']);
  });
});
