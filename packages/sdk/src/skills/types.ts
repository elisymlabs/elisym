/**
 * Shared SKILL.md runtime types. A skill is a markdown document whose
 * YAML frontmatter declares capabilities, pricing, and optional
 * tool-use shape; the markdown body is the system prompt the LLM runs
 * against.
 */

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

/**
 * Optional per-skill LLM override declared in SKILL.md frontmatter.
 *
 * Parse-time invariant (enforced by `validateLlmOverride` in the loader):
 * `provider` is set iff `model` is set. `maxTokens` is independent. So
 * downstream code may rely on: when `provider !== undefined`, `model` is
 * also defined.
 */
export interface SkillLlmOverride {
  provider?: 'anthropic' | 'openai';
  model?: string;
  maxTokens?: number;
}

export interface SkillContext {
  /** Agent-default LLM client. May be undefined when every LLM skill overrides. */
  llm?: LlmClient;
  /**
   * Resolve the LLM client for a skill. The runtime caches clients by
   * resolved (provider, model, maxTokens) triple. Callers pass their
   * `llmOverride` (or undefined for the agent default).
   */
  getLlm?: (override?: SkillLlmOverride) => LlmClient | undefined;
  agentName: string;
  agentDescription: string;
  signal?: AbortSignal;
}

/**
 * How the runtime produces a result for a job:
 * - `llm`: feed input through Anthropic/OpenAI with the skill's system prompt (default).
 * - `static-file`: return the contents of a fixed file. No input required.
 * - `static-script`: spawn a script with no stdin. No input required.
 * - `dynamic-script`: spawn a script and pipe the user's input to stdin.
 *
 * Static modes set `card.static = true` so the webapp hides its input box.
 */
export type SkillMode = 'llm' | 'static-file' | 'static-script' | 'dynamic-script';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: boolean }>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
}

export type CompletionResult =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; calls: ToolCall[]; assistantMessage: unknown };

export interface LlmClient {
  complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string>;
  completeWithTools(
    systemPrompt: string,
    messages: unknown[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
  formatToolResultMessages(results: ToolResult[]): unknown[];
}

export interface Skill {
  name: string;
  description: string;
  capabilities: string[];
  /** Price in subunits of `asset` (lamports for SOL, 1e-6 USDC for USDC). */
  priceSubunits: bigint;
  /** Asset the price is denominated in (NATIVE_SOL or USDC_SOLANA_DEVNET, etc.). */
  asset: import('../payment/assets').Asset;
  /** Execution mode. Default 'llm' for back-compat. */
  mode: SkillMode;
  /**
   * Optional per-skill LLM config override (only set when mode === 'llm').
   * Carried through from SKILL.md frontmatter so the runtime can route this
   * skill to a non-default model/provider/max_tokens.
   */
  llmOverride?: SkillLlmOverride;
  image?: string;
  imageFile?: string;
  execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}
