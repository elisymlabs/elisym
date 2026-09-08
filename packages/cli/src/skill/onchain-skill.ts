/**
 * CLI wrapper for `mode: 'onchain'` - a capability that BUILDS a Solana call
 * for the customer to sign. Mirrors the other wrappers: the CLI's `Skill`
 * shape (`priceSubunits: number`, `dir`) over the shared SDK runner, which
 * does the work and checks the emitted call against the capability's own
 * published promise before it leaves the agent.
 *
 * The agent needs no wallet for this mode. It signs nothing and never holds
 * the customer's funds.
 */
import type { Asset, Network, SkillOnchainResolved } from '@elisym/sdk';
import {
  OnchainCallSkill as SdkOnchainCallSkill,
  type SkillLlmOverride,
  type SkillMode,
} from '@elisym/sdk/skills';
import type { Skill, SkillContext, SkillInput, SkillOutput } from './index.js';

export interface CliOnchainSkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  scriptPath: string;
  scriptArgs: string[];
  scriptTimeoutMs?: number;
  scriptEnv?: NodeJS.ProcessEnv;
  image?: string;
  imageFile?: string;
  dir: string;
  llmOverride?: SkillLlmOverride;
  onchain: SkillOnchainResolved;
  network: Network;
}

export class OnchainSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  mode: SkillMode = 'onchain';
  image?: string;
  imageFile?: string;
  dir: string;
  llmOverride?: SkillLlmOverride;
  readonly onchain: SkillOnchainResolved;
  private inner: SdkOnchainCallSkill;

  constructor(params: CliOnchainSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.dir = params.dir;
    this.llmOverride = params.llmOverride;
    this.onchain = params.onchain;
    this.inner = new SdkOnchainCallSkill({
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      priceSubunits: BigInt(Math.round(params.priceSubunits)),
      asset: params.asset,
      scriptPath: params.scriptPath,
      scriptArgs: params.scriptArgs,
      scriptTimeoutMs: params.scriptTimeoutMs,
      scriptEnv: params.scriptEnv,
      image: params.image,
      imageFile: params.imageFile,
      llmOverride: params.llmOverride,
      onchain: params.onchain,
      network: params.network,
    });
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    return this.inner.execute(input, ctx);
  }
}
