import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicClient, createOpenAIClient } from '../../src/skills/llmClient';

type FetchMock = ReturnType<typeof vi.fn>;

let originalFetch: typeof fetch;
let fetchMock: FetchMock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'application/json' },
  });
}

describe('createAnthropicClient', () => {
  it('throws when API key is missing', () => {
    expect(() => createAnthropicClient({ apiKey: '' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('parses a plain text completion', async () => {
    fetchMock.mockResolvedValueOnce(respond({ content: [{ type: 'text', text: 'hi' }] }));
    const client = createAnthropicClient({ apiKey: 'sk-test', model: 'claude-sonnet-4' });
    const out = await client.complete('sys', 'hello');
    expect(out).toBe('hi');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init as { headers: Record<string, string> }).headers['x-api-key']).toBe('sk-test');
  });

  it('maps a tool_use response into CompletionResult.calls', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'fetch_transcript',
            input: { url: 'https://youtu.be/abc' },
          },
        ],
      }),
    );
    const client = createAnthropicClient({ apiKey: 'sk-test' });
    const result = await client.completeWithTools(
      'sys',
      [{ role: 'user', content: 'hi' }],
      [
        {
          name: 'fetch_transcript',
          description: 'x',
          parameters: [{ name: 'url', description: 'url', required: true }],
        },
      ],
    );
    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') {
      return;
    }
    expect(result.calls).toEqual([
      { id: 'toolu_1', name: 'fetch_transcript', arguments: { url: 'https://youtu.be/abc' } },
    ]);
  });

  it('throws on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('boom', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const client = createAnthropicClient({ apiKey: 'sk-test' });
    await expect(client.complete('sys', 'hi')).rejects.toThrow(/Anthropic API error: 401/);
  });

  it('formats tool_result into a single user message', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test' });
    expect(
      client.formatToolResultMessages([
        { callId: 'id-1', content: 'out1' },
        { callId: 'id-2', content: 'out2' },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'id-1', content: 'out1' },
          { type: 'tool_result', tool_use_id: 'id-2', content: 'out2' },
        ],
      },
    ]);
  });
});

describe('createOpenAIClient', () => {
  it('throws when API key is missing', () => {
    expect(() => createOpenAIClient({ apiKey: '' })).toThrow(/OPENAI_API_KEY/);
  });

  it('maps tool_calls to CompletionResult.calls and parses JSON args', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'echo', arguments: '{"text":"hi"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const client = createOpenAIClient({ apiKey: 'sk-oa' });
    const result = await client.completeWithTools(
      'sys',
      [{ role: 'user', content: 'x' }],
      [
        {
          name: 'echo',
          description: 'echo',
          parameters: [{ name: 'text', description: 'text', required: true }],
        },
      ],
    );
    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') {
      return;
    }
    expect(result.calls[0]).toEqual({ id: 'call_1', name: 'echo', arguments: { text: 'hi' } });
  });

  it('formats tool results as role: tool messages', () => {
    const client = createOpenAIClient({ apiKey: 'sk-oa' });
    expect(client.formatToolResultMessages([{ callId: 'call_1', content: 'done' }])).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ]);
  });
});
