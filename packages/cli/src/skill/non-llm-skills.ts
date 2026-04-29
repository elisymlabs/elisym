/**
 * CLI wrappers around the non-LLM SDK skill classes. They mirror the
 * pattern in `script-skill.ts` so the CLI's `Skill` interface
 * (`priceSubunits: number`, `mode`, `dir`) stays uniform across all
 * execution modes while delegating actual work to the shared SDK runners.
 */
import type { Asset } from '@elisym/sdk';
import {
  DynamicScriptSkill as SdkDynamicScriptSkill,
  StaticFileSkill as SdkStaticFileSkill,
  StaticScriptSkill as SdkStaticScriptSkill,
  type SkillMode,
} from '@elisym/sdk/skills';
import type { Skill, SkillContext, SkillInput, SkillOutput } from './index.js';

interface BaseParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  image?: string;
  imageFile?: string;
  /** On-disk skill directory. */
  dir: string;
}

export interface CliStaticFileSkillParams extends BaseParams {
  outputFilePath: string;
}

export class StaticFileSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  mode: SkillMode = 'static-file';
  image?: string;
  imageFile?: string;
  dir: string;
  private inner: SdkStaticFileSkill;

  constructor(params: CliStaticFileSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.dir = params.dir;
    this.inner = new SdkStaticFileSkill({
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      priceSubunits: BigInt(Math.round(params.priceSubunits)),
      asset: params.asset,
      outputFilePath: params.outputFilePath,
      image: params.image,
      imageFile: params.imageFile,
    });
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    return this.inner.execute(input, ctx);
  }
}

export interface CliScriptSkillParams extends BaseParams {
  scriptPath: string;
  scriptArgs: string[];
  scriptTimeoutMs?: number;
}

export class StaticScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  mode: SkillMode = 'static-script';
  image?: string;
  imageFile?: string;
  dir: string;
  private inner: SdkStaticScriptSkill;

  constructor(params: CliScriptSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.dir = params.dir;
    this.inner = new SdkStaticScriptSkill({
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      priceSubunits: BigInt(Math.round(params.priceSubunits)),
      asset: params.asset,
      scriptPath: params.scriptPath,
      scriptArgs: params.scriptArgs,
      scriptTimeoutMs: params.scriptTimeoutMs,
      image: params.image,
      imageFile: params.imageFile,
    });
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    return this.inner.execute(input, ctx);
  }
}

export class DynamicScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  mode: SkillMode = 'dynamic-script';
  image?: string;
  imageFile?: string;
  dir: string;
  private inner: SdkDynamicScriptSkill;

  constructor(params: CliScriptSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.dir = params.dir;
    this.inner = new SdkDynamicScriptSkill({
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      priceSubunits: BigInt(Math.round(params.priceSubunits)),
      asset: params.asset,
      scriptPath: params.scriptPath,
      scriptArgs: params.scriptArgs,
      scriptTimeoutMs: params.scriptTimeoutMs,
      image: params.image,
      imageFile: params.imageFile,
    });
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    return this.inner.execute(input, ctx);
  }
}
