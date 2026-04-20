import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLlmClient, verifyLlmApiKey } from '../src/llm/index.js';

const originalFetch = globalThis.fetch;

function mockFetch(response: any, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createLlmClient', () => {
  it('returns Anthropic client for anthropic provider', () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      maxTokens: 1024,
    });
    expect(client).toBeDefined();
    expect(client.complete).toBeTypeOf('function');
    expect(client.completeWithTools).toBeTypeOf('function');
  });

  it('returns OpenAI client for openai provider', () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      maxTokens: 1024,
    });
    expect(client).toBeDefined();
    expect(client.complete).toBeTypeOf('function');
  });
});

describe('AnthropicClient', () => {
  describe('complete', () => {
    it('sends correct API request', async () => {
      const client = createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        maxTokens: 512,
      });

      mockFetch({
        content: [{ type: 'text', text: 'Hello from Claude' }],
      });

      const result = await client.complete('You are helpful', 'Say hello');

      expect(result).toBe('Hello from Claude');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-test',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.max_tokens).toBe(512);
      expect(body.system).toBe('You are helpful');
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
    });

    it('throws on API error', async () => {
      const client = createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        maxTokens: 512,
      });

      mockFetch({ error: 'unauthorized' }, 401);

      await expect(client.complete('sys', 'input')).rejects.toThrow('Anthropic API error: 401');
    });
  });

  describe('completeWithTools', () => {
    it('returns text response', async () => {
      const client = createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        maxTokens: 512,
      });

      mockFetch({
        content: [{ type: 'text', text: 'No tools needed' }],
      });

      const result = await client.completeWithTools(
        'system',
        [{ role: 'user', content: 'hello' }],
        [{ name: 'search', description: 'Search', parameters: [] }],
      );

      expect(result.type).toBe('text');
      expect(result.type === 'text' && result.text).toBe('No tools needed');
    });

    it('returns tool_use response', async () => {
      const client = createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        maxTokens: 512,
      });

      mockFetch({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'search',
            input: { query: 'test' },
          },
        ],
      });

      const result = await client.completeWithTools(
        'system',
        [{ role: 'user', content: 'search for test' }],
        [
          {
            name: 'search',
            description: 'Search',
            parameters: [{ name: 'query', description: 'Query', required: true }],
          },
        ],
      );

      expect(result.type).toBe('tool_use');
      if (result.type === 'tool_use') {
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0].name).toBe('search');
        expect(result.calls[0].arguments).toEqual({ query: 'test' });
      }
    });
  });
});

describe('OpenAIClient', () => {
  describe('complete', () => {
    it('sends correct API request for standard model', async () => {
      const client = createLlmClient({
        provider: 'openai',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      mockFetch({
        choices: [{ message: { content: 'Hello from GPT' } }],
      });

      const result = await client.complete('You are helpful', 'Say hello');

      expect(result).toBe('Hello from GPT');

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o');
      expect(body.max_tokens).toBe(1024);
      expect(body.messages[0].role).toBe('system');
    });

    it('uses developer role for reasoning models', async () => {
      const client = createLlmClient({
        provider: 'openai',
        apiKey: 'sk-openai',
        model: 'o3-mini',
        maxTokens: 1024,
      });

      mockFetch({
        choices: [{ message: { content: 'Reasoning result' } }],
      });

      await client.complete('You are helpful', 'Think about this');

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.messages[0].role).toBe('developer');
      expect(body.max_completion_tokens).toBe(1024);
      expect(body.max_tokens).toBeUndefined();
    });

    it('throws on API error', async () => {
      const client = createLlmClient({
        provider: 'openai',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      mockFetch({ error: 'unauthorized' }, 401);

      await expect(client.complete('sys', 'input')).rejects.toThrow('OpenAI API error: 401');
    });
  });

  describe('completeWithTools', () => {
    it('returns tool_calls response', async () => {
      const client = createLlmClient({
        provider: 'openai',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      mockFetch({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_1',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"NYC"}',
                  },
                },
              ],
            },
          },
        ],
      });

      const result = await client.completeWithTools(
        'system',
        [{ role: 'user', content: 'weather in NYC' }],
        [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: [{ name: 'city', description: 'City', required: true }],
          },
        ],
      );

      expect(result.type).toBe('tool_use');
      if (result.type === 'tool_use') {
        expect(result.calls[0].name).toBe('get_weather');
        expect(result.calls[0].arguments).toEqual({ city: 'NYC' });
      }
    });

    it('returns text when no tool calls', async () => {
      const client = createLlmClient({
        provider: 'openai',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      mockFetch({
        choices: [{ message: { content: 'No tools needed' } }],
      });

      const result = await client.completeWithTools(
        'system',
        [{ role: 'user', content: 'hello' }],
        [],
      );

      expect(result.type).toBe('text');
      if (result.type === 'text') {
        expect(result.text).toBe('No tools needed');
      }
    });
  });
});

