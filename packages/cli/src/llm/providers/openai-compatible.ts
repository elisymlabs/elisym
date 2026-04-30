/**
 * Shared OpenAI-compatible client + descriptor factory.
 *
 * Powers providers that speak the OpenAI Chat Completions wire format
 * (xAI, Google's Gemini compat endpoint, DeepSeek). The native OpenAI
 * descriptor lives in `./openai.ts` and stays separate because it
 * carries OpenAI-specific reasoning-model quirks (`max_completion_tokens`,
 * `developer` role) the others don't need.
 */

import type {
  CompletionResult,
  LlmClient,
  ToolCall,
  ToolDef,
  ToolResult,
} from '@elisym/sdk/skills';
import type { CreateLlmClientConfig, LlmKeyVerification, LlmProviderDescriptor } from '../registry';
import { fetchWithRetry, fetchWithTimeout } from './http';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BILLING_MARKERS = ['credit balance', 'billing', 'insufficient_quota', 'insufficient'];

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIResponse {
  choices?: Array<{ message?: OpenAIMessage }>;
  usage?: OpenAIUsage;
}

interface OpenAICompatibleClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** Provider name used in error messages (e.g. "xAI", "Google", "DeepSeek"). */
  providerLabel: string;
  logUsage?: boolean;
}

export class OpenAICompatibleClient implements LlmClient {
  private totalIn = 0;
  private totalOut = 0;

  constructor(private readonly config: OpenAICompatibleClientConfig) {}

  private logTokens(usage: OpenAIUsage | undefined): void {
    if (!this.config.logUsage || !usage) {
      return;
    }
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    this.totalIn += inputTokens;
    this.totalOut += outputTokens;
    console.log(
      `  [LLM] ${this.config.model} tokens: in=${inputTokens} out=${outputTokens} (total: in=${this.totalIn} out=${this.totalOut})`,
    );
  }

  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    const response = await fetchWithRetry(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userInput },
          ],
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `${this.config.providerLabel} API error: ${response.status} ${await response.text()}`,
      );
    }
    const data = (await response.json()) as OpenAIResponse;
    this.logTokens(data.usage);
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

    const response = await fetchWithRetry(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          tools: openaiTools,
        }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `${this.config.providerLabel} API error: ${response.status} ${await response.text()}`,
      );
    }
    const data = (await response.json()) as OpenAIResponse;
    this.logTokens(data.usage);
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

export interface OpenAICompatibleProviderConfig {
  id: string;
  displayName: string;
  envVar: string;
  /** Base URL up to but not including `/chat/completions` or `/models`, no trailing slash. */
  baseUrl: string;
  defaultModel: string;
  fallbackModels: string[];
  /**
   * Optional transform applied to each `data[].id` returned by `/models`.
   * Returning `null` drops the entry. Use to strip prefixes (Gemini's
   * compat endpoint returns `models/<id>`) or filter non-chat models.
   */
  mapModelId?: (id: string) => string | null;
  /** Extra billing-detection markers concatenated with the shared defaults. */
  extraBillingMarkers?: string[];
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleProviderConfig,
): LlmProviderDescriptor {
  const billingMarkers = [...DEFAULT_BILLING_MARKERS, ...(config.extraBillingMarkers ?? [])];

  function bodyLooksLikeBilling(body: string): boolean {
    const lower = body.toLowerCase();
    return billingMarkers.some((marker) => lower.includes(marker));
  }

  async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const response = await fetchWithTimeout(
        `${config.baseUrl}/models`,
        { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
        signal,
      );
      if (!response.ok) {
        return config.fallbackModels;
      }
      const data = (await response.json()) as { data?: { id: string }[] };
      const transformed: string[] = [];
      for (const entry of data.data ?? []) {
        const mapped = config.mapModelId ? config.mapModelId(entry.id) : entry.id;
        if (mapped) {
          transformed.push(mapped);
        }
      }
      transformed.sort();
      return transformed.length > 0 ? transformed : config.fallbackModels;
    } catch {
      return config.fallbackModels;
    }
  }

  async function verifyKey(apiKey: string, signal?: AbortSignal): Promise<LlmKeyVerification> {
    try {
      const response = await fetchWithTimeout(
        `${config.baseUrl}/models`,
        { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
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

  async function verifyKeyDeep(
    apiKey: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmKeyVerification> {
    try {
      const response = await fetchWithTimeout(
        `${config.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: '.' }],
          }),
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
      if (response.status === 402) {
        return { ok: false, reason: 'billing', status: response.status, body };
      }
      if ((response.status === 400 || response.status === 429) && bodyLooksLikeBilling(body)) {
        return { ok: false, reason: 'billing', status: response.status, body };
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

  function createClient(clientConfig: CreateLlmClientConfig): LlmClient {
    return new OpenAICompatibleClient({
      apiKey: clientConfig.apiKey,
      baseUrl: config.baseUrl,
      model: clientConfig.model ?? config.defaultModel,
      maxTokens: clientConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
      providerLabel: config.displayName,
      logUsage: clientConfig.logUsage,
    });
  }

  return {
    id: config.id,
    displayName: config.displayName,
    envVar: config.envVar,
    defaultModel: config.defaultModel,
    fallbackModels: config.fallbackModels,
    fetchModels,
    verifyKey,
    verifyKeyDeep,
    createClient,
  };
}
