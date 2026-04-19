/**
 * CLI ScriptSkill - thin wrapper over `@elisym/sdk/skills` ScriptSkill.
 *
 * Preserves the CLI's historical positional constructor and Skill
 * interface shape (priceLamports as number, mutable image/imageFile
 * fields) while delegating all execution logic to the shared SDK
 * runner - so tool-use, spawn, max_tool_rounds, and timeout behaviour
 * stay identical to the plugin / SDK path.
 */
import { ScriptSkill as SdkScriptSkill, type SkillToolDef } from '@elisym/sdk/skills';
import type { Skill, SkillContext, SkillInput, SkillOutput } from './index.js';

export class ScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceLamports: number;
  image?: string;
  imageFile?: string;
  private inner: SdkScriptSkill;

  constructor(
    name: string,
    description: string,
    capabilities: string[],
    priceLamports: number,
    image: string | undefined,
    imageFile: string | undefined,
    skillDir: string,
    systemPrompt: string,
    tools: SkillToolDef[],
    maxToolRounds: number,
  ) {
    this.name = name;
    this.description = description;
    this.capabilities = capabilities;
    this.priceLamports = priceLamports;
    this.image = image;
    this.imageFile = imageFile;
    this.inner = new SdkScriptSkill({
      name,
      description,
      capabilities,
      priceLamports: BigInt(Math.round(priceLamports)),
      skillDir,
      systemPrompt,
      tools,
      maxToolRounds,
      image,
      imageFile,
    });
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    return this.inner.execute(input, ctx);
  }
}