describe('formatToolResultMessages', () => {
  it('Anthropic formats as user message with tool_result array', () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    const results = client.formatToolResultMessages([
      { callId: 'call_1', content: 'result 1' },
      { callId: 'call_2', content: 'result 2' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].role).toBe('user');
    expect(results[0].content).toHaveLength(2);
    expect(results[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'result 1',
    });
    expect(results[0].content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_2',
      content: 'result 2',
    });
  });

  it('OpenAI formats as separate tool role messages', () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      maxTokens: 512,
    });

    const results = client.formatToolResultMessages([
      { callId: 'call_1', content: 'result 1' },
      { callId: 'call_2', content: 'result 2' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result 1' });
    expect(results[1]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'result 2' });
  });
});

describe('retry on transient errors', () => {
  it('retries on 429 then succeeds', async () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '0' }),
          text: () => Promise.resolve('rate limited'),
          json: () => Promise.resolve({ error: 'rate limited' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })),
        json: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
      });
    });

    const result = await client.complete('sys', 'input');
    expect(result).toBe('ok');
    expect(callCount).toBe(2);
  });

  it('retries on network error (fetch throw)', async () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: [{ type: 'text', text: 'recovered' }] }),
      });
    });

    const result = await client.complete('sys', 'input');
    expect(result).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('does not retry on AbortError', async () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    });

    await expect(client.complete('sys', 'input')).rejects.toThrow('aborted');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});

describe('abort signal', () => {
  it('throws immediately if signal already aborted', async () => {
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    });

    // Mock fetch so we can verify it's never called
    mockFetch({ content: [{ type: 'text', text: 'should not reach' }] });

    const controller = new AbortController();
    controller.abort();

    await expect(client.complete('sys', 'input', controller.signal)).rejects.toThrow('aborted');
    // fetch should never be called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('verifyLlmApiKey', () => {
  it('returns ok for Anthropic 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: () => Promise.resolve('{"data":[]}'),
    });

    const result = await verifyLlmApiKey('anthropic', 'sk-ant-good');

    expect(result.ok).toBe(true);
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(call[1].method).toBe('GET');
    expect(call[1].headers['x-api-key']).toBe('sk-ant-good');
    expect(call[1].headers['anthropic-version']).toBe('2023-06-01');
  });

  it('returns ok for OpenAI 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: () => Promise.resolve('{"data":[]}'),
    });

    const result = await verifyLlmApiKey('openai', 'sk-openai-good');

    expect(result.ok).toBe(true);
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe('https://api.openai.com/v1/models');
    expect(call[1].headers.Authorization).toBe('Bearer sk-openai-good');
  });

  it('marks Anthropic 401 as invalid', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"type":"authentication_error"}}'),
    });

    const result = await verifyLlmApiKey('anthropic', 'sk-ant-bad');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
      if (result.reason === 'invalid') {
        expect(result.status).toBe(401);
        expect(result.body).toContain('authentication_error');
      }
    }
  });

  it('marks OpenAI 401 as invalid', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"code":"invalid_api_key"}}'),
    });

    const result = await verifyLlmApiKey('openai', 'sk-openai-bad');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('marks 403 as invalid', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('forbidden'),
    });

    const result = await verifyLlmApiKey('anthropic', 'sk-ant-forbidden');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('marks 5xx as unavailable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('service unavailable'),
    });

    const result = await verifyLlmApiKey('openai', 'sk-whatever');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unavailable');
    }
  });

  it('marks 429 rate limit as unavailable (not hard-fail)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limited'),
    });

    const result = await verifyLlmApiKey('anthropic', 'sk-ant-ratelimited');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unavailable');
    }
  });

  it('marks network error as unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed: ENOTFOUND'));

    const result = await verifyLlmApiKey('anthropic', 'sk-ant-offline');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unavailable');
      if (result.reason === 'unavailable') {
        expect(result.error).toContain('fetch failed');
      }
    }
  });
});

describe('reasoning model detection', () => {
  it('uses developer role for o1 model', async () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o1-mini',
      maxTokens: 1024,
    });

    mockFetch({ choices: [{ message: { content: 'ok' } }] });
    await client.complete('sys', 'input');

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('developer');
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.max_tokens).toBeUndefined();
  });

  it('uses developer role for o4-mini model', async () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      maxTokens: 1024,
    });

    mockFetch({ choices: [{ message: { content: 'ok' } }] });
    await client.complete('sys', 'input');

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('developer');
  });

  it('uses system role for gpt-4o', async () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      maxTokens: 1024,
    });

    mockFetch({ choices: [{ message: { content: 'ok' } }] });
    await client.complete('sys', 'input');

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.max_tokens).toBe(1024);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('matches future reasoning models (o5, o9)', async () => {
    const client = createLlmClient({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o5-preview',
      maxTokens: 1024,
    });

    mockFetch({ choices: [{ message: { content: 'ok' } }] });
    await client.complete('sys', 'input');

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('developer');
  });
});
