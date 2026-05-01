import { dirname } from 'node:path';
import { SCRIPT_EXIT_BILLING_EXHAUSTED } from '../llm-health/constants';
import { ScriptBillingExhaustedError } from '../llm-health/types';
import type { Asset } from '../payment/assets';
import { runScript } from './scriptSkill';
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
    const result = await runScript(this.scriptPath, this.scriptArgs, {
      cwd: dirname(this.scriptPath),
      signal: ctx.signal,
      timeoutMs: this.scriptTimeoutMs,
      env: this.scriptEnv,
    });
    if (result.spawnError) {
      throw new Error(`script spawn failed: ${result.spawnError.message}`);
    }
    if (result.code === SCRIPT_EXIT_BILLING_EXHAUSTED) {
      throw new ScriptBillingExhaustedError(result.code, result.stdout, result.stderr);
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
      throw new Error(`script failed (exit ${result.code}): ${detail}`);
    }
    return { data: result.stdout.trim() };
  }
}
