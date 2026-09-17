import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRIPT_EXIT_BILLING_EXHAUSTED } from '../llm-health/constants';
import { ScriptBillingExhaustedError, ScriptExecutionError } from '../llm-health/types';
import type { Asset } from '../payment/assets';
import { readRefusalFile, SCRIPT_REFUSAL_FILE_ENV, throwIfRefused } from './refusal';
import { runScript, scopedToolEnv } from './scriptSkill';
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
    // A directory for the one out-of-band channel this mode has: the refusal
    // reason. Removed on every path, unlike the dynamic runner's, which may
    // outlive `execute` while a file result is seeded.
    const outDir = await mkdtemp(join(tmpdir(), 'elisym-static-out-'));
    try {
      return await this.run(ctx, join(outDir, 'refusal'));
    } finally {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async run(ctx: SkillContext, refusalFile: string): Promise<SkillOutput> {
    const result = await runScript(this.scriptPath, this.scriptArgs, {
      cwd: dirname(this.scriptPath),
      signal: ctx.signal,
      timeoutMs: this.scriptTimeoutMs,
      // No caller-provided env -> scoped copy of process.env (secret vars
      // stripped), never the raw parent env with the operator's key ring.
      env: {
        ...(this.scriptEnv ?? scopedToolEnv()),
        [SCRIPT_REFUSAL_FILE_ENV]: refusalFile,
      },
    });
    if (result.spawnError) {
      throw new ScriptExecutionError(
        null,
        result.spawnError.message,
        'script could not be started',
      );
    }
    // Before every other verdict, including billing: a written reason is the
    // most deliberate thing a script can say, and it is what the customer needs
    // to read. Runs on the success path too - a script that wrote a refusal and
    // then exited 0 refused, whatever its exit code claims.
    throwIfRefused(result, await readRefusalFile(refusalFile));
    if (result.code === SCRIPT_EXIT_BILLING_EXHAUSTED) {
      throw new ScriptBillingExhaustedError(result.code, result.stdout, result.stderr);
    }
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
      throw new ScriptExecutionError(result.code, detail, 'script produced empty output');
    }
    return { data: output };
  }
}
