/**
 * CLI wrapper for `mode: 'x402'` skills. Thin by design: the whole protocol
 * (payment signing, policies, idempotency, error classification) lives in
 * the runtime-injected `SkillContext.x402` driver, mirroring how LLM skills
 * delegate to `ctx.getLlm`.
 */
import type { Asset } from '@elisym/sdk';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillMode,
  SkillOutput,
  X402JobDriver,
  X402SkillJob,
  X402SkillParams,
} from './index.js';

export interface X402SkillWrapperParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  x402: X402SkillParams;
  noInput: boolean;
  image?: string;
  imageFile?: string;
  dir?: string;
}

export class X402Skill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  mode: SkillMode = 'x402';
  x402: X402SkillParams;
  noInput: boolean;
  image?: string;
  imageFile?: string;
  dir?: string;

  constructor(params: X402SkillWrapperParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.x402 = params.x402;
    this.noInput = params.noInput;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.dir = params.dir;
  }

  private requireDriver(ctx: SkillContext): X402JobDriver {
    if (ctx.x402Driver === undefined) {
      throw new Error(
        `Skill "${this.name}": x402 driver not wired into the skill context (internal error)`,
      );
    }
    return ctx.x402Driver;
  }

  private asJob(): X402SkillJob {
    return {
      skillName: this.name,
      params: this.x402,
      priceSubunits: this.priceSubunits,
      asset: this.asset,
    };
  }

  async preflight(input: SkillInput, ctx: SkillContext): Promise<void> {
    await this.requireDriver(ctx).preflight(this.asJob(), input);
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    const result = await this.requireDriver(ctx).execute(this.asJob(), input, ctx.signal);
    // No cleanup callback on purpose: a file result is the idempotency
    // cache's copy and the crash-recovery delivery source; the store's TTL
    // sweep owns deletion.
    return { data: result.data, outputMime: result.outputMime, filePath: result.filePath };
  }
}
