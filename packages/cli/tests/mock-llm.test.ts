import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLlmClient } from '../src/llm';
import { createMockLlmClient, isMockLlmEnabled, refuseMockLlmInProduction } from '../src/llm/mock';

describe('mock LLM client', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      MOCK_LLM: process.env.MOCK_LLM,
      MOCK_LLM_LATENCY_MS: process.env.MOCK_LLM_LATENCY_MS,
      MOCK_LLM_JITTER_MS: process.env.MOCK_LLM_JITTER_MS,
      MOCK_LLM_BILLING_FAIL_PCT: process.env.MOCK_LLM_BILLING_FAIL_PCT,
      NODE_ENV: process.env.NODE_ENV,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('isMockLlmEnabled honours MOCK_LLM=1 and MOCK_LLM=true', () => {
    delete process.env.MOCK_LLM;
    expect(isMockLlmEnabled()).toBe(false);
    process.env.MOCK_LLM = '1';
    expect(isMockLlmEnabled()).toBe(true);
    process.env.MOCK_LLM = 'true';
    expect(isMockLlmEnabled()).toBe(true);
    process.env.MOCK_LLM = 'TRUE';
    expect(isMockLlmEnabled()).toBe(true);
    process.env.MOCK_LLM = '0';
    expect(isMockLlmEnabled()).toBe(false);
  });

  it('refuseMockLlmInProduction throws when MOCK_LLM=1 and NODE_ENV=production', () => {
    process.env.MOCK_LLM = '1';
    process.env.NODE_ENV = 'production';
    expect(() => refuseMockLlmInProduction()).toThrow(/not allowed in NODE_ENV=production/);
  });

  it('refuseMockLlmInProduction is a no-op outside production', () => {
    process.env.MOCK_LLM = '1';
    delete process.env.NODE_ENV;
    expect(() => refuseMockLlmInProduction()).not.toThrow();
    process.env.NODE_ENV = 'development';
    expect(() => refuseMockLlmInProduction()).not.toThrow();
  });

  it('refuseMockLlmInProduction is a no-op when MOCK_LLM is unset', () => {
    delete process.env.MOCK_LLM;
    process.env.NODE_ENV = 'production';
    expect(() => refuseMockLlmInProduction()).not.toThrow();
  });

  it('createMockLlmClient.complete returns a synthetic reply that includes input', async () => {
    process.env.MOCK_LLM_JITTER_MS = '0';
    const client = createMockLlmClient();
    const reply = await client.complete('You are a helpful test agent.', 'translate hello world');
    expect(reply).toMatch(/MOCK_LLM reply/);
    expect(reply).toMatch(/translate hello world/);
  });

  it('createMockLlmClient honours BILLING_FAIL_PCT=100 by throwing', async () => {
    process.env.MOCK_LLM_BILLING_FAIL_PCT = '100';
    process.env.MOCK_LLM_JITTER_MS = '0';
    const client = createMockLlmClient();
    await expect(client.complete('sys', 'input')).rejects.toThrow(/credit balance|billing/i);
  });

  it('createLlmClient returns the mock when MOCK_LLM is enabled', async () => {
    process.env.MOCK_LLM = '1';
    process.env.MOCK_LLM_JITTER_MS = '0';
    const client = createLlmClient({
      provider: 'anthropic',
      apiKey: 'sk-fake',
      model: 'claude-3-5-haiku-20241022',
      maxTokens: 1024,
    });
    const reply = await client.complete('sys', 'hello');
    expect(reply).toMatch(/MOCK_LLM reply/);
  });

  it('createMockLlmClient.completeWithTools returns text result regardless of tools', async () => {
    process.env.MOCK_LLM_JITTER_MS = '0';
    const client = createMockLlmClient();
    const result = await client.completeWithTools('sys', ['user message'], [], undefined);
    expect(result.type).toBe('text');
  });
});
