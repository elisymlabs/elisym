import {
  type LlmMessage,
  type LlmProvider,
  LlmError,
  type ToolUseBlock,
  type TurnRequest,
  type TurnResponse,
} from './types';

export interface OpenAiCompatibleConfig {
  apiKey: string;
  model: string;
  /** e.g. `https://openrouter.ai/api/v1`, `https://api.deepseek.com/v1`. */
  baseUrl: string;
  /**
   * Pass prompt-cache marks through as `cache_control` on system parts: needed
   * for Anthropic models routed through OpenRouter. DeepSeek and Gemini cache
   * by prefix on their own (5.7).
   */
  passCacheMarks?: boolean;
  /** Extra body fields, e.g. OpenRouter's `provider` data policy (no training, zero retention, 4.4). */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toOpenAiMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      const toolCalls = message.content
        .filter((block): block is ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));
      converted.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        converted.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
      } else if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) {
      converted.push({ role: 'user', content: texts.join('\n\n') });
    }
  }
  return converted;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    return recordOf(raw);
  }
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Chat Completions-compatible endpoints: OpenRouter, DeepSeek, Gemini's compatibility layer. */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  const doFetch = config.fetch ?? fetch;
  return {
    model: config.model,
    async turn(request: TurnRequest): Promise<TurnResponse> {
      const systemContent = config.passCacheMarks
        ? request.system.map((block) => ({
            type: 'text',
            text: block.text,
            ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {}),
          }))
        : request.system.map((block) => block.text).join('\n\n');
      const choice = request.toolChoice ?? 'auto';
      const body: Record<string, unknown> = {
        ...config.extraBody,
        model: config.model,
        max_tokens: request.maxTokens,
        messages: [
          { role: 'system', content: systemContent },
          ...toOpenAiMessages(request.messages),
        ],
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice:
          typeof choice === 'string'
            ? choice
            : { type: 'function', function: { name: choice.name } },
      };
      const response = await doFetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok) {
        throw new LlmError(`LLM request failed with status ${response.status}`, response.status);
      }
      const json = recordOf(await response.json());
      const choices = Array.isArray(json.choices) ? json.choices : [];
      const first = recordOf(choices[0]);
      const message = recordOf(first.message);
      const toolCalls: ToolUseBlock[] = [];
      for (const entry of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const call = recordOf(entry);
        const fn = recordOf(call.function);
        if (typeof call.id === 'string' && typeof fn.name === 'string') {
          toolCalls.push({
            type: 'tool_use',
            id: call.id,
            name: fn.name,
            input: parseArguments(fn.arguments),
          });
        }
      }
      const usage = recordOf(json.usage);
      const details = recordOf(usage.prompt_tokens_details);
      const promptTokens = numberOr(usage.prompt_tokens, 0);
      const cached = numberOr(details.cached_tokens, 0);
      return {
        text: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        stopReason: typeof first.finish_reason === 'string' ? first.finish_reason : 'unknown',
        usage: {
          // OpenAI-style prompt_tokens include the cached part; split it out.
          inputTokens: Math.max(0, promptTokens - cached),
          cachedInputTokens: cached,
          cacheWriteTokens: numberOr(details.cache_write_tokens, 0),
          outputTokens: numberOr(usage.completion_tokens, 0),
        },
      };
    },
  };
}
