/**
 * Anthropic provider descriptor + client.
 *
 * Exports a pure `LlmProviderDescriptor`; `../registry.ts` imports it
 * statically and registers it at module init. Imports from the registry
 * are type-only to keep the dependency edge one-way.
 */

import type {
  CompletionResult,
  LlmClient,
  ToolCall,
  ToolDef,
  ToolResult,
} from '@elisym/sdk/skills';
import type { LlmKeyVerification, LlmProviderDescriptor } from '../registry';
import { fetchWithRetry, fetchWithTimeout } from './http';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 4096;
const FALLBACK_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'];

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
}

interface AnthropicClientConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  logUsage?: boolean;
}

export class AnthropicClient implements LlmClient {
  private totalIn = 0;
  private totalOut = 0;

  constructor(private readonly config: AnthropicClientConfig) {}

  private logTokens(usage: AnthropicUsage | undefined): void {
    if (!this.config.logUsage || !usage) {
      return;
    }
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    this.totalIn += inputTokens;
    this.totalOut += outputTokens;
    console.log(
      `  [LLM] ${this.config.model} tokens: in=${inputTokens} out=${outputTokens} (total: in=${this.totalIn} out=${this.totalOut})`,
    );
  }

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
    this.logTokens(data.usage);
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
    this.logTokens(data.usage);
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

async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/models?limit=1000',
      {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      },
      signal,
    );
    if (!response.ok) {
      return FALLBACK_MODELS;
    }
    const data = (await response.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((entry) => entry.id).sort();
    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

async function verifyKey(apiKey: string, signal?: AbortSignal): Promise<LlmKeyVerification> {
  try {
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/models?limit=1',
      {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      },
      signal,
    );
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true };
    }
    const body = (await response.text().catch(() => '')).slice(0, 500);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid', status: response.status, body };
    }
    return {
      ok: false,
      reason: 'unavailable',
      error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'unavailable', error: message };
  }
}

export const ANTHROPIC_PROVIDER: LlmProviderDescriptor = {
  id: 'anthropic',
  displayName: 'Anthropic (Claude)',
  envVar: 'ANTHROPIC_API_KEY',
  defaultModel: DEFAULT_MODEL,
  fallbackModels: FALLBACK_MODELS,
  fetchModels,
  verifyKey,
  createClient: (config) =>
    new AnthropicClient({
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      logUsage: config.logUsage,
    }),
};
