import Decimal from 'decimal.js-light';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * A thinking block as the Anthropic API returned it (the text is empty unless a
 * summary was asked for). Sent back unchanged within a turn: dropping or editing
 * it breaks the turn on models that think by default.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** A system prompt block; `cache` marks the end of a cacheable prefix (5.6). */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | { name: string };

export interface TurnRequest {
  system: SystemBlock[];
  messages: LlmMessage[];
  tools: ToolSpec[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  /**
   * Put a cache breakpoint on the last message too, so each tool round reads
   * the earlier rounds from cache instead of re-billing them (5.6).
   */
  cacheLastMessage?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface TurnResponse {
  text: string;
  toolCalls: ToolUseBlock[];
  usage: Usage;
  stopReason: string;
  /**
   * The assistant turn exactly as returned, thinking blocks included and in
   * order, for the tool loop to send back. Absent: the text and tool calls
   * rebuild it.
   */
  assistantContent?: ContentBlock[];
}

/** The response was cut at max_tokens: its text or tool call is incomplete. */
export const TRUNCATED_STOP_REASONS: readonly string[] = ['max_tokens', 'length'];
/** The model or the provider's safety layer declined: there is no answer to use. */
export const DECLINED_STOP_REASONS: readonly string[] = ['refusal', 'content_filter'];

/** One model behind one provider. Adapters never log prompts or messages (4.4). */
export interface LlmProvider {
  readonly model: string;
  turn(request: TurnRequest): Promise<TurnResponse>;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

/**
 * Prices per million tokens, as decimal strings in USD. Configured by the
 * deployment per model; never hard-coded here, so nothing goes stale silently.
 */
export interface ModelPrice {
  input: string;
  cachedInput: string;
  cacheWrite: string;
  output: string;
}

const MILLION = new Decimal(1_000_000);

/** The cost of a usage at a price, in USD, exact (decimal.js-light). */
export function costOf(usage: Usage, price: ModelPrice): Decimal {
  return new Decimal(usage.inputTokens)
    .times(price.input)
    .plus(new Decimal(usage.cachedInputTokens).times(price.cachedInput))
    .plus(new Decimal(usage.cacheWriteTokens).times(price.cacheWrite))
    .plus(new Decimal(usage.outputTokens).times(price.output))
    .div(MILLION);
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
