import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import type { LlmProvider, TurnRequest, TurnResponse } from '../src/llm/types';
import {
  MAX_MODEL_CALLS_PER_TURN,
  MAX_TOOL_ROUNDS,
  StopReasonError,
  TurnError,
  runTurn,
} from '../src/turn';
import { NOW, catalog, toolCall } from './fixtures';

/**
 * Claude Haiku / Sonnet / Opus 5.5 (the Claude API reference): thinking is on by
 * default (Opus 5.5 cannot turn it off) and counts toward max_tokens; thinking
 * blocks are passed back unchanged within the conversation; sampling parameters
 * are rejected (Opus 5.5 always, Haiku and Sonnet 5.5 at non-default values);
 * stop_reason can be max_tokens or refusal.
 */

const USAGE = { input_tokens: 10, output_tokens: 3 };

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

/** A fetch that replays Anthropic Messages API bodies and records the requests. */
function anthropicFetch(replies: Record<string, unknown>[]) {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const doFetch: typeof fetch = async (_input, init) => {
    requests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { doFetch, requests };
}

const REQUEST: TurnRequest = { system: [{ text: 'S' }], messages: [], tools: [], maxTokens: 2_048 };

describe('the Anthropic adapter on models that think by default', () => {
  it('sends no sampling parameters, the 2023-06-01 version, and the caller max_tokens unraised', async () => {
    const { doFetch, requests } = anthropicFetch([
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: USAGE },
    ]);
    const provider = createAnthropicProvider({
      apiKey: 'k',
      model: 'claude-haiku-5-5',
      fetch: doFetch,
    });
    await provider.turn(REQUEST);
    await provider.turn({ ...REQUEST, maxTokens: 40_000 });
    const [small, large] = requests;
    expect(small?.headers.get('anthropic-version')).toBe('2023-06-01');
    // Never raised: the server sizes the turn's spend reservation on this ceiling.
    expect(small?.body.max_tokens).toBe(2_048);
    expect(large?.body.max_tokens).toBe(40_000);
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config']) {
      expect(small?.body, key).not.toHaveProperty(key);
    }
    expect(small?.body.tool_choice).toEqual({ type: 'auto' });
  });

  it('sends the configured effort in output_config', async () => {
    const { doFetch, requests } = anthropicFetch([
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: USAGE },
    ]);
    await createAnthropicProvider({
      apiKey: 'k',
      model: 'claude-opus-5-5',
      effort: 'low',
      fetch: doFetch,
    }).turn(REQUEST);
    expect(requests[0]?.body.output_config).toEqual({ effort: 'low' });
    expect(requests[0]?.body.max_tokens).toBe(2_048);
  });

  it('keeps thinking blocks, empty text included, in order with text and tool calls', async () => {
    const { doFetch } = anthropicFetch([
      {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'blob' },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'q' } },
        ],
        stop_reason: 'tool_use',
        usage: { ...USAGE, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
      },
    ]);
    const response = await createAnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-5-5',
      fetch: doFetch,
    }).turn(REQUEST);
    expect(response.assistantContent).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'blob' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'q' } },
    ]);
    expect(response.text).toBe('Looking.');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 7,
      cacheWriteTokens: 2,
      outputTokens: 3,
    });
  });

  it('runTurn sends the thinking blocks back unchanged with the tool results', async () => {
    const { doFetch, requests } = anthropicFetch([
      {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'wool' } },
        ],
        stop_reason: 'tool_use',
        usage: USAGE,
      },
      {
        content: [{ type: 'text', text: 'A wool jacket.' }],
        stop_reason: 'end_turn',
        usage: USAGE,
      },
    ]);
    const output = await runTurn(
      baseInput(createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', fetch: doFetch })),
    );
    expect(output.answer.text).toBe('A wool jacket.');
    const messages = requests[1]?.body.messages;
    expect(Array.isArray(messages) ? messages[1] : undefined).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'wool' } },
      ],
    });
  });
});

function stopping(stopReason: string, text: string): LlmProvider {
  return {
    model: 'stopping',
    turn: async (): Promise<TurnResponse> => ({
      text,
      toolCalls: [],
      stopReason,
      usage: { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 7 },
    }),
  };
}

describe('runTurn fails closed on a cut-off or declined response', () => {
  it.each([
    ['max_tokens', 'The model stopped at max_tokens (max_tokens)'],
    ['length', 'The model stopped at max_tokens (length)'],
    ['refusal', 'The model declined the request (refusal)'],
    ['content_filter', 'The model declined the request (content_filter)'],
  ])('%s is a turn error that keeps what was spent', async (stopReason, message) => {
    const error = await runTurn(baseInput(stopping(stopReason, 'A half'))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TurnError);
    expect(error instanceof TurnError ? error.message : '').toBe(message);
    expect(error instanceof TurnError ? error.usage.outputTokens : 0).toBe(7);
  });

  it('end_turn and tool_use go on as before', async () => {
    expect((await runTurn(baseInput(stopping('end_turn', 'Hello.')))).answer.text).toBe('Hello.');
  });
});

