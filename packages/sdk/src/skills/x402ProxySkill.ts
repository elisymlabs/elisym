import type { Asset } from '../payment/assets';
import type {
  Skill,
  SkillContext,
  SkillInput,
  SkillLlmOverride,
  SkillMode,
  SkillOutput,
  X402Invoker,
  X402SkillParams,
} from './types';

export interface X402ProxySkillParams {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  x402: X402SkillParams;
  image?: string;
  imageFile?: string;
}

/**
 * Bridges a job to an x402-paid HTTP upstream. The skill itself is a thin
 * adapter: the whole protocol (payment signing, requirement policies,
 * idempotency cache, error classification) lives in the host-injected
 * `SkillContext.x402` driver, mirroring how `mode: 'llm'` delegates to
 * `ctx.getLlm`. Constructing this skill is gated at load time
 * (`LoadSkillsOptions.allowX402Skills`), so an SDK-only host never
 * advertises a capability it cannot execute.
 */
export class X402ProxySkill implements Skill {
  name: string;
  description: string;
  capabilities: string[];
  priceSubunits: bigint;
  asset: Asset;
  mode: SkillMode = 'x402';
  image?: string;
  imageFile?: string;
  llmOverride?: SkillLlmOverride;
  readonly x402: X402SkillParams;

  constructor(params: X402ProxySkillParams) {
    this.name = params.name;
    this.description = params.description;
    this.capabilities = params.capabilities;
    this.priceSubunits = params.priceSubunits;
    this.asset = params.asset;
    this.x402 = params.x402;
    this.image = params.image;
    this.imageFile = params.imageFile;
  }

  /** GET upstream without a query param consumes no buyer input (card should be static). */
  get noInput(): boolean {
    return this.x402.method === 'GET' && this.x402.queryParam === undefined;
  }

  private requireInvoker(ctx: SkillContext): X402Invoker {
    if (ctx.x402 === undefined) {
      throw new Error(
        `Skill "${this.name}": x402 skills require the elisym CLI runtime (no x402 driver in SkillContext)`,
      );
    }
    return ctx.x402;
  }

  async preflight(input: SkillInput, ctx: SkillContext): Promise<void> {
    await this.requireInvoker(ctx).preflight(this.x402, input);
  }

  async execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
    const result = await this.requireInvoker(ctx).execute(this.x402, input, ctx.signal);
    // No cleanup callback on purpose: a file result lives in the host's
    // idempotency cache and doubles as the crash-recovery delivery source;
    // the cache's TTL sweep owns deletion (the runtime calls cleanup even on
    // a failed seed, which would destroy the only copy of a bought result).
    return {
      data: result.data,
      outputMime: result.outputMime,
      filePath: result.filePath,
    };
  }
}
