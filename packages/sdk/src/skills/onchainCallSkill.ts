/**
 * `mode: onchain` - a capability whose deliverable is a Solana call the
 * CUSTOMER signs.
 *
 * Execution is an ordinary script: the buyer's input goes to stdin, the
 * operator's builder (a router's API, an SDK, whatever they like) writes a call
 * envelope to stdout. The only thing added here is the provider's own check
 * against its published `onchain:` block, so a builder that drifts outside what
 * the card promises fails the agent's job instead of shipping a call the client
 * will refuse.
 *
 * The agent never signs, never holds the customer's funds, and needs no wallet
 * for this mode at all.
 */

import { validateProviderCall } from '../onchain/provider';
import type { SkillOnchainResolved } from '../onchain/types';
import type { Asset } from '../payment/assets';
import type { Network } from '../types';
import { DynamicScriptSkill } from './dynamicScriptSkill';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
} from './types';

export interface OnchainCallSkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  scriptPath: string;
  scriptArgs: string[];
  scriptTimeoutMs?: number;
  scriptEnv?: NodeJS.ProcessEnv;
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  /** The capability's published promise, minus the network. */
  onchain: SkillOnchainResolved;
  /** The agent's network - the call must be built for it. */
  network: Network;
}

export class OnchainCallSkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'onchain';
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  readonly onchain: SkillOnchainResolved;
  private readonly network: Network;
  private readonly script: DynamicScriptSkill;

  constructor(params: OnchainCallSkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.image = params.image;
    this.imageFile = params.imageFile;
    this.llmOverride = params.llmOverride;
    this.onchain = params.onchain;
    this.network = params.network;
    this.script = new DynamicScriptSkill({
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      priceSubunits: params.priceSubunits,
      asset: params.asset,
      scriptPath: params.scriptPath,
      scriptArgs: params.scriptArgs,
      scriptTimeoutMs: params.scriptTimeoutMs,
      scriptEnv: params.scriptEnv,
      llmOverride: params.llmOverride,
    });
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    const output = await this.script.execute(input, ctx);
    if (output.filePath !== undefined || output.filePaths !== undefined) {
      await output.cleanup?.();
      throw new Error('onchain skill returned a file; a call envelope is text');
    }
    const envelope = validateProviderCall({
      output: output.data,
      descriptor: this.onchain,
      network: this.network,
    });
    // Re-serialized from the parsed envelope, so unknown keys a builder tacked
    // on never reach the customer and the wire shape is exactly the schema.
    return { data: JSON.stringify(envelope), outputMime: 'application/json' };
  }
}
