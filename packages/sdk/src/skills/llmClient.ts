import type { CompletionResult, LlmClient, ToolCall, ToolDef, ToolResult } from './types';

const LLM_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmClientConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

function createAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, signal);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (attempt >= MAX_RETRIES || name === 'AbortError') {
        throw error;
      }
      await sleepWithSignal(Math.min(1000 * 2 ** attempt, 8000), signal);
      continue;
    }
    if (response.ok || attempt >= MAX_RETRIES || !RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000 || 1000 * 2 ** attempt, 30_000)
      : Math.min(1000 * 2 ** attempt, 8000);
    // Release the unread body so the fetch connection/stream resources do
    // not linger across the retry sleep.
    await response.body?.cancel().catch(() => undefined);
    await sleepWithSignal(delay, signal);
  }
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

class AnthropicClient implements LlmClient {
  constructor(
    private readonly config: Required<Pick<LlmClientConfig, 'apiKey' | 'model' | 'maxTokens'>>,
  ) {}

  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    const response = await fetchWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userInput }],
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content?.find((block) => block.type === 'text');
    return textBlock?.text ?? '';
  }

  async completeWithTools(
    systemPrompt: string,
    messages: unknown[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const anthropicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map((param) => [
            param.name,
            { type: 'string', description: param.description },
          ]),
        ),
        required: tool.parameters.filter((param) => param.required).map((param) => param.name),
      },
    }));

    const response = await fetchWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: systemPrompt,
          messages,
          tools: anthropicTools,
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as AnthropicResponse;
    const content = data.content ?? [];

    const toolUses = content.filter((block) => block.type === 'tool_use');
    if (toolUses.length > 0) {
      const calls: ToolCall[] = toolUses.map((block) => ({
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.input ?? {},
      }));
      return {
        type: 'tool_use',
        calls,
        assistantMessage: { role: 'assistant', content },
      };
    }
    const textBlock = content.find((block) => block.type === 'text');
    return { type: 'text', text: textBlock?.text ?? '' };
  }

  formatToolResultMessages(results: ToolResult[]): unknown[] {
    return [
      {
        role: 'user',
        content: results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.callId,
          content: result.content,
        })),
      },
    ];
  }
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIResponse {
  choices?: Array<{ message?: OpenAIMessage }>;
}

class OpenAIClient implements LlmClient {
  constructor(
    private readonly config: Required<Pick<LlmClientConfig, 'apiKey' | 'model' | 'maxTokens'>>,
  ) {}

  private isReasoningModel(): boolean {
    return /^o\d/.test(this.config.model);
  }

  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    const reasoning = this.isReasoningModel();
    const response = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(reasoning
            ? { max_completion_tokens: this.config.maxTokens }
            : { max_tokens: this.config.maxTokens }),
          messages: [
            { role: reasoning ? 'developer' : 'system', content: systemPrompt },
            { role: 'user', content: userInput },
          ],
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as OpenAIResponse;
    return data.choices?.[0]?.message?.content ?? '';
  }

  async completeWithTools(
    systemPrompt: string,
    messages: unknown[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const openaiTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            tool.parameters.map((param) => [
              param.name,
              { type: 'string', description: param.description },
            ]),
          ),
          required: tool.parameters.filter((param) => param.required).map((param) => param.name),
        },
      },
    }));

    const reasoning = this.isReasoningModel();
    const response = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(reasoning
            ? { max_completion_tokens: this.config.maxTokens }
            : { max_tokens: this.config.maxTokens }),
          messages: [
            { role: reasoning ? 'developer' : 'system', content: systemPrompt },
            ...messages,
          ],
          tools: openaiTools,
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as OpenAIResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    if (toolCalls.length > 0) {
      const calls: ToolCall[] = toolCalls.map((call) => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: call.id ?? '', name: call.function?.name ?? '', arguments: args };
      });
      return { type: 'tool_use', calls, assistantMessage: message };
    }
    return { type: 'text', text: message?.content ?? '' };
  }

  formatToolResultMessages(results: ToolResult[]): unknown[] {
    return results.map((result) => ({
      role: 'tool',
      tool_call_id: result.callId,
      content: result.content,
    }));
  }
}

export function createAnthropicClient(config: Omit<LlmClientConfig, 'provider'>): LlmClient {
  if (!config.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for skill runtime');
  }
  return new AnthropicClient({
    apiKey: config.apiKey,
    model: config.model ?? DEFAULT_ANTHROPIC_MODEL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

export function createOpenAIClient(config: Omit<LlmClientConfig, 'provider'>): LlmClient {
  if (!config.apiKey) {
    throw new Error('OPENAI_API_KEY is required for skill runtime');
  }
  return new OpenAIClient({
    apiKey: config.apiKey,
    model: config.model ?? DEFAULT_OPENAI_MODEL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  if (config.provider === 'openai') {
    return createOpenAIClient(config);
  }
  return createAnthropicClient(config);
}
