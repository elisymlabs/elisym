/**
 * CLI ScriptSkill - thin wrapper over `@elisym/sdk/skills` ScriptSkill.
 *
 * Preserves the CLI's historical positional constructor and Skill
 * interface shape (priceSubunits as number, mutable image/imageFile
 * fields) while delegating all execution logic to the shared SDK
 * runner - so tool-use, spawn, max_tool_rounds, and timeout behaviour
 * stay identical to the plugin / SDK path.
 */
import { NATIVE_SOL, type Asset } from '@elisym/sdk';
import { ScriptSkill as SdkScriptSkill, type SkillToolDef } from '@elisym/sdk/skills';
import type { Skill, SkillContext, SkillInput, SkillOutput } from './index.js';

/**
 * CLI ScriptSkill constructor with a back-compat positional signature.
 *
 * The `asset` parameter is accepted in two positions:
 * - 5th (new code: `new ScriptSkill(name, desc, caps, price, asset, image, imageFile, dir,
 *   prompt, tools, rounds)`) - preferred for USDC/multi-asset.
 * - As part of a trailing `{ asset }` init; else falls through to NATIVE_SOL
 *   when the 5th positional slot is `undefined` / is actually an `image` string.
 *
 * This preserves older `new ScriptSkill(name, desc, caps, price, image, ...)` call sites
 * (internal tests) so we do not have to touch them to land USDC support.
 */
export class ScriptSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: number;
  asset: Asset;
  image?: string;
  imageFile?: string;
  dir: string;
  private inner: SdkScriptSkill;

  constructor(
    name: string,
    description: string,
    capabilities: string[],
    priceSubunits: number,
    assetOrImage: Asset | string | undefined,
    imageOrImageFile: string | undefined,
    imageFileOrDir: string | undefined,
    dirOrPrompt: string,
    promptOrTools: string | SkillToolDef[],
    toolsOrRounds: SkillToolDef[] | number,
    rounds?: number,
  ) {
    // Detect the new-style (asset passed as 5th arg) vs legacy-style (asset
    // omitted, image at 5th arg). An Asset has the shape { chain, token, decimals, symbol }.
    let asset: Asset;
    let image: string | undefined;
    let imageFile: string | undefined;
    let skillDir: string;
    let systemPrompt: string;
    let tools: SkillToolDef[];
    let maxToolRounds: number;

    if (assetOrImage !== undefined && typeof assetOrImage === 'object' && 'token' in assetOrImage) {
      // new-style: assetOrImage is Asset
      asset = assetOrImage;
      image = imageOrImageFile;
      imageFile = imageFileOrDir;
      skillDir = dirOrPrompt;
      systemPrompt = promptOrTools as string;
      tools = toolsOrRounds as SkillToolDef[];
      maxToolRounds = rounds as number;
    } else {
      // legacy-style: 5th arg is `image` (string or undefined), asset=NATIVE_SOL.
      asset = NATIVE_SOL;
      image = assetOrImage as string | undefined;
      imageFile = imageOrImageFile;
      skillDir = imageFileOrDir as string;
      systemPrompt = dirOrPrompt;
      tools = promptOrTools as SkillToolDef[];
      maxToolRounds = toolsOrRounds as number;
    }

    this.name = name;
    this.description = description;
    this.capabilities = capabilities;
    this.priceSubunits = priceSubunits;
    this.asset = asset;
    this.image = image;
    this.imageFile = imageFile;
    this.dir = skillDir;
    this.inner = new SdkScriptSkill({
      name,
      description,
      capabilities,
      priceSubunits: BigInt(Math.round(priceSubunits)),
      asset,
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
