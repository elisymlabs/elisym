/**
 * `FileSettlementStore.write` must be all-or-nothing.
 *
 * `claim` reports `not-persisted` on the understanding that a failed write left
 * NOTHING on disk - that is what makes a refused claim safe to retry, and what
 * stops a signature from being reported as this job's while the index does not
 * hold it. Swallow the error instead and `claim` answers `claimed` about a
 * record that is not there: the job is delivered, the signature stays free, and
 * the next job settles the same transaction.
 *
 * Lives in its own file because it mocks `node:fs`, the same shape as
 * `packages/cli/tests/ledger-flush-atomicity.test.ts`. Without the mock the
 * locked-directory fixture next door reaches the rethrow and enters the cleanup
 * - but the cleanup has nothing to remove there, so only its EFFECT needs the
 * mock, as does the `prune` asymmetry: both want a failure BETWEEN the write
 * and the rename, which no healthy filesystem produces.
 *
 * And a note for whoever measures reachability next: `process.exit` is not a
 * usable probe here - it is a no-op in vitest's fork pool, measured. Append to
 * a marker file instead.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make `chmodSync` fail, as a full disk or a hostile mode change would. */
let chmodFailure: Error | null = null;
/** Set to make `statSync` throw for a path containing this fragment. */
let statFailureFor: string | null = null;
/** Every path `chmodSync` was asked to change, in order. */
let chmodPaths: string[] = [];
/** Every path written, and every path renamed ONTO, in order. */
let writtenPaths: string[] = [];
let renameTargets: string[] = [];
/**
 * Set to make the WRITE fail after it has created the temporary, as ENOSPC
 * does. A separate lever from the chmod one because they fail at different
 * points: this one leaves a partial file where the chmod one leaves a complete
 * one, and only this one tells whether the write is inside the cleanup.
 */
let writeFailure: Error | null = null;
/** Bytes the failing write actually put down, and the bytes it was asked for. */
let partialBytes = 0;
let fullBytes = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    statSync: (path: string, options?: unknown) => {
      if (statFailureFor !== null && String(path).includes(statFailureFor)) {
        throw new Error('EACCES: permission denied, stat');
      }
      return actual.statSync(path, options as Parameters<typeof actual.statSync>[1]);
    },
    chmodSync: (path: string, mode: number) => {
      chmodPaths.push(String(path));
      if (chmodFailure) {
        throw chmodFailure;
      }
      return actual.chmodSync(path, mode);
    },
    renameSync: (from: string, to: string) => {
      renameTargets.push(String(to));
      return actual.renameSync(from, to);
    },
    writeFileSync: (path: string, data: string, options?: unknown) => {
      writtenPaths.push(String(path));
      if (writeFailure) {
        // A full disk leaves what it managed to put down, so the lever does the
        // same: half the bytes, then the error. Writing the WHOLE file and then
        // throwing would make the word FRAGMENT below untrue - measured, the
        // cleanup was deleting a complete, parseable index. The two counters
        // are what keeps that from happening again silently.
        const partial = data.slice(0, Math.floor(data.length / 2));
        fullBytes = data.length;
        partialBytes = partial.length;
        actual.writeFileSync(
          path as string,
          partial,
          options as Parameters<typeof actual.writeFileSync>[2],
        );
        throw writeFailure;
      }
      return actual.writeFileSync(
        path as string,
        data,
        options as Parameters<typeof actual.writeFileSync>[2],
      );
    },
  };
});

const { createFileSettlementStore } = await import('../src/payment/fileSettlementStore');
const { MIN_SETTLEMENT_RETENTION_MS } = await import('../src/payment/acceptor');

const SIG_A = 'A'.repeat(88);
const SIG_B = 'B'.repeat(88);

let dir: string;
let path: string;

beforeEach(() => {
  chmodFailure = null;
  writeFailure = null;
  partialBytes = 0;
  fullBytes = 0;
  chmodPaths = [];
  statFailureFor = null;
  writtenPaths = [];
  renameTargets = [];
  dir = mkdtempSync(join(tmpdir(), 'elisym-settle-write-'));
  path = join(dir, 'settlements.json');
});

