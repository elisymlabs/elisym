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

  it('prefers per-provider secrets key', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      agentLevelProvider: 'anthropic',
      secrets: { ...BASE_SECRETS, anthropic_api_key: 'sk-ant', llm_api_key: 'legacy' },
      dependentSkills: ['summarizer'],
    });
    expect(result).toEqual({ apiKey: 'sk-ant', origin: 'secrets-per-provider' });
  });

  it('falls back to legacy llm_api_key when provider matches agent default', () => {
    const result = resolveProviderApiKey({
      provider: 'anthropic',
      agentLevelProvider: 'anthropic',
      secrets: { ...BASE_SECRETS, llm_api_key: 'legacy-key' },
      dependentSkills: ['summarizer'],
    });
    expect(result).toEqual({ apiKey: 'legacy-key', origin: 'secrets-legacy' });
  });

  it('does NOT use legacy llm_api_key for a different provider', () => {
    process.env.OPENAI_API_KEY = 'env-openai';
    const result = resolveProviderApiKey({
      provider: 'openai',
      agentLevelProvider: 'anthropic',
      secrets: { ...BASE_SECRETS, llm_api_key: 'anthropic-legacy' },
      dependentSkills: ['cheap-summarizer'],
    });
    expect(result).toEqual({ apiKey: 'env-openai', origin: 'env' });
  });

  it('falls back to env var when nothing is in secrets', () => {
    process.env.OPENAI_API_KEY = 'env-key-xyz';
    const result = resolveProviderApiKey({
      provider: 'openai',
      agentLevelProvider: undefined,
      secrets: BASE_SECRETS,
      dependentSkills: ['x'],
    });
    expect(result).toEqual({ apiKey: 'env-key-xyz', origin: 'env' });
  });

  it('errors with named env var, secret field, and dependent skills', () => {
    const result = resolveProviderApiKey({
      provider: 'openai',
      agentLevelProvider: 'anthropic',
      secrets: BASE_SECRETS,
      dependentSkills: ['cheap-summarizer', 'translator'],
    });
    expect(result).toMatchObject({
      error: expect.stringMatching(/openai_api_key/),
    });
    const message = (result as { error: string }).error;
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('cheap-summarizer');
    expect(message).toContain('translator');
  });
});
