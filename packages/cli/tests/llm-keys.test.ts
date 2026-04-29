import type { Secrets } from '@elisym/sdk/agent-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProviderApiKey } from '../src/llm/keys';

const BASE_SECRETS: Secrets = {
  nostr_secret_key: 'nsec-x',
};

describe('resolveProviderApiKey', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers per-provider secrets entry from llm_api_keys', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      secrets: { ...BASE_SECRETS, llm_api_keys: { anthropic: 'sk-ant' } },
      dependentSkills: ['summarizer'],
    });
    expect(result).toEqual({ apiKey: 'sk-ant', origin: 'secrets-per-provider' });
  });

  it('falls back to env var when nothing is in secrets', () => {
    process.env.OPENAI_API_KEY = 'env-key-xyz';
    const result = resolveProviderApiKey({
      provider: 'openai',
      secrets: BASE_SECRETS,
      dependentSkills: ['x'],
    });
    expect(result).toEqual({ apiKey: 'env-key-xyz', origin: 'env' });
  });

  it('per-provider secret wins over the matching env var', () => {
    process.env.OPENAI_API_KEY = 'env-openai';
    const result = resolveProviderApiKey({
      provider: 'openai',
      secrets: { ...BASE_SECRETS, llm_api_keys: { openai: 'sk-secret' } },
      dependentSkills: ['x'],
    });
    expect(result).toEqual({ apiKey: 'sk-secret', origin: 'secrets-per-provider' });
  });

  it('errors with named env var, llm_api_keys hint, and dependent skills', () => {
    const result = resolveProviderApiKey({
      provider: 'openai',
      secrets: BASE_SECRETS,
      dependentSkills: ['cheap-summarizer', 'translator'],
    });
    expect(result).toMatchObject({
      error: expect.stringMatching(/llm_api_keys\.openai/),
    });
    const message = (result as { error: string }).error;
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('cheap-summarizer');
    expect(message).toContain('translator');
  });
});
