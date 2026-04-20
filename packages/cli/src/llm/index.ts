/**
 * LLM client - supports Anthropic and OpenAI with tool-use.
 */
import type { LlmClient, ToolDef, CompletionResult, ToolCall, ToolResult } from '../skill/index.js';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Log token usage to console after each API call. Default: false. */
  logUsage?: boolean;
}

const LLM_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Create an AbortError compatible with Node 18 (no DOMException in types). */
function createAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Sleep that can be cancelled by an AbortSignal. Cleans up listeners in all paths. */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  if (!signal) {
    return new Promise((r) => setTimeout(r, ms));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
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

/** Fetch with timeout + abort signal. Node 18 compatible (no AbortSignal.any). */
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
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Fetch with timeout + retry on transient HTTP/network errors. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, init, signal);
    } catch (e: any) {
      // Network errors (DNS, ECONNRESET, etc.) - retry unless abort or exhausted
      if (attempt >= MAX_RETRIES || e.name === 'AbortError') {
        throw e;
      }
      await sleepWithSignal(Math.min(1000 * 2 ** attempt, 8000), signal);
      continue;
    }
    if (res.ok || attempt >= MAX_RETRIES || !RETRYABLE_STATUSES.has(res.status)) {
      return res;
    }
    const retryAfter = res.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000 || 1000 * 2 ** attempt, 30_000)
      : Math.min(1000 * 2 ** attempt, 8000);
    await sleepWithSignal(delay, signal);
  }
}

/**
 * OpenAI reasoning / GPT-5 family detector. These models require
 * `max_completion_tokens` instead of `max_tokens` and `developer` role
 * instead of `system`. Matches o-series (o1/o3/o4/...) and gpt-5 family
 * (gpt-5, gpt-5.4, gpt-5-mini, ...).
 */
function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || /^gpt-5(\b|[-.])/.test(model);
}

export function createLlmClient(config: LlmConfig): LlmClient {
  if (config.provider === 'anthropic') {
    return new AnthropicClient(config);
  }
  return new OpenAIClient(config);
}

export type LlmKeyVerification =
  | { ok: true }
  | { ok: false; reason: 'invalid'; status: number; body: string }
  | { ok: false; reason: 'unavailable'; error: string };

/**
 * Verify that an LLM API key is accepted by the provider before the agent
 * publishes capabilities. Uses `GET /v1/models` - free, authenticated, and
 * returns 401/403 when the key is invalid.
 */
export async function verifyLlmApiKey(
  provider: LlmProvider,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmKeyVerification> {
  const url =
    provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/models?limit=1'
      : 'https://api.openai.com/v1/models';
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` };

  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, signal);
    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true };
    }
    const body = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'invalid', status: res.status, body };
    }
    return { ok: false, reason: 'unavailable', error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { ok: false, reason: 'unavailable', error: e?.message ?? String(e) };
  }
}

class AnthropicClient implements LlmClient {
  private totalIn = 0;
  private totalOut = 0;

  constructor(private config: LlmConfig) {}

  private logTokens(usage: any): void {
    if (this.config.logUsage && usage) {
      this.totalIn += usage.input_tokens ?? 0;
      this.totalOut += usage.output_tokens ?? 0;
      console.log(
        `  [LLM] ${this.config.model} tokens: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} (total: in=${this.totalIn} out=${this.totalOut})`,
      );
    }
  }

  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    const res = await fetchWithRetry(
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

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    this.logTokens(data.usage);
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  async completeWithTools(
    systemPrompt: string,
    messages: any[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          t.parameters.map((p) => [p.name, { type: 'string', description: p.description }]),
        ),
        required: t.parameters.filter((p) => p.required).map((p) => p.name),
      },
    }));

    const res = await fetchWithRetry(
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

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    this.logTokens(data.usage);
    const content = data.content ?? [];

    const toolUses = content.filter((b: any) => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const calls: ToolCall[] = toolUses.map((t: any) => ({
        id: t.id,
        name: t.name,
        arguments: t.input ?? {},
      }));
      return {
        type: 'tool_use',
        calls,
        assistantMessage: { role: 'assistant', content },
      };
    }

    const textBlock = content.find((b: any) => b.type === 'text');
    return { type: 'text', text: textBlock?.text ?? '' };
  }

  formatToolResultMessages(results: ToolResult[]): any[] {
    return [
      {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.callId,
          content: r.content,
        })),
      },
    ];
  }
}

class OpenAIClient implements LlmClient {
  private totalIn = 0;
  private totalOut = 0;

  constructor(private config: LlmConfig) {}

  private logTokens(usage: any): void {
    if (this.config.logUsage && usage) {
      this.totalIn += usage.prompt_tokens ?? 0;
      this.totalOut += usage.completion_tokens ?? 0;
      console.log(
        `  [LLM] ${this.config.model} tokens: in=${usage.prompt_tokens ?? 0} out=${usage.completion_tokens ?? 0} (total: in=${this.totalIn} out=${this.totalOut})`,
      );
    }
  }

  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    const isReasoning = isReasoningModel(this.config.model);
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(isReasoning
            ? { max_completion_tokens: this.config.maxTokens }
            : { max_tokens: this.config.maxTokens }),
          messages: [
            { role: isReasoning ? 'developer' : 'system', content: systemPrompt },
            { role: 'user', content: userInput },
          ],
        }),
      },
      signal,
    );

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    this.logTokens(data.usage);
    return data.choices?.[0]?.message?.content ?? '';
  }

  async completeWithTools(
    systemPrompt: string,
    messages: any[],
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const openaiTools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            t.parameters.map((p) => [p.name, { type: 'string', description: p.description }]),
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      },
    }));

    const isReasoning = isReasoningModel(this.config.model);
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(isReasoning
            ? { max_completion_tokens: this.config.maxTokens }
            : { max_tokens: this.config.maxTokens }),
          messages: [
            { role: isReasoning ? 'developer' : 'system', content: systemPrompt },
            ...messages,
          ],
          tools: openaiTools,
        }),
      },
      signal,
    );

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    this.logTokens(data.usage);
    const message = data.choices?.[0]?.message;

    if (message?.tool_calls?.length > 0) {
      const calls: ToolCall[] = message.tool_calls.map((tc: any) => {
        let args: Record<string, any>;
        try {
          args = JSON.parse(tc.function.arguments ?? '{}');
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.function.name, arguments: args };
      });
      return {
        type: 'tool_use',
        calls,
        assistantMessage: message,
      };
    }

    return { type: 'text', text: message?.content ?? '' };
  }

  formatToolResultMessages(results: ToolResult[]): any[] {
    return results.map((r) => ({
      role: 'tool',
      tool_call_id: r.callId,
      content: r.content,
    }));
  }
}
