/**
 * `writeFileAtomic` must take its temporary with it when the write itself
 * fails, not only when the rename does.
 *
 * Everything private an agent owns goes through this function - the keys, the
 * job ledger, the media cache, the customer history - and the temporary is
 * `${path}.tmp.${hex}`. The name is random, so nothing ever reuses or sweeps
 * it: a fragment left behind is left behind for good, and for `.secrets.json`
 * that fragment is the agent's key material sitting next to the file that is
 * supposed to hold it.
 *
 * Lives in its own file because it mocks `node:fs/promises`, the same shape as
 * `settlement-store-write-atomicity.test.ts`. A failure BETWEEN the write and
 * the rename is what the cleanup is for, and no healthy filesystem produces
 * one on demand.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make the WRITE fail once it has already created the temporary. */
let writeFailure: Error | null = null;
/** Bytes the failing write actually put down, and the bytes it was asked for. */
let partialBytes = 0;
let fullBytes = 0;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises');
  return {
    ...actual,
    default: actual,
    writeFile: async (path: string, data: string | Buffer, options?: unknown) => {
      if (writeFailure) {
        // A full disk leaves what it managed to put down, so the lever does the
        // same: half the bytes, then the error. Writing the WHOLE file and then
        // throwing would make FRAGMENT below untrue and the assertion weaker
        // than it reads.
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        const partial = text.slice(0, Math.floor(text.length / 2));
        fullBytes = text.length;
        partialBytes = partial.length;
        await actual.writeFile(path, partial, options as Parameters<typeof actual.writeFile>[2]);
        throw writeFailure;
      }
      return actual.writeFile(path, data, options as Parameters<typeof actual.writeFile>[2]);
    },
  };
});

const { writeFileAtomic } = await import('../src/agent-store/writer');

let dir: string;

beforeEach(() => {
  writeFailure = null;
  partialBytes = 0;
  fullBytes = 0;
  dir = mkdtempSync(join(tmpdir(), 'elisym-atomic-write-'));
});

afterEach(() => {
  writeFailure = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('a write that fails part way through', () => {
  it('leaves no half-written temporary holding the secrets', async () => {
    const target = join(dir, '.secrets.json');
    writeFailure = new Error('ENOSPC: no space left on device, write');

    await expect(
      writeFileAtomic(target, JSON.stringify({ nostr_secret_key: 'a'.repeat(64) }), 0o600),
    ).rejects.toThrow(/ENOSPC/);

    // The lever really did leave a FRAGMENT rather than a whole file the
    // cleanup then tidied away: without these two the word above goes quietly
    // untrue the next time somebody edits the mock.
    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(fullBytes);
    expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('writes nothing at the target path either', async () => {
    // The caller is told the write failed, and "failed" has to mean the old
    // contents are intact - `writeSecrets` has no rollback of its own.
    const target = join(dir, '.secrets.json');
    await writeFileAtomic(target, 'first', 0o600);

    writeFailure = new Error('EIO: i/o error, write');
    await expect(writeFileAtomic(target, 'second', 0o600)).rejects.toThrow(/EIO/);

    // The CONTENTS, not just the listing: a version of this that wrote straight
    // to the target passes the directory check in both worlds, and the lever
    // puts half the bytes down - so what is left at `.secrets.json` would be
    // half of the new keys and none of the old ones. Measured; the listing
    // assertion alone did not catch it.
    expect(readFileSync(target, 'utf-8')).toBe('first');
    expect(readdirSync(dir)).toEqual(['.secrets.json']);
  });
});