describe('the price-check correction replays the answer turn', () => {
  it('as returned, thinking included', async () => {
    const requests: TurnRequest[] = [];
    let call = 0;
    const provider: LlmProvider = {
      model: 'thinking',
      turn: async (request) => {
        requests.push(request);
        call += 1;
        const text = call === 1 ? 'It is $99 today.' : 'See the card.';
        return {
          text,
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
          assistantContent: [
            { type: 'thinking', thinking: '', signature: `sig-${call}` },
            { type: 'text', text },
          ],
        };
      },
    };
    await runTurn(baseInput(provider));
    const replayed = requests[1]?.messages.at(-2);
    expect(replayed).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'text', text: 'It is $99 today.' },
      ],
    });
  });

  it('rebuilt from text when the forced round still called a tool (a tool_use needs its result)', async () => {
    const requests: TurnRequest[] = [];
    const provider: LlmProvider = {
      model: 'stubborn',
      turn: async (request) => {
        requests.push(request);
        const call = toolCall('search_products', { query: 'x' });
        return {
          text: request.toolChoice === 'none' ? 'Only $99.' : '',
          toolCalls: [call],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
          assistantContent: [{ type: 'thinking', thinking: '', signature: 'sig' }, call],
        };
      },
    };
    await runTurn(baseInput(provider)).catch(() => undefined);
    const correction = requests.find((request) =>
      JSON.stringify(request.messages.at(-1)).includes('not prices of the products'),
    );
    expect(correction?.messages.at(-2)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Only $99.' }],
    });
  });
});

describe('a turn makes at most MAX_MODEL_CALLS_PER_TURN model calls', () => {
  function counting(
    textFor: (call: number, forced: boolean) => string,
    tools: (call: number) => boolean,
  ) {
    let calls = 0;
    const provider: LlmProvider = {
      model: 'counting',
      turn: async (request) => {
        calls += 1;
        const forced = request.toolChoice === 'none';
        return {
          text: textFor(calls, forced),
          toolCalls: !forced && tools(calls) ? [toolCall('search_products', { query: 'x' })] : [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        };
      },
    };
    return { provider, calls: () => calls };
  }

  it('every tool round in the first loop, then the price-check re-run', async () => {
    const run = counting(
      () => 'Only $99.',
      () => true,
    );
    await runTurn(baseInput(run.provider));
    expect(MAX_MODEL_CALLS_PER_TURN).toBe(MAX_TOOL_ROUNDS + 2);
    expect(run.calls()).toBe(MAX_MODEL_CALLS_PER_TURN);
  });

  it('no tool round first, every tool round in the re-run', async () => {
    const run = counting(
      () => 'Only $99.',
      (call) => call > 1,
    );
    await runTurn(baseInput(run.provider));
    expect(run.calls()).toBe(MAX_MODEL_CALLS_PER_TURN);
  });
});

describe('review round 4: replay and stop reasons', () => {
  it('replays redacted thinking and non-empty thinking text unchanged through runTurn', async () => {
    const { doFetch, requests } = anthropicFetch([
      {
        content: [
          { type: 'thinking', thinking: 'The visitor wants wool.', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque-blob' },
          { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'wool' } },
        ],
        stop_reason: 'tool_use',
        usage: USAGE,
      },
      {
        content: [{ type: 'text', text: 'A wool jacket.' }],
        stop_reason: 'end_turn',
        usage: USAGE,
      },
    ]);
    await runTurn(
      baseInput(createAnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', fetch: doFetch })),
    );
    const messages = requests[1]?.body.messages;
    expect(Array.isArray(messages) ? messages[1] : undefined).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The visitor wants wool.', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque-blob' },
        { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'wool' } },
      ],
    });
  });

  it('a thinking-only answer turn gets a (no text) block before the correction', async () => {
    const requests: TurnRequest[] = [];
    let call = 0;
    const provider: LlmProvider = {
      model: 'thinking-only',
      turn: async (request) => {
        requests.push(request);
        call += 1;
        return {
          text: call === 1 ? '' : 'Fine.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
          assistantContent:
            call === 1
              ? [{ type: 'thinking', thinking: '', signature: 'sig' }]
              : [{ type: 'text', text: 'Fine.' }],
        };
      },
    };
    // A card with an invented price in its reason makes the price check ask for a correction.
    const presenting: LlmProvider = {
      model: 'presenting',
      turn: async (request) => {
        if (request.messages.length === 1) {
          return {
            text: '',
            toolCalls: [
              toolCall('present_products', { picks: [{ id: 'jacket-wool', reason: 'only $99' }] }),
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
          };
        }
        return provider.turn(request);
      },
    };
    await runTurn(baseInput(presenting));
    const correction = requests.find((request) =>
      JSON.stringify(request.messages.at(-1)).includes('not prices of the products'),
    );
    expect(correction?.messages.at(-2)).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: '(no text)' },
      ],
    });
  });

  it.each(['model_context_window_exceeded', 'pause_turn', 'unknown'])(
    'an unknown stop reason (%s) ends the turn instead of publishing its text',
    async (stopReason) => {
      const error = await runTurn(baseInput(stopping(stopReason, 'Half an answer'))).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TurnError);
      expect(error instanceof TurnError ? error.reason : undefined).toBeInstanceOf(StopReasonError);
      expect(error instanceof TurnError ? error.message : '').toBe(
        `The model stopped without an answer (${stopReason})`,
      );
    },
  );

  it.each(['end_turn', 'stop_sequence', 'stop'])('%s is an answer', async (stopReason) => {
    expect((await runTurn(baseInput(stopping(stopReason, 'Hello.')))).answer.text).toBe('Hello.');
  });

  it('the stop error says its kind', () => {
    expect(new StopReasonError('max_tokens').kind).toBe('max_tokens');
    expect(new StopReasonError('length').kind).toBe('max_tokens');
    expect(new StopReasonError('refusal').kind).toBe('refusal');
    expect(new StopReasonError('content_filter').kind).toBe('refusal');
    expect(new StopReasonError('whatever').kind).toBe('other');
  });

  it('the adapter sends only auto or none as tool_choice', async () => {
    const { doFetch, requests } = anthropicFetch([
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: USAGE },
    ]);
    const provider = createAnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-5-5',
      fetch: doFetch,
    });
    await provider.turn({ ...REQUEST, toolChoice: 'none' });
    expect(requests[0]?.body.tool_choice).toEqual({ type: 'none' });
  });
});
