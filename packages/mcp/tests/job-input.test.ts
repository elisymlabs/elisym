/**
 * Tests for the job-input helpers used by the file-handle and git-diff
 * variants of submit_and_pay_job. These helpers run inside the MCP server
 * (no LLM in the loop), so the contract is that any user-facing failure
 * mode produces a clean Error message instead of a low-level fs/git error.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeGitDiff, readJobInputFile } from '../src/job-input.js';

const execFileP = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'elisym-jobinput-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), '# initial\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

describe('readJobInputFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-readinput-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a regular file as utf-8', async () => {
    const p = join(dir, 'in.txt');
    await writeFile(p, 'hello world');
    expect(await readJobInputFile(p)).toBe('hello world');
  });

  it('rejects a missing file with a path-bearing message', async () => {
    const p = join(dir, 'does-not-exist.txt');
    await expect(readJobInputFile(p)).rejects.toThrow(/does not exist/);
  });

  it('rejects a directory path (not a regular file)', async () => {
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await expect(readJobInputFile(sub)).rejects.toThrow(/not a regular file/);
  });

  it('rejects oversize content via stat()', async () => {
    const p = join(dir, 'big.txt');
    // 1 byte over the 100_000 limit.
    await writeFile(p, 'a'.repeat(100_001));
    await expect(readJobInputFile(p)).rejects.toThrow(/too large/);
  });

  it('rejects an excessively long path argument before touching the FS', async () => {
    // Construct a path string longer than MAX_INPUT_PATH_LEN (4096).
    const huge = 'x'.repeat(5000);
    await expect(readJobInputFile(huge)).rejects.toThrow(/too long/);
  });
});

describe('computeGitDiff', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('rejects a non-git path with a clean message', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'elisym-notrepo-'));
    try {
      await expect(computeGitDiff(notRepo)).rejects.toThrow(/not inside a git work tree/);
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  it('returns working-tree diff when tree is dirty (auto-detect)', async () => {
    await writeFile(join(repo, 'README.md'), '# changed\n');
    const result = await computeGitDiff(repo);
    expect(result.describedRange).toMatch(/working tree/);
    expect(result.diff).toMatch(/^diff --git/m);
    expect(result.diff).toMatch(/-# initial/);
    expect(result.diff).toMatch(/\+# changed/);
  });

  it('uses main...HEAD when the tree is clean and a feature branch is checked out', async () => {
    await git(repo, ['checkout', '-q', '-b', 'feature']);
    await writeFile(join(repo, 'feature.txt'), 'new file\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'feature commit']);
    const result = await computeGitDiff(repo);
    expect(result.describedRange).toBe('main...HEAD');
    expect(result.diff).toMatch(/feature\.txt/);
    expect(result.diff).toMatch(/\+new file/);
  });

  it('honors an explicit base ref over auto-detect', async () => {
    // Make a second commit on main; explicit base=HEAD~1 should produce a diff
    // even though the tree is clean.
    await writeFile(join(repo, 'second.txt'), 'second\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'second']);

    const result = await computeGitDiff(repo, 'HEAD~1');
    expect(result.describedRange).toBe('HEAD~1...HEAD');
    expect(result.diff).toMatch(/second\.txt/);
  });

  it('throws on unknown base ref', async () => {
    await expect(computeGitDiff(repo, 'nonexistent-ref-xyz')).rejects.toThrow(/git diff/);
  });

  it('throws when the diff is empty (clean tree, no diverging branch)', async () => {
    // Clean tree on main, no other branch. main...HEAD is empty.
    await expect(computeGitDiff(repo)).rejects.toThrow(/No changes/);
  });
});
