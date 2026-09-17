import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRIPT_EXIT_BILLING_EXHAUSTED } from '../llm-health/constants';
import { ScriptBillingExhaustedError, ScriptExecutionError } from '../llm-health/types';
import type { Asset } from '../payment/assets';
import { SCRIPT_REFUSAL_FILE_ENV, throwIfRefused } from './refusal';
import { readRefusalFile } from './refusal-file';
import { runScript, scopedToolEnv } from './scriptSkill';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
} from './types';

/**
 * The process-wide scratch directory for refusal files, created on first use.
 *
 * Retried on the next job when it fails: a tmpdir that was full at startup may
 * not be later, and a skill that can never refuse is a worse outcome than one
 * `mkdtemp` attempt per job until it works.
 */
let sharedRefusalDir: Promise<string | null> | undefined;

async function refusalDirectory(attempt = 0): Promise<string | null> {
  const pending = (sharedRefusalDir ??= mkdtemp(join(tmpdir(), 'elisym-static-out-')).catch(
    () => null,
  ));
  const dir = await pending;
  // Only clear the promise we ourselves awaited: two jobs finding the same dead
  // directory would otherwise each discard the other's replacement and leave it
  // behind, one leaked directory per collision.
  const forget = (): void => {
    if (sharedRefusalDir === pending) {
      sharedRefusalDir = undefined;
    }
  };
  if (dir === null) {
    // Creation failed: forget it, so the next job tries again. A tmpdir that
    // was full at startup may not be later.
    forget();
    return null;
  }
  // And confirm it is still there. An agent runs for weeks, and a tmp reaper
  // deleting the directory would otherwise leave every later job pointing at a
  // path that no longer exists - the script's redirect then fails and a refusal
  // arrives as a crash.
  const alive = await stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (alive) {
    return dir;
  }
  forget();
  // One retry. A tmpdir that keeps losing the directory is a broken host, and
  // spinning here would hold the job slot forever instead of running the job
  // without a refusal channel.
  return attempt === 0 ? refusalDirectory(attempt + 1) : null;
}

export interface StaticScriptSkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  /** Absolute path to the script. */
  scriptPath: string;
  /** Extra args appended after the script path. */
  scriptArgs: string[];
  /** Optional override of the default 60s timeout. */
  scriptTimeoutMs?: number;
  /**
   * Full environment for the script. When omitted, the script inherits
   * `process.env`. Callers (typically the CLI loader) spread `process.env`
   * and add narrowly-scoped secrets like provider API keys.
   */
  scriptEnv?: NodeJS.ProcessEnv;
  image?: string;
  imageFile?: string;
  /**
   * Declared LLM dependency. The (provider, model) pair tells the runtime
   * which API key the script reaches under the hood so it can be
   * health-monitored. Carried through from SKILL.md as-is; the script
   * itself reads the key from its environment.
   */
  llmOverride?: SkillLlmOverride;
}

/**
 * Spawns a configured script with no stdin and returns its trimmed stdout.
 * Throws on non-zero exit so the runtime surfaces a sanitized error.
 * The script runs with cwd set to its containing directory so relative
 * paths inside the script behave intuitively.
 */
export class StaticScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'static-script';
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  private scriptPath: string;
  private scriptArgs: string[];
  private scriptTimeoutMs?: number;
  private scriptEnv?: NodeJS.ProcessEnv;

  constructor(params: StaticScriptSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.llmOverride = params.llmOverride;
    this.scriptPath = params.scriptPath;
    this.scriptArgs = params.scriptArgs;
    this.scriptTimeoutMs = params.scriptTimeoutMs;
    this.scriptEnv = params.scriptEnv;
  }

  async execute(_input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    // One directory for the whole process, a file per job. This mode is the
    // cron-shaped one - it may touch no filesystem at all - so paying a
    // `mkdtemp` and a recursive `rm` on every tick to hand the script a path it
    // usually never writes is the wrong trade; and a directory per SKILL would
    // leak one per restart, since nothing disposes a skill.
    //
    // A read-only or full tmpdir must not be what stops a static skill running:
    // the job simply has no refusal channel, and the next one tries again.
    const dir = await refusalDirectory();
    const refusalFile = dir === null ? undefined : join(dir, `refusal-${randomUUID()}`);
    try {
      return await this.run(ctx, refusalFile);
    } finally {
      if (refusalFile !== undefined) {
        await rm(refusalFile, { force: true }).catch(() => {});
      }
    }
  }

  private async run(ctx: SkillContext, refusalFile: string | undefined): Promise<SkillOutput> {
    const result = await runScript(this.scriptPath, this.scriptArgs, {
      cwd: dirname(this.scriptPath),
      signal: ctx.signal,
      timeoutMs: this.scriptTimeoutMs,
      // No caller-provided env -> scoped copy of process.env (secret vars
      // stripped), never the raw parent env with the operator's key ring.
      env: {
        ...(this.scriptEnv ?? scopedToolEnv()),
        ...(refusalFile === undefined ? {} : { [SCRIPT_REFUSAL_FILE_ENV]: refusalFile }),
      },
    });
    if (result.spawnError) {
      throw new ScriptExecutionError(
        null,
        result.spawnError.message,
        'script could not be started',
        result.spawnError.message,
      );
    }
    if (result.code === SCRIPT_EXIT_BILLING_EXHAUSTED) {
      throw new ScriptBillingExhaustedError(result.code, result.stdout, result.stderr);
    }
    // After the billing signal, before everything else: an exhausted key
    // must gate the agent even if a refusal file from an earlier branch is
    // lying around. Otherwise a written reason wins, including over the
    // success path - a script that wrote one and then exited 0 refused,
    // whatever its exit code claims.
    throwIfRefused(
      result,
      refusalFile === undefined ? { state: 'absent' } : await readRefusalFile(refusalFile),
      refusalFile !== undefined,
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
      // Generic message reaches the customer; raw stderr/stdout stays on `detail`
      // for the operator log and health-monitor classification only.
      throw new ScriptExecutionError(result.code, detail, undefined, result.stderr);
    }
    const output = result.stdout.trim();
    if (output === '') {
      // Exit 0 with no output is not a deliverable result: the marketplace
      // rejects empty results at delivery, but only after the ledger has
      // marked the job `executed`, and recovery then retries the empty
      // result on every tick forever. Failing here keeps the job on the
      // paid -> failed path so recovery terminates it. stderr (if any)
      // carries the underlying reason for the operator log.
      const detail = result.stderr.trim() || '(no stderr)';
      throw new ScriptExecutionError(
        result.code,
        detail,
        'script produced empty output',
        result.stderr,
      );
    }
    return { data: output };
  }
}
