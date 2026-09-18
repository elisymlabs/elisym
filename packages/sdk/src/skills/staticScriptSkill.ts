import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRIPT_EXIT_BILLING_EXHAUSTED } from '../llm-health/constants';
import { ScriptBillingExhaustedError, ScriptExecutionError } from '../llm-health/types';
import type { Asset } from '../payment/assets';
import { HostScratchError } from './host-fault';
import { SCRIPT_REFUSAL_FILE_ENV, throwIfRefused } from './refusal';
import { readRefusalFile } from './refusal-file';
import { jobScriptEnv, runScript, scopedToolEnv } from './scriptSkill';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
} from './types';

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
    // A directory per JOB, and a `HostScratchError` when the disk refuses one.
    //
    // Per job because a shared directory is enumerable: `ls "$(dirname
    // "$ELISYM_REFUSAL_FILE")"` from one job's script reaches the channel of
    // every other job running beside it, and forging a refusal there closes a
    // different customer's paid job.
    //
    // And an error rather than running without a channel, which is what this
    // used to do: a script that refused then had its reason dropped, the
    // customer was charged for a "crash", and the operator's capability was
    // gated for a local disk problem. The runtime reads this type instead to
    // leave the health gate alone, keep a paid job for recovery, and refuse the
    // next customer before they pay.
    const dir = await mkdtemp(join(tmpdir(), 'elisym-static-out-')).catch((err: unknown) => {
      throw new HostScratchError(err instanceof Error ? err.message : String(err));
    });
    try {
      return await this.run(ctx, join(dir, 'refusal'));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async run(ctx: SkillContext, refusalFile: string): Promise<SkillOutput> {
    const channels: NodeJS.ProcessEnv = { [SCRIPT_REFUSAL_FILE_ENV]: refusalFile };
    const result = await runScript(this.scriptPath, this.scriptArgs, {
      cwd: dirname(this.scriptPath),
      signal: ctx.signal,
      timeoutMs: this.scriptTimeoutMs,
      // No caller-provided env -> scoped copy of process.env (secret vars
      // stripped), never the raw parent env with the operator's key ring. A
      // caller-provided one is a spread of `process.env` too, so an INHERITED
      // channel is stripped either way before this job's own is written in.
      env:
        this.scriptEnv === undefined
          ? scopedToolEnv(channels)
          : jobScriptEnv(this.scriptEnv, channels),
    });
    if (result.spawnError) {
      throw new ScriptExecutionError(
        null,
        result.spawnError.message,
        'script could not be started',
        // EMPTY, not absent: the child never ran, so it said nothing. Absent
        // would let the health scan fall back to `detail` - which here is the
        // spawn message - and gate the operator's key on the word "billing" in
        // a script PATH. The operator still reads the path, off `detail`.
        '',
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
    throwIfRefused(result, await readRefusalFile(refusalFile));
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
