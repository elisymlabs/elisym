import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { createOpenAiCompatibleProvider } from '../src/llm/openai-compatible';
import { costOf } from '../src/llm/types';
import { MAX_TOOL_ROUNDS, runTurn } from '../src/turn';
import { CATALOG_KEY, NOW, catalog, scripted, toolCall } from './fixtures';

function baseInput(provider: ReturnType<typeof scripted>['provider']) {
  return {
    catalog: catalog(),
    provider,
    history: [],
    askId: 'a'.repeat(32),
    text: 'something warm under $130',
    pageUrl: 'https://shop.example.com/products/scarf',
    locale: 'en-US',
    sessionEnd: NOW + 3_600,
    now: NOW,
    earlierVisitorMessages: [],
    earlierPolicyPassages: [],
  };
}

describe('runTurn', () => {
  it('searches, presents and answers, with cached prefix blocks and page context', async () => {
    const statuses: string[] = [];
    const { provider, requests } = scripted([
      {
        calls: [toolCall('search_products', { query: 'warm', status: 'looking for warm things' })],
      },
      {
        calls: [
          toolCall('present_products', { picks: [{ id: 'jacket-wool', reason: 'warm wool' }] }),
        ],
      },
      { text: 'This wool jacket is the warmest pick.' },
    ]);
    const output = await runTurn({
      ...baseInput(provider),
      onStatus: (line) => statuses.push(line),
    });
    expect(output.answer.text).toBe('This wool jacket is the warmest pick.');
    expect(output.answer.components).toEqual([
      {
        type: 'products',
        picks: [{ address: `30402:${CATALOG_KEY}:jacket-wool`, reason: 'warm wool' }],
      },
    ]);
    expect(output.answer.session_end).toBe(NOW + 3_600);
    expect(statuses).toEqual(['looking for warm things']);
    expect(output.modelCalls).toBe(3);
    const system = requests[0]?.system ?? [];
    expect(system[0]?.cache).toBe(true);
    expect(system[1]?.cache).toBe(true);
    expect(system[2]?.cache).toBeFalsy();
    expect(system[2]?.text).toContain('scarf');
    expect(output.history).toHaveLength(2);
  });

  it('forces a no-tool round after the tool round cap', async () => {
    const { provider, requests } = scripted([
      { text: 'still looking', calls: [toolCall('search_products', { query: 'x' })] },
    ]);
    await runTurn(baseInput(provider));
    expect(requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(requests.at(-1)?.toolChoice).toBe('none');
  });

  it('re-runs once on an invented price, then strips it', async () => {
    const { provider, requests } = scripted([
      { calls: [toolCall('present_products', { picks: [{ id: 'jacket-wool' }] })] },
      { text: 'It is on sale for $99. Great choice.' },
    ]);
    const output = await runTurn(baseInput(provider));
    // First loop: 2 calls; re-run loop: present again then the same text.
    expect(requests.length).toBeGreaterThan(2);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('not prices of the products');
    expect(output.answer.text).toBe('Great choice.');
    expect(output.stripped).toHaveLength(1);
  });
});

describe('providers', () => {
  it('maps the Anthropic request and response, with cache marks', async () => {
    let body: Record<string, unknown> = {};
    const provider = createAnthropicProvider({
      apiKey: 'k',
      model: 'claude-test',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'hi' },
              { type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'q' } },
            ],
            stop_reason: 'tool_use',
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 90,
              cache_creation_input_tokens: 5,
              output_tokens: 3,
            },
          }),
        );
      },
    });
    const response = await provider.turn({
      system: [{ text: 'g', cache: true }, { text: 's' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [{ name: 'search_products', description: 'd', inputSchema: { type: 'object' } }],
      toolChoice: 'none',
      maxTokens: 10,
    });
    expect(body.system).toEqual([
      { type: 'text', text: 'g', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 's' },
    ]);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(response.toolCalls[0]?.name).toBe('search_products');
    expect(response.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 90,
      cacheWriteTokens: 5,
      outputTokens: 3,
    });
  });

  it('maps the OpenAI-compatible request, tool results and usage split', async () => {
    let body: Record<string, unknown> = {};
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'k',
      model: 'deepseek-chat',
      baseUrl: 'https://api.example.com/v1/',
      extraBody: { provider: { data_collection: 'deny' } },
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.example.com/v1/chat/completions');
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 60 },
            },
          }),
        );
      },
    });
    const response = await provider.turn({
      system: [{ text: 'g', cache: true }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c0', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c0', content: 'r' }] },
      ],
      tools: [],
      maxTokens: 10,
    });
    expect(body.provider).toEqual({ data_collection: 'deny' });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'g' });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'r' });
    expect(response.toolCalls[0]?.input).toEqual({ a: 1 });
    expect(response.usage.inputTokens).toBe(40);
    expect(response.usage.cachedInputTokens).toBe(60);
  });

  it('prices usage exactly', () => {
    const cost = costOf(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        cacheWriteTokens: 0,
        outputTokens: 500_000,
      },
      { input: '3', cachedInput: '0.3', cacheWrite: '3.75', output: '15' },
    );
    expect(cost.toString()).toBe('11.1');
  });
});
