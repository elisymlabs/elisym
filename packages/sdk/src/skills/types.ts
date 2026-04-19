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

export interface SkillContext {
  llm?: LlmClient;
  agentName: string;
  agentDescription: string;
  signal?: AbortSignal;
}

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
  priceLamports: bigint;
  image?: string;
  imageFile?: string;
  execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}
