/**
 * Helpers that produce a job `input` string from sources OTHER than the LLM
 * generating it inline in a tool call. Used by the file-handle and git-diff
 * variants of submit_and_pay_job to keep large payloads out of the model's
 * output tokens - the MCP server reads the content itself and forwards it to
 * the provider over Nostr.
 */
import { execFile } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { MAX_INPUT_LEN } from './utils.js';

const execFileP = promisify(execFile);

/** Hard ceiling on input file paths so we never call `stat` on a multi-MB string. */
export const MAX_INPUT_PATH_LEN = 4096;

/** Wall-clock cap on each `git` invocation. Diffs of in-tree work are sub-second. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Buffer for git stdout. Slightly larger than MAX_INPUT_LEN so an oversize
 * diff is still readable for the size-error message instead of failing with
 * a confusing ENOBUFS.
 */
const GIT_MAX_BUFFER = MAX_INPUT_LEN * 2;

/**
 * Read a job input from a regular file on disk, with size and decoding guards.
 * Relative paths resolve against `process.cwd()` (the MCP server's working dir,
 * which for stdio clients is the dir the client was launched from).
 *
 * Throws a user-facing Error on missing file, non-file path, or oversize content.
 */
export async function readJobInputFile(inputPath: string): Promise<string> {
  if (inputPath.length > MAX_INPUT_PATH_LEN) {
    throw new Error(`input_path too long: ${inputPath.length} chars (max ${MAX_INPUT_PATH_LEN}).`);
  }
  const absPath = isAbsolute(inputPath) ? inputPath : resolvePath(process.cwd(), inputPath);

  let stats;
  try {
    stats = await stat(absPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`input_path does not exist: ${absPath}`);
    }
    throw new Error(`Cannot stat input_path "${absPath}": ${(e as Error).message}`);
  }

  if (!stats.isFile()) {
    throw new Error(`input_path is not a regular file: ${absPath}`);
  }
  if (stats.size > MAX_INPUT_LEN) {
    throw new Error(
      `input_path too large: ${stats.size} bytes (max ${MAX_INPUT_LEN}). ` +
        `Trim the file or split the job.`,
    );
  }

  const content = await readFile(absPath, 'utf-8');
  if (content.length > MAX_INPUT_LEN) {
    // utf-8 multi-byte chars can push the decoded length past the byte size check.
    throw new Error(
      `input_path content too long after decoding: ${content.length} chars ` +
        `(max ${MAX_INPUT_LEN}).`,
    );
  }
  return content;
}

/**
 * Run a git subcommand in `repoPath` with a fixed timeout and bounded stdout
 * buffer. `args` is passed directly to `execFile` (no shell), so callers must
 * pass each argument separately - never concatenated into a single string.
 */
async function execGit(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new Error('git executable not found in PATH on the MCP server.');
    }
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(
        `git ${args.join(' ')} output exceeded ${GIT_MAX_BUFFER} bytes; narrow the range.`,
      );
    }
    const stderr = (err.stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

/** Returns true when the working tree has staged or unstaged changes against HEAD. */
async function isDirty(repoPath: string): Promise<boolean> {
  const out = await execGit(repoPath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

/**
 * Best-effort detection of the repo's "main" branch for auto-range selection.
 * Tries (in order): `main`, `master`, then `origin/HEAD`'s symbolic ref. Returns
 * undefined if none resolve - the caller should fall back to a working-tree diff.
 */
async function detectDefaultBase(repoPath: string): Promise<string | undefined> {
  for (const candidate of ['main', 'master']) {
    try {
      await execGit(repoPath, ['rev-parse', '--verify', '--quiet', candidate]);
      return candidate;
    } catch {
      // try next
    }
  }
  try {
    const out = await execGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = out.trim();
    return ref.length > 0 ? ref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify `repoPath` is inside a git work tree. Throws a user-facing error
 * otherwise so callers don't have to interpret raw git error strings.
 */
async function assertGitRepo(repoPath: string): Promise<void> {
  try {
    await execGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`"${repoPath}" is not inside a git work tree: ${message}`);
  }
}

export interface GitDiffResult {
  diff: string;
  /** Human-readable description of the range that was actually diffed. */
  describedRange: string;
}

/**
 * Compute a git diff suitable for a code-review job.
 *
 * If `base` is provided, always diffs `${base}...HEAD` (PR-style merge-base).
 * If `base` is omitted, auto-detects:
 *   - working tree dirty -> `git diff HEAD` (uncommitted changes)
 *   - clean + main/master/origin-HEAD found -> `${detected}...HEAD`
 *   - otherwise -> `git diff HEAD` (still useful when base detection fails)
 *
 * Throws on unknown ref, non-repo path, oversize output, or empty diff.
 */
export async function computeGitDiff(repoPath: string, base?: string): Promise<GitDiffResult> {
  if (repoPath.length > MAX_INPUT_PATH_LEN) {
    throw new Error(`repo_path too long: ${repoPath.length} chars (max ${MAX_INPUT_PATH_LEN}).`);
  }
  const absRepo = isAbsolute(repoPath) ? repoPath : resolvePath(process.cwd(), repoPath);
  await assertGitRepo(absRepo);

  let args: string[];
  let describedRange: string;
  if (base) {
    args = ['diff', `${base}...HEAD`];
    describedRange = `${base}...HEAD`;
  } else if (await isDirty(absRepo)) {
    args = ['diff', 'HEAD'];
    describedRange = 'HEAD (working tree, uncommitted changes)';
  } else {
    const detected = await detectDefaultBase(absRepo);
    if (detected) {
      args = ['diff', `${detected}...HEAD`];
      describedRange = `${detected}...HEAD`;
    } else {
      args = ['diff', 'HEAD'];
      describedRange = 'HEAD (no main/master detected)';
    }
  }

  const diff = await execGit(absRepo, args);
  if (diff.trim().length === 0) {
    throw new Error(
      `No changes in range ${describedRange}. Nothing to review - commit work, ` +
        `pass an explicit "base", or check the repo path.`,
    );
  }
  if (diff.length > MAX_INPUT_LEN) {
    throw new Error(
      `Diff for range ${describedRange} is ${diff.length} chars (max ${MAX_INPUT_LEN}). ` +
        `Pass a narrower "base" or split the review.`,
    );
  }
  return { diff, describedRange };
}
