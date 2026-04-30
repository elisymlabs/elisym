import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyLlmApiKeyDeep } from '../src/llm/index.js';

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

describe('verifyLlmApiKeyDeep - Anthropic', () => {
  it('returns ok on 200', async () => {
    mockFetch({ status: 200, body: { content: [{ type: 'text', text: '.' }] } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result.ok).toBe(true);
  });

  it('hits the messages endpoint with max_tokens=1', async () => {
    mockFetch({ status: 200, body: { content: [] } });
    await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(call[1].body);
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
  });

  it('classifies 401 as invalid', async () => {
    mockFetch({ status: 401, body: { error: 'unauthorized' } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-bad', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'invalid', status: 401 });
  });

  it('classifies 403 as invalid', async () => {
    mockFetch({ status: 403, body: { error: 'forbidden' } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-bad', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'invalid', status: 403 });
  });

  it('classifies 402 as billing', async () => {
    mockFetch({ status: 402, body: { error: 'payment required' } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'billing', status: 402 });
  });

  it('classifies 400 with credit balance marker as billing', async () => {
    mockFetch({
      status: 400,
      body: { error: { message: 'Your credit balance is too low.' } },
    });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'billing', status: 400 });
  });

  it('classifies 400 without billing marker as unavailable', async () => {
    mockFetch({ status: 400, body: { error: { message: 'invalid model parameter' } } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('classifies 429 as unavailable', async () => {
    mockFetch({ status: 429, body: { error: 'rate limited' } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('classifies 500 as unavailable', async () => {
    mockFetch({ status: 500, body: { error: 'server error' } });
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('classifies network throw as unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND api.anthropic.com'));
    const result = await verifyLlmApiKeyDeep('anthropic', 'sk-good', 'claude-haiku-4-5-20251001');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (!result.ok && result.reason === 'unavailable') {
      expect(result.error).toContain('ENOTFOUND');
    }
  });
});

describe('verifyLlmApiKeyDeep - OpenAI', () => {
  it('classifies OpenAI 429 with insufficient_quota as billing', async () => {
    mockFetch({
      status: 429,
      body: { error: { type: 'insufficient_quota', message: 'You exceeded your current quota.' } },
    });
    const result = await verifyLlmApiKeyDeep('openai', 'sk-good', 'gpt-4o-mini');
    expect(result).toMatchObject({ ok: false, reason: 'billing', status: 429 });
  });

  it('classifies OpenAI 429 without quota marker as unavailable', async () => {
    mockFetch({ status: 429, body: { error: 'rate_limit_exceeded' } });
    const result = await verifyLlmApiKeyDeep('openai', 'sk-good', 'gpt-4o-mini');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('uses max_completion_tokens for reasoning models', async () => {
    mockFetch({ status: 200, body: { choices: [] } });
    await verifyLlmApiKeyDeep('openai', 'sk-good', 'o1-preview');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.max_completion_tokens).toBe(1);
    expect(body.max_tokens).toBeUndefined();
  });

  it('uses max_tokens for non-reasoning models', async () => {
    mockFetch({ status: 200, body: { choices: [] } });
    await verifyLlmApiKeyDeep('openai', 'sk-good', 'gpt-4o-mini');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.max_tokens).toBe(1);
  });
});

describe('verifyLlmApiKeyDeep - registry', () => {
  it('returns unavailable for unknown provider', async () => {
    const result = await verifyLlmApiKeyDeep('unknown', 'sk', 'model');
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
