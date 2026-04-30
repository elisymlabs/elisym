import type { ToolDef, ToolResult } from '@elisym/sdk/skills';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenAICompatibleProvider,
  OpenAICompatibleClient,
} from '../src/llm/providers/openai-compatible';

const originalFetch = globalThis.fetch;

interface MockResponseInit {
  status: number;
  body?: unknown;
}

function mockFetch(init: MockResponseInit): void {
  const ok = init.status >= 200 && init.status < 300;
  const bodyString = init.body === undefined ? '' : JSON.stringify(init.body);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: init.status,
    headers: new Headers(),
    body: { cancel: () => Promise.resolve() },
    text: () => Promise.resolve(bodyString),
    json: () => Promise.resolve(init.body),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const TEST_BASE_URL = 'https://example.test/v1';

function makeClient(): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    apiKey: 'sk-test',
    baseUrl: TEST_BASE_URL,
    model: 'mock-model',
    maxTokens: 256,
    providerLabel: 'TestProvider',
  });
}

describe('OpenAICompatibleClient.complete', () => {
  it('posts to /chat/completions with system + user messages and returns content', async () => {
    mockFetch({
      status: 200,
      body: { choices: [{ message: { content: 'hello' } }], usage: {} },
    });
    const client = makeClient();
    const result = await client.complete('sys', 'hi');
    expect(result).toBe('hello');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`${TEST_BASE_URL}/chat/completions`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('mock-model');
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('throws with provider label on non-2xx', async () => {
    mockFetch({ status: 400, body: { error: 'boom' } });
    const client = makeClient();
    await expect(client.complete('sys', 'hi')).rejects.toThrow(/TestProvider API error: 400/);
  });
});

describe('OpenAICompatibleClient.completeWithTools', () => {
  const tools: ToolDef[] = [
    {
      name: 'lookup',
      description: 'lookup a thing',
      parameters: [{ name: 'q', description: 'query', required: true }],
    },
  ];

  it('parses tool_calls into ToolCall[] with JSON-decoded arguments', async () => {
    mockFetch({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  function: { name: 'lookup', arguments: '{"q":"cats"}' },
                },
              ],
            },
          },
        ],
      },
    });
    const client = makeClient();
    const result = await client.completeWithTools('sys', [], tools);
    expect(result.type).toBe('tool_use');
    if (result.type === 'tool_use') {
      expect(result.calls).toEqual([{ id: 'call-1', name: 'lookup', arguments: { q: 'cats' } }]);
    }
  });

  it('falls back to text response when no tool_calls present', async () => {
    mockFetch({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'final answer' } }] },
    });
    const client = makeClient();
    const result = await client.completeWithTools('sys', [], tools);
    expect(result).toEqual({ type: 'text', text: 'final answer' });
  });

  it('handles malformed tool arguments gracefully', async () => {
    mockFetch({
      status: 200,
      body: {
        choices: [
          {
            message: {
              tool_calls: [{ id: 'c', function: { name: 'lookup', arguments: 'not-json' } }],
            },
          },
        ],
      },
    });
    const client = makeClient();
    const result = await client.completeWithTools('sys', [], tools);
    if (result.type === 'tool_use') {
      expect(result.calls[0].arguments).toEqual({});
    } else {
      throw new Error('expected tool_use result');
    }
  });
});

describe('OpenAICompatibleClient.formatToolResultMessages', () => {
  it('emits role:tool messages with tool_call_id', () => {
    const client = makeClient();
    const results: ToolResult[] = [
      { callId: 'c1', content: 'result-1' },
      { callId: 'c2', content: 'result-2' },
    ];
    expect(client.formatToolResultMessages(results)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'result-1' },
      { role: 'tool', tool_call_id: 'c2', content: 'result-2' },
    ]);
  });
});

describe('createOpenAICompatibleProvider verifyKey', () => {
  const provider = createOpenAICompatibleProvider({
    id: 'mock',
    displayName: 'Mock',
    envVar: 'MOCK_API_KEY',
    baseUrl: TEST_BASE_URL,
    defaultModel: 'mock-default',
    fallbackModels: ['mock-default'],
  });

  it('200 → ok', async () => {
    mockFetch({ status: 200, body: { data: [{ id: 'mock-default' }] } });
    expect(await provider.verifyKey('sk')).toEqual({ ok: true });
  });

  it('401 → invalid', async () => {
    mockFetch({ status: 401, body: { error: 'unauthorized' } });
    expect(await provider.verifyKey('bad')).toMatchObject({
      ok: false,
      reason: 'invalid',
      status: 401,
    });
  });

  it('503 → unavailable', async () => {
    mockFetch({ status: 503, body: { error: 'service unavailable' } });
    expect(await provider.verifyKey('sk')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('network error → unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND example.test'));
    const result = await provider.verifyKey('sk');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (!result.ok && result.reason === 'unavailable') {
      expect(result.error).toContain('ENOTFOUND');
    }
  });
});

