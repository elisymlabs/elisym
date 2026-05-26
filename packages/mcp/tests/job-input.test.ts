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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeGitDiff, prepareFileInput, resolveOutputPath } from '../src/job-input.js';

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

describe('prepareFileInput', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-prepfile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // --- MIME classification: every file is seeded via iroh; mime drives delivery
  // (text/plain -> re-inlined to stdin, anything else -> ELISYM_INPUT_FILE). ---

  it('classifies a small valid-UTF-8 text file as text/plain', async () => {
    const p = join(dir, 'small.txt');
    await writeFile(p, 'hello world');
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mime).toBe('text/plain');
    expect(result.name).toBe('small.txt');
    // absPath is the symlink-resolved real path (macOS canonicalizes /var).
    expect(result.absPath).toBe(await realpath(p));
    expect(result.size).toBe('hello world'.length);
  });

  it('classifies a small binary file (fake JPEG header with a NUL) as octet-stream', async () => {
    // The regression test: a small binary file must NOT be treated as inline text.
    const p = join(dir, 'tiny.jpg');
    await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]));
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mime).toBe('application/octet-stream');
  });

  it('classifies invalid UTF-8 (no NUL) as octet-stream (fatal-decode branch)', async () => {
    // 0xff 0xfe is not a valid UTF-8 sequence and contains no NUL.
    const p = join(dir, 'latin1.bin');
    await writeFile(p, Buffer.from([0xff, 0xfe, 0x41, 0x42]));
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mime).toBe('application/octet-stream');
  });

  it('classifies ASCII-with-a-NUL as octet-stream (NUL passes fatal decode, so the explicit check matters)', async () => {
    const p = join(dir, 'has-nul.txt');
    await writeFile(p, Buffer.from([0x68, 0x69, 0x00, 0x62, 0x79, 0x65]));
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mime).toBe('application/octet-stream');
  });

  it('classifies a file over the re-inline ceiling as octet-stream via the no-read fast path', async () => {
    // > MAX_REINLINE_TEXT_BYTES: even pure ASCII is never re-inlined, so it is
    // classed binary without reading the whole file.
    const p = join(dir, 'huge.txt');
    const size = LIMITS.MAX_REINLINE_TEXT_BYTES + 1;
    await writeFile(p, 'a'.repeat(size));
    const result = await prepareFileInput(p, { allowOutsideCwd: true });
    expect(result.mime).toBe('application/octet-stream');
    expect(result.size).toBe(size);
  });

  it('rejects an empty file before seeding (would otherwise be paid for + deliver nothing)', async () => {
    const p = join(dir, 'empty.bin');
    await writeFile(p, '');
    await expect(prepareFileInput(p, { allowOutsideCwd: true })).rejects.toThrow(/empty file/);
  });

  // --- path guards (validateInputPath, formerly exercised via readJobInputFile) ---

  it('rejects a missing file with a path-bearing message', async () => {
    await expect(
      prepareFileInput(join(dir, 'nope.txt'), { allowOutsideCwd: true }),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects a directory path (not a regular file)', async () => {
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await expect(prepareFileInput(sub, { allowOutsideCwd: true })).rejects.toThrow(
      /not a regular file/,
    );
  });

  it('rejects an excessively long path argument before touching the FS', async () => {
    await expect(prepareFileInput('x'.repeat(5000))).rejects.toThrow(/too long/);
  });

  it('refuses a path outside the working directory unless allow_outside_cwd is set', async () => {
    const p = join(dir, 'outside.txt');
    await writeFile(p, 'data');
    await expect(prepareFileInput(p)).rejects.toThrow(/outside the working directory/);
  });

  it('still refuses sensitive files', async () => {
    const secret = join(dir, '.secrets.json');
    await writeFile(secret, '{"nostr_secret_key":"x"}');
    await expect(prepareFileInput(secret, { allowOutsideCwd: true })).rejects.toThrow(
      /sensitive file/,
    );
  });

  it('rejects an in-cwd symlink whose target escapes the working directory', async () => {
    const outsideTarget = join(dir, 'target.txt');
    await writeFile(outsideTarget, 'data');
    const link = join(process.cwd(), `elisym-symlink-test-${Date.now()}.txt`);
    await symlink(outsideTarget, link);
    try {
      await expect(prepareFileInput(link)).rejects.toThrow(/outside the working directory/);
    } finally {
      await rm(link, { force: true });
    }
  });

  it('accepts a file inside the working directory by default', async () => {
    const p = join(process.cwd(), `elisym-prepfile-test-${Date.now()}.txt`);
    await writeFile(p, 'inside cwd');
    try {
      const result = await prepareFileInput(p);
      expect(result.mime).toBe('text/plain');
      expect(result.size).toBe('inside cwd'.length);
    } finally {
      await rm(p, { force: true });
    }
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

  it('refuses a macOS auto-run path (Library/LaunchAgents)', async () => {
    await expect(
      resolveOutputPath(join(process.cwd(), 'Library', 'LaunchAgents', 'evil.plist')),
    ).rejects.toThrow(/sensitive path/);
  });

  it('refuses a systemd unit file by extension (.service)', async () => {
    await expect(resolveOutputPath(join(process.cwd(), 'evil.service'))).rejects.toThrow(
      /sensitive path/,
    );
  });

  it('refuses a system privilege/auto-run file by name (sudoers)', async () => {
    await expect(
      resolveOutputPath(join(tmpdir(), 'sudoers'), { allowOutsideCwd: true }),
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
      // allowOutsideCwd so the path clears the cwd-confinement floor and reaches
      // the git-repo check (the temp dir lives outside the test process cwd).
      await expect(computeGitDiff(notRepo, undefined, { allowOutsideCwd: true })).rejects.toThrow(
        /not inside a git work tree/,
      );
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  it('refuses a repo outside the working directory unless allow_outside_cwd is set', async () => {
    await writeFile(join(repo, 'README.md'), '# changed\n');
    // repo lives in tmpdir (outside the test process cwd); without the opt-in the
    // confinement floor rejects it before any git command runs.
    await expect(computeGitDiff(repo)).rejects.toThrow(/outside the working directory/);
  });

  it('refuses a repo under a sensitive directory even with allow_outside_cwd', async () => {
    const sensitive = join(repo, '.ssh');
    await mkdir(sensitive);
    await expect(computeGitDiff(sensitive, undefined, { allowOutsideCwd: true })).rejects.toThrow(
      /sensitive path/,
    );
  });

  it('accepts the working directory itself (schema default repo_path ".")', async () => {
    // The default repo_path is '.', which resolves to the cwd: relative(cwd, cwd) is '',
    // and that must count as INSIDE the working dir (the common "review the current repo"
    // case), not outside. Spy cwd onto the temp repo so allowOutsideCwd:false is exercised.
    await writeFile(join(repo, 'README.md'), '# changed\n');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    try {
      const result = await computeGitDiff('.');
      expect(result.diff).toMatch(/^diff --git/m);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('returns working-tree diff when tree is dirty (auto-detect)', async () => {
    await writeFile(join(repo, 'README.md'), '# changed\n');
    const result = await computeGitDiff(repo, undefined, { allowOutsideCwd: true });
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
    const result = await computeGitDiff(repo, undefined, { allowOutsideCwd: true });
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

    const result = await computeGitDiff(repo, 'HEAD~1', { allowOutsideCwd: true });
    expect(result.describedRange).toBe('HEAD~1...HEAD');
    expect(result.diff).toMatch(/second\.txt/);
  });

  it('throws on unknown base ref', async () => {
    await expect(
      computeGitDiff(repo, 'nonexistent-ref-xyz', { allowOutsideCwd: true }),
    ).rejects.toThrow(/git diff/);
  });

  it('throws when the diff is empty (clean tree, no diverging branch)', async () => {
    // Clean tree on main, no other branch. main...HEAD is empty.
    await expect(computeGitDiff(repo, undefined, { allowOutsideCwd: true })).rejects.toThrow(
      /No changes/,
    );
  });
});
