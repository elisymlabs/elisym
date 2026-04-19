// Provider-agnostic skill runtime. Mirrors @elisym/cli's skill interface so
// a SKILL.md written for the CLI runs unmodified inside plugin-elizaos.
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
  execute(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}
