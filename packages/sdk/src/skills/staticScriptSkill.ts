import { dirname } from 'node:path';
import type { Asset } from '../payment/assets';
import { runScript } from './scriptSkill';
import type { Skill, SkillContext, SkillInput, SkillMode, SkillOutput } from './types';

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
  image?: string;
  imageFile?: string;
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
  private scriptPath: string;
  private scriptArgs: string[];
  private scriptTimeoutMs?: number;

  constructor(params: StaticScriptSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.scriptPath = params.scriptPath;
    this.scriptArgs = params.scriptArgs;
    this.scriptTimeoutMs = params.scriptTimeoutMs;
  }

  async execute(_input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    const result = await runScript(this.scriptPath, this.scriptArgs, {
      cwd: dirname(this.scriptPath),
      signal: ctx.signal,
      timeoutMs: this.scriptTimeoutMs,
    });
    if (result.spawnError) {
      throw new Error(`script spawn failed: ${result.spawnError.message}`);
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
      throw new Error(`script failed (exit ${result.code}): ${detail}`);
    }
    return { data: result.stdout.trim() };
  }
}