describe('createOpenAICompatibleProvider verifyKeyDeep', () => {
  const provider = createOpenAICompatibleProvider({
    id: 'mock',
    displayName: 'Mock',
    envVar: 'MOCK_API_KEY',
    baseUrl: TEST_BASE_URL,
    defaultModel: 'mock-default',
    fallbackModels: ['mock-default'],
  });

  it('200 → ok and probes /chat/completions with max_tokens=1', async () => {
    mockFetch({ status: 200, body: { choices: [] } });
    const result = await provider.verifyKeyDeep('sk', 'mock-default');
    expect(result).toEqual({ ok: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`${TEST_BASE_URL}/chat/completions`);
    const body = JSON.parse(call[1].body);
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe('mock-default');
  });

  it('401 → invalid', async () => {
    mockFetch({ status: 401, body: { error: 'unauthorized' } });
    expect(await provider.verifyKeyDeep('bad', 'mock-default')).toMatchObject({
      ok: false,
      reason: 'invalid',
      status: 401,
    });
  });

  it('402 → billing', async () => {
    mockFetch({ status: 402, body: { error: 'payment required' } });
    expect(await provider.verifyKeyDeep('sk', 'mock-default')).toMatchObject({
      ok: false,
      reason: 'billing',
      status: 402,
    });
  });

  it('429 with insufficient_quota body → billing', async () => {
    mockFetch({
      status: 429,
      body: { error: { type: 'insufficient_quota', message: 'quota exceeded' } },
    });
    expect(await provider.verifyKeyDeep('sk', 'mock-default')).toMatchObject({
      ok: false,
      reason: 'billing',
      status: 429,
    });
  });

  it('429 without billing marker → unavailable', async () => {
    mockFetch({ status: 429, body: { error: 'rate_limit_exceeded' } });
    expect(await provider.verifyKeyDeep('sk', 'mock-default')).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('400 with credit balance marker → billing', async () => {
    mockFetch({ status: 400, body: { error: { message: 'Your credit balance is too low.' } } });
    expect(await provider.verifyKeyDeep('sk', 'mock-default')).toMatchObject({
      ok: false,
      reason: 'billing',
      status: 400,
    });
  });

  it('500 → unavailable', async () => {
    mockFetch({ status: 500, body: { error: 'server error' } });
    expect(await provider.verifyKeyDeep('sk', 'mock-default')).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('createOpenAICompatibleProvider fetchModels', () => {
  it('returns sorted ids on success', async () => {
    mockFetch({ status: 200, body: { data: [{ id: 'b-2' }, { id: 'a-1' }] } });
    const provider = createOpenAICompatibleProvider({
      id: 'mock',
      displayName: 'Mock',
      envVar: 'MOCK_API_KEY',
      baseUrl: TEST_BASE_URL,
      defaultModel: 'a-1',
      fallbackModels: ['a-1'],
    });
    expect(await provider.fetchModels('sk')).toEqual(['a-1', 'b-2']);
  });

  it('applies mapModelId to strip prefixes and drop non-matching entries', async () => {
    mockFetch({
      status: 200,
      body: {
        data: [
          { id: 'models/gemini-2.5-flash' },
          { id: 'models/text-embedding-004' },
          { id: 'gemini-2.0-flash' },
        ],
      },
    });
    const provider = createOpenAICompatibleProvider({
      id: 'mock',
      displayName: 'Mock',
      envVar: 'MOCK_API_KEY',
      baseUrl: TEST_BASE_URL,
      defaultModel: 'gemini-2.5-flash',
      fallbackModels: ['gemini-2.5-flash'],
      mapModelId: (id) => {
        const stripped = id.startsWith('models/') ? id.slice('models/'.length) : id;
        return stripped.startsWith('gemini') ? stripped : null;
      },
    });
    expect(await provider.fetchModels('sk')).toEqual(['gemini-2.0-flash', 'gemini-2.5-flash']);
  });

  it('falls back to fallbackModels on non-2xx', async () => {
    mockFetch({ status: 500, body: {} });
    const provider = createOpenAICompatibleProvider({
      id: 'mock',
      displayName: 'Mock',
      envVar: 'MOCK_API_KEY',
      baseUrl: TEST_BASE_URL,
      defaultModel: 'a',
      fallbackModels: ['a', 'b'],
    });
    expect(await provider.fetchModels('sk')).toEqual(['a', 'b']);
  });

  it('falls back on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = createOpenAICompatibleProvider({
      id: 'mock',
      displayName: 'Mock',
      envVar: 'MOCK_API_KEY',
      baseUrl: TEST_BASE_URL,
      defaultModel: 'a',
      fallbackModels: ['a'],
    });
    expect(await provider.fetchModels('sk')).toEqual(['a']);
  });
});
