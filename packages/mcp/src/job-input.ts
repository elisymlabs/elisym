/**
 * Helpers that produce a job `input` string from sources OTHER than the LLM
 * generating it inline in a tool call. Used by the file-handle and git-diff
 * variants of submit_and_pay_job to keep large payloads out of the model's
 * output tokens - the MCP server reads the content itself and forwards it to
 * the provider over Nostr.
 */
import { execFile } from 'node:child_process';
import { realpath, stat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { LIMITS, utf8ByteLength } from '@elisym/sdk';
import { MAX_INPUT_LEN } from './utils.js';

const execFileP = promisify(execFile);

/** Hard ceiling on input file paths so we never call `stat` on a multi-MB string. */
export const MAX_INPUT_PATH_LEN = 4096;

/**
 * Files that are never a legitimate job input and are the prime exfiltration
 * target (threat #1: secret-key / API-key theft). Matched on the resolved path;
 * always refused regardless of the allow-outside-cwd opt-in.
 */
// Secret/key files plus shell-init and other auto-run files (a write target here
// comes from an untrusted provider, so overwriting ~/.zshrc, ~/.gitconfig, etc.
// is a code-execution vector, not just a secret leak). Also blocks system auto-run
// filenames (/etc/crontab, /etc/sudoers, /etc/bash.bashrc) and unit/desktop-entry
// extensions (systemd `.service`, freedesktop `.desktop` autostart entries).
const SENSITIVE_NAME_RE =
  /(^|[/\\])(\.secrets\.json|\.env(\..+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*-keypair\.json|.*\.pem|.*\.key|\.bashrc|\.bash_profile|\.bash_login|\.bash_logout|\.bash_aliases|\.profile|\.zshrc|\.zprofile|\.zshenv|\.zlogin|\.zlogout|config\.fish|\.gitconfig|\.npmrc|\.netrc|crontab|sudoers|bash\.bashrc|.*\.service|.*\.desktop)$/i;
// `.git` blocks the repo-internal config + hooks dir (hooks are auto-run on git ops).
// The remaining segments are OS auto-run / privilege-escalation dirs whose contents
// execute on login or schedule: macOS Launch{Agents,Daemons}, freedesktop autostart,
// systemd unit trees, cron drop-in dirs, sudoers.d, profile.d, and SysV init.d.
const SENSITIVE_DIR_SEGMENTS = new Set([
  '.elisym',
  '.ssh',
  '.aws',
  '.gnupg',
  '.git',
  'launchagents',
  'launchdaemons',
  'autostart',
  'systemd',
  'sudoers.d',
  'cron.d',
  'cron.daily',
  'cron.hourly',
  'cron.weekly',
  'cron.monthly',
  'crontabs',
  'profile.d',
  'init.d',
]);

function isSensitiveInputPath(absPath: string): boolean {
  if (SENSITIVE_NAME_RE.test(absPath)) {
    return true;
  }
  if (absPath === '/proc' || absPath.startsWith('/proc/')) {
    return true;
  }
  const segments = absPath.split(/[/\\]+/);
  return segments.some((segment) => SENSITIVE_DIR_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Resolve and safety-check a destination path for a downloaded job result. The
 * write-side mirror of `validateInputPath`'s guards: the bytes written here come
 * from an untrusted remote provider, so an injected/confused `output_path` must
 * never overwrite a secret or auto-run file (key, .env, ~/.elisym, SSH/cloud
 * credentials, ~/.zshrc, .git/hooks). Writes are confined to the working-directory
 * subtree unless `allowOutsideCwd` is set, and the real parent dir is resolved so a
 * symlink cannot redirect the write past these checks. Relative paths resolve
 * against the MCP server's working directory. Throws a user-facing Error; returns
 * the absolute path to write to.
 */
export async function resolveOutputPath(
  outputPath: string,
  options?: { allowOutsideCwd?: boolean },
): Promise<string> {
  if (outputPath.length > MAX_INPUT_PATH_LEN) {
    throw new Error(
      `output_path too long: ${outputPath.length} chars (max ${MAX_INPUT_PATH_LEN}).`,
    );
  }
  const cwd = resolvePath(process.cwd());
  const logicalPath = isAbsolute(outputPath)
    ? resolvePath(outputPath)
    : resolvePath(cwd, outputPath);
  // The destination usually does not exist yet, so resolve the REAL parent dir and
  // re-join the basename - a symlinked PARENT then cannot redirect the write past
  // the guards below. Falls back to the logical parent when it does not exist yet.
  const realParent = await realpath(dirname(logicalPath)).catch(() => dirname(logicalPath));
  const absPath = resolvePath(realParent, basename(logicalPath));
  // Resolving only the parent leaves a symlink AT the destination itself
  // unresolved (e.g. ./out.bin -> ~/.ssh/authorized_keys): `blobs.export` follows
  // it and would overwrite the link target with untrusted provider bytes. When the
  // destination already exists, resolve its real target so the guards below (and
  // the write itself) operate on it, mirroring the read-side `validateInputPath`.
  const realDest = await realpath(logicalPath).catch(() => undefined);
  const writeTarget = realDest ?? absPath;
  const sensitiveCandidates =
    realDest !== undefined ? [absPath, logicalPath, realDest] : [absPath, logicalPath];

  if (sensitiveCandidates.some((candidate) => isSensitiveInputPath(candidate))) {
    throw new Error(
      `Refusing to write a job result to a sensitive path: ${writeTarget}. ` +
        `Choose a destination outside secret/config/auto-run locations.`,
    );
  }
  if (!options?.allowOutsideCwd) {
    const realCwd = await realpath(cwd).catch(() => cwd);
    const rel = relative(realCwd, writeTarget);
    const insideCwd = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (!insideCwd) {
      throw new Error(
        `output_path "${writeTarget}" resolves outside the working directory (${realCwd}). ` +
          `Choose a destination under the working directory or pass allow_outside_cwd: true.`,
      );
    }
  }
  return writeTarget;
}

/** Wall-clock cap on each `git` invocation. Diffs of in-tree work are sub-second. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Buffer for git stdout. Kept slightly ABOVE the diff ceiling (not equal) so a
 * marginally-oversize diff still buffers and surfaces the friendly size-error
 * below, instead of failing with a confusing ENOBUFS. The ceiling itself bounds
 * the in-memory buffer (a git diff is buffered whole by execFile) against a
 * memory-DoS on an untrusted/huge repo.
 */
const GIT_MAX_BUFFER = LIMITS.MAX_REINLINE_TEXT_BYTES + MAX_INPUT_LEN;

/**
 * Config overrides injected before every git subcommand. git honors a repo-local
 * `.git/config` for the work tree it runs in, and `diff.external` / `core.fsmonitor`
 * / hooks are arbitrary-command-execution vectors - so reviewing an untrusted repo
 * could run attacker code with the MCP server's privileges (in-memory secret keys).
 * These `-c` overrides neutralize those keys; `GIT_CONFIG_NOSYSTEM=1` (set in env)
 * additionally ignores /etc/gitconfig. `safe.directory` does NOT cover this - it only
 * blocks differently-owned repos, not a user-owned malicious clone/tarball. A repo's
 * `textconv` diff driver (mapped via `.gitattributes`) is a further command-execution
 * vector, so every `git diff` invocation also passes `--no-textconv` (alongside
 * `--no-ext-diff`); `git diff` does not run clean/smudge filters.
 */
const GIT_SAFETY_ARGS = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
  '-c',
  'core.hooksPath=/dev/null',
];

/** Strict ref validation for the user-supplied diff `base` (no leading `-`, no `..` ranges). */
function isValidGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 256) {
    return false;
  }
  if (ref.startsWith('-') || ref.includes('..')) {
    return false;
  }
  return /^[A-Za-z0-9._/@~^-]+$/.test(ref);
}

/**
 * Read a job input from a regular file on disk, with size and decoding guards.
 * Relative paths resolve against `process.cwd()` (the MCP server's working dir,
 * which for stdio clients is the dir the client was launched from).
 *
 * Throws a user-facing Error on missing file, non-file path, or oversize content.
 */
export async function readJobInputFile(
  inputPath: string,
  options?: { allowOutsideCwd?: boolean },
): Promise<string> {
  const { absPath, size } = await validateInputPath(inputPath, options);
  if (size > MAX_INPUT_LEN) {
    throw new Error(
      `input_path too large: ${size} bytes (max ${MAX_INPUT_LEN}). ` +
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

/** Shared path validation: length, sensitive-file block, cwd confinement, stat, isFile. */
async function validateInputPath(
  inputPath: string,
  options?: { allowOutsideCwd?: boolean },
): Promise<{ absPath: string; size: number }> {
  if (inputPath.length > MAX_INPUT_PATH_LEN) {
    throw new Error(`input_path too long: ${inputPath.length} chars (max ${MAX_INPUT_PATH_LEN}).`);
  }
  const cwd = resolvePath(process.cwd());
  const logicalPath = isAbsolute(inputPath) ? resolvePath(inputPath) : resolvePath(cwd, inputPath);

  // Resolve symlinks so every guard below runs on the REAL target, not a logical
  // path a symlink could redirect (a benign-looking name -> ~/.ssh/id_rsa, or a
  // symlinked parent dir pointing outside cwd). Without this, the sensitive-file
  // and cwd-confinement checks operate on the link path and a symlink defeats both.
  let absPath: string;
  try {
    absPath = await realpath(logicalPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`input_path does not exist: ${logicalPath}`);
    }
    throw new Error(`Cannot resolve input_path "${logicalPath}": ${(e as Error).message}`);
  }

  // Always refuse known-sensitive files (secret keys, .env, SSH/keypair, ~/.elisym,
  // /proc). This forwards the file to a remote provider before any payment and is
  // invisible in the transcript, so an injected path must never reach a secret.
  // Checked on both the real target and the link path so neither a link to a
  // sensitive file nor a sensitively-named symlink slips through.
  if (isSensitiveInputPath(absPath) || isSensitiveInputPath(logicalPath)) {
    throw new Error(
      `Refusing to read a sensitive file as job input: ${absPath}. ` +
        `Secret keys, .env, SSH/keypair files, ~/.elisym and /proc are blocked.`,
    );
  }
  // By default confine reads to the server's working-directory subtree. Reading
  // elsewhere requires the explicit allow_outside_cwd opt-in (still subject to the
  // sensitive-file block above). Compared on real paths so a symlinked cwd (e.g.
  // macOS /tmp -> /private/tmp) does not false-negative a legitimate in-tree file.
  if (!options?.allowOutsideCwd) {
    const realCwd = await realpath(cwd).catch(() => cwd);
    const rel = relative(realCwd, absPath);
    const insideCwd = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (!insideCwd) {
      throw new Error(
        `input_path "${absPath}" resolves outside the working directory (${realCwd}). ` +
          `Move the file under the working directory or pass allow_outside_cwd: true.`,
      );
    }
  }

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
  return { absPath, size: stats.size };
}

/**
 * Prepare a file job input, applying the same guards as `readJobInputFile`.
 * A file that fits the inline text cap is read and returned for the existing
 * Nostr-text path; a larger file (up to `MAX_FILE_SIZE`) is returned by path for
 * the caller to seed via iroh (so large/binary inputs no longer hit the 100k wall).
 */
export type PreparedFileInput =
  | { mode: 'inline'; content: string }
  | { mode: 'file'; absPath: string; size: number; name: string };

export async function prepareFileInput(
  inputPath: string,
  options?: { allowOutsideCwd?: boolean },
): Promise<PreparedFileInput> {
  const { absPath, size } = await validateInputPath(inputPath, options);
  // Encrypted (targeted) jobs cap inline plaintext at the NIP-44 budget, so the
  // inline cutoff is the encrypted-inline byte limit (mirrors prepareTextInput);
  // larger files spill to iroh. Using MAX_INPUT_LEN here would inline files that
  // then exceed the NIP-44 cap and throw at submit instead of transferring P2P.
  if (size <= LIMITS.MAX_ENCRYPTED_INLINE_BYTES) {
    const content = await readFile(absPath, 'utf-8');
    if (content.length > MAX_INPUT_LEN) {
      throw new Error(
        `input_path content too long after decoding: ${content.length} chars (max ${MAX_INPUT_LEN}).`,
      );
    }
    return { mode: 'inline', content };
  }
  if (size > LIMITS.MAX_FILE_SIZE) {
    throw new Error(
      `input_path too large: ${size} bytes (max ${LIMITS.MAX_FILE_SIZE} for a file transfer).`,
    );
  }
  return { mode: 'file', absPath, size, name: basename(absPath) };
}

/**
 * Run a git subcommand in `repoPath` with a fixed timeout and bounded stdout
 * buffer. `args` is passed directly to `execFile` (no shell), so callers must
 * pass each argument separately - never concatenated into a single string.
 */
async function execGit(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', [...GIT_SAFETY_ARGS, ...args], {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
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
    // Validate the user-supplied ref and place it after `--end-of-options` so a
    // value like `--output=/etc/passwd` can never be parsed as a git flag (#14).
    if (!isValidGitRef(base)) {
      throw new Error(
        `Invalid "base": ${base}. Use a branch/tag/commit ref (letters, digits, ` +
          `". _ / @ ~ ^ -", no leading "-", no "..").`,
      );
    }
    args = ['diff', '--no-ext-diff', '--no-textconv', '--end-of-options', `${base}...HEAD`];
    describedRange = `${base}...HEAD`;
  } else if (await isDirty(absRepo)) {
    args = ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'];
    describedRange = 'HEAD (working tree, uncommitted changes)';
  } else {
    const detected = await detectDefaultBase(absRepo);
    if (detected) {
      args = ['diff', '--no-ext-diff', '--no-textconv', '--end-of-options', `${detected}...HEAD`];
      describedRange = `${detected}...HEAD`;
    } else {
      args = ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'];
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
  const diffBytes = utf8ByteLength(diff);
  if (diffBytes > LIMITS.MAX_REINLINE_TEXT_BYTES) {
    throw new Error(
      `Diff for range ${describedRange} is ${diffBytes} bytes (max ${LIMITS.MAX_REINLINE_TEXT_BYTES}). ` +
        `Pass a narrower "base" or split the review.`,
    );
  }
  return { diff, describedRange };
}