afterEach(() => {
  chmodFailure = null;
  writeFailure = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('a write that fails leaves the settlement index untouched', () => {
  it('answers not-persisted and publishes nothing', () => {
    const store = createFileSettlementStore(path);
    expect(store.claim(SIG_B, 'job-b')).toBe('claimed');
    const before = readFileSync(path, 'utf-8');

    chmodFailure = new Error('EPERM: operation not permitted, chmod');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');

    // The permission step runs on the TEMPORARY, so the rename is the last
    // thing `write` does and cannot be reached once it has failed.
    // `every` is vacuously true on an empty array, so the count comes first.
    expect(chmodPaths.length).toBeGreaterThan(0);
    expect(chmodPaths.every((seen) => seen.includes('.tmp'))).toBe(true);
    expect(chmodPaths).not.toContain(path);
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(store.owner(SIG_A)).toBeUndefined();
    expect(createFileSettlementStore(path).owner(SIG_A)).toBeUndefined();

    // And once the disk recovers, the same job claims it for real.
    chmodFailure = null;
    expect(store.claim(SIG_A, 'job-a')).toBe('claimed');
    expect(createFileSettlementStore(path).owner(SIG_A)).toBe('job-a');
  });

  it('publishes the index by RENAME, never by writing over it', () => {
    // The property the docstring leads with - "`rename` last, so a reader never
    // sees a half-written index" - and the only one in this file that nothing
    // measured: replace the temporary-plus-rename with a direct write to the
    // target and every other row here stays green, because they all watch the
    // chmod, which still lands on a `.tmp` name.
    //
    // A reader here is another process: `claim` is synchronous, but the CLI
    // recovery tick and a second `elisym start` both open this same file.
    const store = createFileSettlementStore(path);
    store.claim(SIG_A, 'job-a');

    expect(writtenPaths.length).toBeGreaterThan(0);
    expect(writtenPaths.every((seen) => seen.includes('.tmp'))).toBe(true);
    expect(writtenPaths).not.toContain(path);
    expect(renameTargets).toContain(path);
  });

  it('gives every write a temporary name of its own', () => {
    // The randomness itself, which the rows below rest on and none of them
    // measured: they plant fragments under names a reader chose, so a build
    // that went back to ONE fixed temporary keeps them all green.
    //
    // What the random half buys, precisely: the name already carries the pid,
    // so two PROCESSES were never going to collide. What randomness adds is
    // that the next name is not guessable - a planted FIFO on it never
    // returns - and that a stranded fragment is never reused, which is what
    // the row below this one rests on.
    const store = createFileSettlementStore(path);
    store.claim(SIG_A, 'job-a');
    store.claim(SIG_B, 'job-b');

    const temporaries = writtenPaths.filter((seen) => seen.includes('.tmp'));
    expect(temporaries.length).toBe(2);
    expect(new Set(temporaries).size).toBe(2);
  });

  it('leaves no temporary behind, because a random name is never reused', () => {
    // With one fixed name the next write reused the leftover and the garbage
    // bounded itself. A random one does not, so every failure between the write
    // and the rename would strand a full copy of the index for good - and it
    // names which transaction paid for which job.
    const store = createFileSettlementStore(path);
    store.claim(SIG_B, 'job-b');

    chmodFailure = new Error('ENOSPC: no space left on device, chmod');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');

    expect(readdirSync(dir)).toEqual(['settlements.json']);
  });

  it('takes a HALF-WRITTEN temporary with it, not only a complete one', () => {
    // The write is inside the cleanup, not only the rename: a disk that fills
    // up part way through leaves a fragment, and that fragment is a partial
    // copy of the index. Measured with its own lever, because the chmod one
    // fails after the file is already whole.
    const store = createFileSettlementStore(path);
    store.claim(SIG_B, 'job-b');

    writeFailure = new Error('ENOSPC: no space left on device, write');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');

    // The lever really did leave a FRAGMENT, not a whole file the cleanup then
    // tidied away: without these two the word above goes quietly untrue again.
    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(fullBytes);
    expect(readdirSync(dir)).toEqual(['settlements.json']);
  });

  it('sweeps a fragment a dead process left, which nothing else would', () => {
    // The fifth member of the "cleanup takes the fragment" class, and the one
    // with no `.gitignore` of ours behind it: the path is the SDK consumer's to
    // choose, and the documented example puts it in a working directory. The
    // `try` in `write` covers a throw; a process killed outright leaves this,
    // and the random suffix means nothing ever reused or removed it.
    const stranded = join(dir, `.${'settlements.json'}.4242.deadbeefcafe.tmp`);
    writeFileSync(stranded, JSON.stringify({ version: 1, settlements: {} }), 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(stranded, stale / 1000, stale / 1000);
    writeFileSync(path, JSON.stringify({ version: 1, settlements: {} }), 'utf-8');
    utimesSync(path, stale / 1000, stale / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toEqual(['settlements.json']);
  });

  it("leaves a fragment alone while it is still fresh enough to be somebody else's", () => {
    // Two writers on one index is unsupported, but the sweep must not be what
    // makes that worse: a temporary written a moment ago may belong to a live
    // writer between its write and its rename.
    const fresh = join(dir, '.settlements.json.4242.feedfacebeef.tmp');
    writeFileSync(fresh, '{}', 'utf-8');

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('.settlements.json.4242.feedfacebeef.tmp');
  });

  it('sweeps a fragment spelled the way THIS writer spells one', () => {
    // The row above writes the name by hand, so the sweep and the writer can
    // drift apart with the file green - measured: respell the temporary in
    // `write` and nothing reddens, while the sweep stops matching anything this
    // class actually produces. This row takes the spelling from production.
    const store = createFileSettlementStore(path);
    expect(store.claim(SIG_B, 'job-b')).toBe('claimed');

    chmodFailure = new Error('EPERM: operation not permitted, chmod');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');
    chmodFailure = null;

    // The cleanup removed it; a process killed outright would not have. Put the
    // SAME path back and age it.
    // The length check is not decoration: `String(undefined)` is the literal
    // 'undefined', and the row would then write a file by that name into the
    // package's working directory and still pass.
    expect(writtenPaths.length).toBeGreaterThan(0);
    const producedTemp = String(writtenPaths.at(-1));
    expect(producedTemp).not.toBe(path);
    // The DIRECTORY too, not only the name. A writer that moved its temporary
    // one level up would leave this row green while the sweep watches a folder
    // the fragment is no longer in - and in production the rename then crosses
    // a mount point, so every claim answers `not-persisted`.
    expect(dirname(producedTemp)).toBe(dir);
    writeFileSync(producedTemp, readFileSync(path, 'utf-8'), 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(producedTemp, stale / 1000, stale / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toEqual(['settlements.json']);
  });

  it('refuses an unreadable index before deleting anything beside it', () => {
    // The order the constructor's comment claims, and it is not cosmetic: the
    // fragment IS the recovery material for an operator whose store just
    // refused to start - a full copy of which transaction paid for which job.
    // Sweep first and the first failed start destroys it.
    const stranded = join(dir, '.settlements.json.4242.deadbeefcafe.tmp');
    writeFileSync(
      stranded,
      JSON.stringify({ version: 1, settlements: { [SIG_A]: { job: 'job-a', at: Date.now() } } }),
      'utf-8',
    );
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(stranded, stale / 1000, stale / 1000);
    writeFileSync(path, '{"version":1,"settlements":{"AAA":{"job":', 'utf-8');

    expect(() => createFileSettlementStore(path)).toThrow();
    expect(readdirSync(dir)).toContain('.settlements.json.4242.deadbeefcafe.tmp');
  });

  it('leaves a file that is not a temporary at all alone', () => {
    // The `.tmp` half of the match, and the name has to reach it: a plain
    // `.settlements.json.bak` is turned away by the pid-and-hex part long
    // before the suffix is consulted, so it would measure the wrong half. This
    // one is shaped exactly like a temporary except for the ending - an
    // operator's copy of one, or an editor's - and the documented path for this
    // index is a working directory, not a private state folder.
    const backup = join(dir, '.settlements.json.4242.deadbeefcafe.bak');
    writeFileSync(backup, '{}', 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(backup, stale / 1000, stale / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('.settlements.json.4242.deadbeefcafe.bak');
  });

  it('leaves a file that merely CONTAINS the temporary shape alone', () => {
    // The match is anchored at both ends. Unanchored, a backup tool's
    // `saved-.settlements.json.4242.deadbeefcafe.tmp` looks like ours and gets
    // deleted - a file this store never wrote and knows nothing about.
    const lookalike = join(dir, 'saved-.settlements.json.4242.deadbeefcafe.tmp');
    writeFileSync(lookalike, '{}', 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(lookalike, stale / 1000, stale / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('saved-.settlements.json.4242.deadbeefcafe.tmp');
  });

  it('keeps sweeping after one fragment it cannot even stat', () => {
    // One unreadable entry must not end the scan: the fragments are
    // independent, and stopping at the first would leave every later one -
    // each a full copy of the index - in place for good.
    // One sweepable fragment on EITHER side of the unreadable one: `readdir`
    // returns entries in whatever order the filesystem likes - lexicographic on
    // APFS, hash order on ext4 - so a single follower would only prove the
    // point on the half of the machines where it happens to come last.
    const before = join(dir, '.settlements.json.0000.aaaaaaaaaaaa.tmp');
    const unreadable = join(dir, '.settlements.json.1111.bbbbbbbbbbbb.tmp');
    const after = join(dir, '.settlements.json.2222.cccccccccccc.tmp');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    for (const name of [before, unreadable, after]) {
      writeFileSync(name, '{}', 'utf-8');
      utimesSync(name, stale / 1000, stale / 1000);
    }
    statFailureFor = '1111';

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('.settlements.json.1111.bbbbbbbbbbbb.tmp');
    expect(readdirSync(dir)).not.toContain('.settlements.json.0000.aaaaaaaaaaaa.tmp');
    expect(readdirSync(dir)).not.toContain('.settlements.json.2222.cccccccccccc.tmp');
  });

  it('starts on a path whose own name is a regular expression', () => {
    // The basename goes into a RegExp and the path is the SDK consumer's to
    // choose - `settlements (1).json` is simply what a duplicate gets called.
    // Unescaped, those parens become a GROUP: this store stops matching its own
    // fragments and starts matching a neighbor's, and an unbalanced one makes
    // `new RegExp` throw out of the constructor, with a message that says
    // nothing about the path.
    const metaPath = join(dir, 'settlements (1).json');
    const own = join(dir, '.settlements (1).json.4242.deadbeefcafe.tmp');
    writeFileSync(own, '{}', 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(own, stale / 1000, stale / 1000);

    expect(() => createFileSettlementStore(metaPath)).not.toThrow();

    expect(readdirSync(dir)).not.toContain('.settlements (1).json.4242.deadbeefcafe.tmp');
  });

  it('keeps the sweep within (30 minutes, 2 hours] of age', () => {
    // The hour itself, pinned from below as well as above: the upper bound is
    // held by the two rows that expect a two-hour-old fragment to go, and
    // without this one the constant could shrink to a second and start taking
    // temporaries a live writer is still renaming.
    const recent = join(dir, '.settlements.json.4242.abcabcabcabc.tmp');
    writeFileSync(recent, '{}', 'utf-8');
    const halfAnHour = Date.now() - 30 * 60 * 1000;
    utimesSync(recent, halfAnHour / 1000, halfAnHour / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('.settlements.json.4242.abcabcabcabc.tmp');
  });

  it('leaves a file that merely EXTENDS the temporary shape alone', () => {
    // The trailing anchor. Without it `.tmp.bak`, `.tmp~` and `.tmp 2` all
    // match - files this store never wrote, each holding a full copy of the
    // index somebody kept on purpose.
    const suffixed = join(dir, '.settlements.json.4242.deadbeefcafe.tmp.bak');
    writeFileSync(suffixed, '{}', 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(suffixed, stale / 1000, stale / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('.settlements.json.4242.deadbeefcafe.tmp.bak');
  });

  it("leaves a SIBLING index's fragment alone, which is why the name is in the prefix", () => {
    // The temporary is named after its target precisely so two stores sharing a
    // directory cannot collide - and a sweep that matched `.tmp` alone would
    // undo that by eating the neighbor's, which may be mid-rename.
    //
    // The neighbour's name CONTAINS this store's basename on purpose: a match
    // written with `includes` instead of `startsWith` would take it, and a
    // fixture whose sibling shares no substring cannot tell the two apart.
    const sibling = join(dir, '.settlements.json.backup.4242.deadbeefcafe.tmp');
    writeFileSync(sibling, '{}', 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(sibling, stale / 1000, stale / 1000);

    createFileSettlementStore(path);

    expect(readdirSync(dir)).toContain('.settlements.json.backup.4242.deadbeefcafe.tmp');
  });

  it('throws out of prune, rather than reporting a sweep that did not land', () => {
    // The asymmetry the interface spells out: `claim` reports a refused write,
    // `prune` throws. A sweep that could not persist has released nothing, and
    // its caller is a schedule rather than a payment.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        settlements: {
          [SIG_A]: { job: 'job-a', at: Date.now() - MIN_SETTLEMENT_RETENTION_MS - 1 },
        },
      }),
      'utf-8',
    );
    const store = createFileSettlementStore(path);

    chmodFailure = new Error('EIO: i/o error, chmod');
    expect(() => store.prune(MIN_SETTLEMENT_RETENTION_MS)).toThrow(/EIO/);
    // Still there: a prune that threw released nothing.
    expect(createFileSettlementStore(path).owner(SIG_A)).toBe('job-a');
  });
});
