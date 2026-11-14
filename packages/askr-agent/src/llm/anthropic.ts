import {
  type ContentBlock,
  type LlmMessage,
  type LlmProvider,
  LlmError,
  type ToolUseBlock,
  type TurnRequest,
  type TurnResponse,
} from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// cspell:disable-next-line
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /**
   * `output_config.effort`: how much the model thinks. Claude Haiku, Sonnet and
   * Opus 5.5 think by default (Opus 5.5 cannot turn it off), and the thinking
   * counts toward max_tokens, which stays the caller's: a lower effort is how a
   * short answer fits. Unset leaves the model's default (medium on Opus and
   * Haiku 5.5, high on Sonnet 5.5).
   */
  effort?: Effort;
  baseUrl?: string;
  fetch?: typeof fetch;
}

function toAnthropicContent(block: ContentBlock): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  if (block.type === 'thinking') {
    return { type: 'thinking', thinking: block.thinking, signature: block.signature };
  }
  if (block.type === 'redacted_thinking') {
    return { type: 'redacted_thinking', data: block.data };
  }
  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content,
    ...(block.isError ? { is_error: true } : {}),
  };
}

function toAnthropicMessage(message: LlmMessage): Record<string, unknown> {
  return { role: message.role, content: message.content.map(toAnthropicContent) };
}

/** Mark the last content block of the last message as a cache breakpoint. */
function withLastMessageCached(
  messages: Record<string, unknown>[],
  enabled: boolean,
): Record<string, unknown>[] {
  const last = messages.at(-1);
  if (!enabled || !last || !Array.isArray(last.content) || last.content.length === 0) {
    return messages;
  }
  const content = [...last.content];
  const lastBlock = content.at(-1);
  if (typeof lastBlock === 'object' && lastBlock !== null) {
    content[content.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } };
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** Anthropic Messages API, with explicit prompt-cache breakpoints (5.6, 5.7). */
export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  const doFetch = config.fetch ?? fetch;
  return {
    model: config.model,
    async turn(request: TurnRequest): Promise<TurnResponse> {
      const body: Record<string, unknown> = {
        model: config.model,
        // The caller's ceiling, never raised: the server sizes its spend reservation on it.
        max_tokens: request.maxTokens,
        // No temperature / top_p / top_k: Opus 5.5 rejects them, Haiku and Sonnet 5.5 reject
        // non-default values, and API version 2026-10-21 rejects them on every model.
        ...(config.effort ? { output_config: { effort: config.effort } } : {}),
        system: request.system.map((block) => ({
          type: 'text',
          text: block.text,
          ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        })),
        messages: withLastMessageCached(
          request.messages.map(toAnthropicMessage),
          request.cacheLastMessage === true,
        ),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      };
      const choice = request.toolChoice ?? 'auto';
      body.tool_choice = { type: choice };
      const response = await doFetch(config.baseUrl ?? ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok) {
        // The body may echo the request; only the status is surfaced (no content in logs, 4.4).
        throw new LlmError(
          `Anthropic request failed with status ${response.status}`,
          response.status,
        );
      }
      const json = recordOf(await response.json());
      const usage = recordOf(json.usage);
      const content = Array.isArray(json.content) ? json.content : [];
      let text = '';
      const toolCalls: ToolUseBlock[] = [];
      const assistantContent: ContentBlock[] = [];
      for (const entry of content) {
        const block = recordOf(entry);
        if (block.type === 'text' && typeof block.text === 'string') {
          text += text.length > 0 ? `\n\n${block.text}` : block.text;
          assistantContent.push({ type: 'text', text: block.text });
        } else if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          const call: ToolUseBlock = {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: recordOf(block.input),
          };
          toolCalls.push(call);
          assistantContent.push(call);
        } else if (block.type === 'thinking' && typeof block.signature === 'string') {
          // Kept even with empty text (the default display): the tool loop sends it back.
          assistantContent.push({
            type: 'thinking',
            thinking: typeof block.thinking === 'string' ? block.thinking : '',
            signature: block.signature,
          });
        } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
          assistantContent.push({ type: 'redacted_thinking', data: block.data });
        }
      }
      return {
        text,
        toolCalls,
        stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : 'unknown',
        assistantContent,
        usage: {
          inputTokens: numberOr(usage.input_tokens, 0),
          cachedInputTokens: numberOr(usage.cache_read_input_tokens, 0),
          cacheWriteTokens: numberOr(usage.cache_creation_input_tokens, 0),
          outputTokens: numberOr(usage.output_tokens, 0),
        },
      };
    },
  };
}
