import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { createOpenAiCompatibleProvider } from '../src/llm/openai-compatible';
import type { LlmProvider, TurnRequest } from '../src/llm/types';
import { MAX_TOOL_ROUNDS, StopReasonError, TurnError, runTurn } from '../src/turn';
import { NOW, catalog } from './fixtures';

function baseInput(provider: LlmProvider) {
  return {
    catalog: catalog(),
    provider,
    history: [],
    askId: 'a'.repeat(32),
    text: 'something warm',
    sessionEnd: NOW + 3_600,
    now: NOW,
    earlierVisitorMessages: [],
    earlierPolicyPassages: [],
  };
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
}

const OPENAI_USAGE = { prompt_tokens: 10, completion_tokens: 2 };

describe('the OpenAI-compatible adapter in a tool loop', () => {
  it('runs tool rounds on finish_reason tool_calls, then sends tool_choice none on the forced round', async () => {
    const choices: unknown[] = [];
    const doFetch: typeof fetch = async (_input, init) => {
      const body = bodyOf(init);
      choices.push(body.tool_choice);
      const reply =
        body.tool_choice === 'none'
          ? {
              choices: [{ message: { content: 'A wool jacket.' }, finish_reason: 'stop' }],
              usage: OPENAI_USAGE,
            }
          : {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `call_${choices.length}`,
                        type: 'function',
                        function: { name: 'search_products', arguments: '{"query":"wool"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: OPENAI_USAGE,
            };
      return new Response(JSON.stringify(reply), { status: 200 });
    };
    const output = await runTurn(
      baseInput(
        createOpenAiCompatibleProvider({
          apiKey: 'k',
          model: 'deepseek/deepseek-chat',
          baseUrl: 'https://openrouter.ai/api/v1',
          fetch: doFetch,
        }),
      ),
    );
    expect(output.answer.text).toBe('A wool jacket.');
    expect(choices).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(choices.slice(0, MAX_TOOL_ROUNDS).every((choice) => choice === 'auto')).toBe(true);
    expect(choices.at(-1)).toBe('none');
  });
});

describe('an adapter that gets no stop reason fails the turn closed', () => {
  async function stopKindOf(provider: LlmProvider): Promise<string | undefined> {
    const error = await runTurn(baseInput(provider)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TurnError);
    const reason = error instanceof TurnError ? error.reason : undefined;
    expect(reason).toBeInstanceOf(StopReasonError);
    return reason instanceof StopReasonError ? reason.kind : undefined;
  }

  it('Anthropic with no stop_reason', async () => {
    const doFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Half' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    expect(
      await stopKindOf(createAnthropicProvider({ apiKey: 'k', model: 'm', fetch: doFetch })),
    ).toBe('other');
  });

  it('OpenAI-compatible with finish_reason null', async () => {
    const doFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Half' }, finish_reason: null }],
          usage: OPENAI_USAGE,
        }),
        { status: 200 },
      );
    expect(
      await stopKindOf(
        createOpenAiCompatibleProvider({
          apiKey: 'k',
          model: 'm',
          baseUrl: 'https://example.invalid/v1',
          fetch: doFetch,
        }),
      ),
    ).toBe('other');
  });
});

describe('a price-check re-run that stops without an answer', () => {
  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded'])(
    'falls back to the first answer, stripped, its spend counted (%s)',
    async (stopReason) => {
      const requests: TurnRequest[] = [];
      const provider: LlmProvider = {
        model: 'stopping-retry',
        turn: async (request) => {
          requests.push(request);
          const retry = requests.length > 1;
          return {
            text: retry ? 'Half' : 'It is on sale for $99. Warm wool.',
            toolCalls: [],
            stopReason: retry ? stopReason : 'end_turn',
            usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
          };
        },
      };
      const output = await runTurn(baseInput(provider));
      expect(requests).toHaveLength(2);
      expect(output.modelCalls).toBe(2);
      expect(output.usage.outputTokens).toBe(10);
      expect(output.answer.text).not.toContain('$99');
      expect(output.answer.text).toContain('Warm wool.');
      expect(output.stripped.length).toBeGreaterThan(0);
    },
  );
});
