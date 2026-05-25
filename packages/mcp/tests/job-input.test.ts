/**
 * Tests for the job-input helpers used by the file-handle and git-diff
 * variants of submit_and_pay_job. These helpers run inside the MCP server
 * (no LLM in the loop), so the contract is that any user-facing failure
 * mode produces a clean Error message instead of a low-level fs/git error.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { LIMITS } from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeGitDiff,
  prepareFileInput,
  readJobInputFile,
  resolveOutputPath,
} from '../src/job-input.js';

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

  // The temp files live outside the package cwd, so pass allowOutsideCwd to
  // exercise the underlying read behavior; confinement is covered separately below.
  it('reads a regular file as utf-8', async () => {
    const p = join(dir, 'in.txt');
    await writeFile(p, 'hello world');
    expect(await readJobInputFile(p, { allowOutsideCwd: true })).toBe('hello world');
  });

  it('rejects a missing file with a path-bearing message', async () => {
    const p = join(dir, 'does-not-exist.txt');
    await expect(readJobInputFile(p, { allowOutsideCwd: true })).rejects.toThrow(/does not exist/);
  });

  it('rejects a directory path (not a regular file)', async () => {
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await expect(readJobInputFile(sub, { allowOutsideCwd: true })).rejects.toThrow(
      /not a regular file/,
    );
  });

  it('rejects oversize content via stat()', async () => {
    const p = join(dir, 'big.txt');
    // 1 byte over the 100_000 limit.
    await writeFile(p, 'a'.repeat(100_001));
    await expect(readJobInputFile(p, { allowOutsideCwd: true })).rejects.toThrow(/too large/);
  });

  it('rejects an excessively long path argument before touching the FS', async () => {
    // Construct a path string longer than MAX_INPUT_PATH_LEN (4096).
    const huge = 'x'.repeat(5000);
    await expect(readJobInputFile(huge)).rejects.toThrow(/too long/);
  });

  it('refuses a path outside the working directory unless allow_outside_cwd is set', async () => {
    const p = join(dir, 'outside.txt');
    await writeFile(p, 'data');
    // Default: confined to cwd subtree (the temp dir is outside it).
    await expect(readJobInputFile(p)).rejects.toThrow(/outside the working directory/);
  });

  it('always refuses sensitive files even with allow_outside_cwd', async () => {
    const secret = join(dir, '.secrets.json');
    await writeFile(secret, '{"nostr_secret_key":"x"}');
    await expect(readJobInputFile(secret, { allowOutsideCwd: true })).rejects.toThrow(
      /sensitive file/,
    );
  });

  it('reads a file inside the working directory by default', async () => {
    // A file under process.cwd() is allowed without the opt-in.
    const p = join(process.cwd(), `elisym-jobinput-test-${Date.now()}.txt`);
    await writeFile(p, 'inside cwd');
    try {
      expect(await readJobInputFile(p)).toBe('inside cwd');
    } finally {
      await rm(p, { force: true });
    }
  });

  it('rejects an in-cwd symlink whose target escapes the working directory', async () => {
    // The link sits inside cwd (so the logical-path confinement check would pass),
    // but realpath resolves it to a file outside cwd - which must be refused.
    const outsideTarget = join(dir, 'target.txt');
    await writeFile(outsideTarget, 'data');
    const link = join(process.cwd(), `elisym-symlink-test-${Date.now()}.txt`);
    await symlink(outsideTarget, link);
    try {
      await expect(readJobInputFile(link)).rejects.toThrow(/outside the working directory/);
    } finally {
      await rm(link, { force: true });
    }
  });
});

describe('prepareFileInput', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-prepfile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns inline mode + content for a file within the inline limit', async () => {
    const p = join(dir, 'small.txt');
    await writeFile(p, 'hello world');
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mode).toBe('inline');
    if (result.mode === 'inline') {
      expect(result.content).toBe('hello world');
    }
  });

  it('returns file mode + path for a file over the inline limit (seeded via iroh)', async () => {
    const p = join(dir, 'big.bin');
    await writeFile(p, 'a'.repeat(150_000)); // > MAX_INPUT_LEN (100_000)
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mode).toBe('file');
    if (result.mode === 'file') {
      // absPath is the symlink-resolved real path (macOS canonicalizes /var).
      expect(result.absPath).toBe(await realpath(p));
      expect(result.size).toBe(150_000);
      expect(result.name).toBe('big.bin');
    }
  });

  it('spills a file over the encrypted-inline budget but under MAX_INPUT_LEN (targeted jobs are NIP-44 capped)', async () => {
    // 70k bytes: > MAX_ENCRYPTED_INLINE_BYTES (60k) but < MAX_INPUT_LEN (100k).
    // Must be file mode (seeded via iroh): inlining it would exceed the NIP-44
    // 65_535-byte plaintext cap and throw at submit instead of transferring P2P.
    const p = join(dir, 'midsize.bin');
    const size = LIMITS.MAX_ENCRYPTED_INLINE_BYTES + 10_000;
    await writeFile(p, 'a'.repeat(size));
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mode).toBe('file');
    if (result.mode === 'file') {
      expect(result.size).toBe(size);
    }
  });

  it('still refuses sensitive files', async () => {
    const secret = join(dir, '.secrets.json');
    await writeFile(secret, '{"nostr_secret_key":"x"}');
    await expect(prepareFileInput(secret, { allowOutsideCwd: true })).rejects.toThrow(
      /sensitive file/,
    );
  });
});

describe('resolveOutputPath', () => {
  it('returns the absolute path for an in-cwd destination', async () => {
    // Parent dir does not exist, so realpath falls back to the logical path - the
    // returned value is deterministic (no /var -> /private/var canonicalization).
    const abs = join(process.cwd(), 'elisym-out-test', 'result-out.bin');
    expect(await resolveOutputPath(abs)).toBe(abs);
  });

  it('resolves a relative destination against the working directory', async () => {
    expect(await resolveOutputPath('out/result.bin')).toBe(
      resolvePath(process.cwd(), 'out/result.bin'),
    );
  });

  it('confines writes to cwd by default, allowing outside only with the opt-in', async () => {
    const outside = join(tmpdir(), `elisym-out-${Date.now()}.bin`);
    await expect(resolveOutputPath(outside)).rejects.toThrow(/outside the working directory/);
    const resolved = await resolveOutputPath(outside, { allowOutsideCwd: true });
    expect(resolved.endsWith('.bin')).toBe(true);
  });

  it('refuses a secret-like filename (.secrets.json)', async () => {
    await expect(resolveOutputPath(join(tmpdir(), '.secrets.json'))).rejects.toThrow(
      /sensitive path/,
    );
  });

  it('refuses an auto-run file (.zshrc) even inside cwd', async () => {
    await expect(resolveOutputPath(join(process.cwd(), '.zshrc'))).rejects.toThrow(
      /sensitive path/,
    );
  });

  it('refuses a path inside the git dir (hooks are auto-run)', async () => {
    await expect(
      resolveOutputPath(join(process.cwd(), '.git', 'hooks', 'pre-commit')),
    ).rejects.toThrow(/sensitive path/);
  });

  it('refuses a path inside a sensitive directory (.ssh)', async () => {
    await expect(resolveOutputPath(join(tmpdir(), '.ssh', 'authorized_keys'))).rejects.toThrow(
      /sensitive path/,
    );
  });

  it('refuses a path inside the agent store (.elisym)', async () => {
    await expect(resolveOutputPath(join(tmpdir(), '.elisym', 'agent', 'out.bin'))).rejects.toThrow(
      /sensitive path/,
    );
  });

  it('rejects an in-cwd destination symlink whose target escapes the working directory', async () => {
    // The link sits inside cwd (so the logical-path confinement check passes), but
    // its target is outside cwd: blobs.export would follow the link and overwrite
    // the out-of-tree target, so resolveOutputPath must resolve and refuse it.
    const outsideDir = await mkdtemp(join(tmpdir(), 'elisym-out-link-'));
    const outsideTarget = join(outsideDir, 'target.bin');
    await writeFile(outsideTarget, 'data');
    const link = join(process.cwd(), `elisym-out-symlink-${Date.now()}.bin`);
    await symlink(outsideTarget, link);
    try {
      await expect(resolveOutputPath(link)).rejects.toThrow(/outside the working directory/);
    } finally {
      await rm(link, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
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
