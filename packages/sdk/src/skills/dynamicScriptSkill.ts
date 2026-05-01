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

export interface DynamicScriptSkillParams {
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
 * Pipes the user's job input to the script's stdin and returns its
 * trimmed stdout. Enables script-backed capabilities (proxies to
 * external models, classical NLP, custom workers) without an LLM key
 * on the elisym side.
 */
export class DynamicScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'dynamic-script';
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  private scriptPath: string;
  private scriptArgs: string[];
  private scriptTimeoutMs?: number;
  private scriptEnv?: NodeJS.ProcessEnv;

  constructor(params: DynamicScriptSkillParams) {
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

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    const result = await runScript(this.scriptPath, this.scriptArgs, {
      cwd: dirname(this.scriptPath),
      stdin: input.data,
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
