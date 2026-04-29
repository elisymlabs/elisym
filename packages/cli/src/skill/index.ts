/**
 * Skill interface and registry.
 */

import { toDTag, type Asset } from '@elisym/sdk';
import type { SkillLlmOverride, SkillMode } from '@elisym/sdk/skills';

export type { SkillLlmOverride, SkillMode };

export interface SkillInput {
  data: string;
  inputType: string;
  tags: string[];
  jobId: string;
}

export interface SkillOutput {
  data: string;
  outputMime?: string;
}

export interface SkillContext {
  /** Agent-default LLM client. Undefined when every LLM skill overrides. */
  llm?: LlmClient;
  /**
   * Resolve the LLM client for a skill. The runtime caches clients by
   * resolved (provider, model, maxTokens) triple. Pass the skill's
   * `llmOverride` (or undefined for the agent default).
   */
  getLlm?: (override?: SkillLlmOverride) => LlmClient | undefined;
  agentName: string;
  agentDescription: string;
  signal?: AbortSignal;
}

export interface LlmClient {
  complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string>;
  completeWithTools(
    systemPrompt: string,
    messages: any[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
  /** Format tool results into provider-specific messages (Anthropic vs OpenAI). */
  formatToolResultMessages(results: ToolResult[]): any[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: boolean }>;
}

export type CompletionResult =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; calls: ToolCall[]; assistantMessage: any };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** Provider-agnostic tool result passed from ScriptSkill to LlmClient. */
export interface ToolResult {
  callId: string;
  content: string;
}

/**
 * A skill that can be executed by the agent runtime.
 *
 * Skills should be idempotent or tolerant of re-execution: if the agent crashes
 * after execute() returns but before the result is persisted, recovery will
 * re-execute the skill with the same input (at-least-once delivery).
 */
export interface Skill {
  name: string;
  description: string;
  capabilities: string[];
  /**
   * Price in subunits of `asset` (0 = free). For SOL: lamports (1e-9 SOL).
   * For USDC: 1e-6 USDC. Converted from SKILL.md's human-readable `price`.
   *
   * Number (not bigint) for ergonomics - realistic agent prices fit well
   * below `Number.MAX_SAFE_INTEGER` subunits.
   */
  priceSubunits: number;
  /** Asset the price is denominated in (NATIVE_SOL or USDC_SOLANA_DEVNET, etc.). */
  asset: Asset;
  /** Execution mode (`'llm'` for the historical LLM-orchestrated path). */
  mode: SkillMode;
  /** Optional per-skill LLM override (only set when mode === 'llm'). */
  llmOverride?: SkillLlmOverride;
  /** Hero image URL. */
  image?: string;
  /** Local file path for hero image (uploaded on first start). */
  imageFile?: string;
  /** On-disk skill directory (e.g. `<agent>/skills/whois-lookup`). */
  dir?: string;
  execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}

export class SkillRegistry {
  private skills: Skill[] = [];
  private defaultIndex: number | null = null;

  register(skill: Skill): void {
    if (this.defaultIndex === null) {
      this.defaultIndex = this.skills.length;
    }
    this.skills.push(skill);
  }

  route(tags: string[]): Skill | null {
    // Match by skill name in canonical d-tag form. Outgoing capability cards
    // publish `['d', toDTag(card.name)]`, so incoming job tags arrive
    // d-tag-shaped (lowercase, ASCII letters + digits + hyphens). Comparing
    // raw `skill.name` only works when the name is already kebab-case;
    // normalize through `toDTag` so human-readable names route too.
    for (const tag of tags) {
      const byName = this.skills.find((skill) => toDTag(skill.name) === tag);
      if (byName) {
        return byName;
      }
    }
    // Then declared capability tags (secondary matching).
    for (const tag of tags) {
      const byCap = this.skills.find((skill) => skill.capabilities.includes(tag));
      if (byCap) {
        return byCap;
      }
    }
    // Default fallback only for genuinely untargeted jobs (no specific tag
    // beyond the 'elisym' protocol marker). A job that *does* carry a
    // specific capability tag must not silently degrade to a free default -
    // that was a payment-bypass vector.
    const hasSpecificTag = tags.some((tag) => tag && tag !== 'elisym');
    if (hasSpecificTag) {
      return null;
    }
    return this.defaultIndex !== null ? this.skills[this.defaultIndex]! : null;
  }

  allCapabilities(): string[] {
    return this.skills.flatMap((s) => s.capabilities);
  }

  isEmpty(): boolean {
    return this.skills.length === 0;
  }

  all(): Skill[] {
    return this.skills;
  }
}
