import type { LlmEntry } from '@elisym/sdk/agent-store';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_TOKENS, resolveSkillLlm } from '../src/llm/resolve';

const AGENT_DEFAULT: LlmEntry = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  max_tokens: 8192,
};

const NO_OVERRIDE_INPUT = {
  skillName: 'demo',
  skillMdPath: '/skills/demo/SKILL.md',
};

describe('resolveSkillLlm', () => {
  it('uses agent default when no override is set', () => {
    const result = resolveSkillLlm(NO_OVERRIDE_INPUT, AGENT_DEFAULT);
    expect(result).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      maxTokens: 8192,
    });
  });

  it('override pair wins over agent default', () => {
    const result = resolveSkillLlm(
      {
        ...NO_OVERRIDE_INPUT,
        llmOverride: { provider: 'openai', model: 'gpt-5-mini' },
      },
      AGENT_DEFAULT,
    );
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      maxTokens: 8192, // inherited from agent default
    });
  });

  it('max_tokens override wins over agent default while pair inherited', () => {
    const result = resolveSkillLlm(
      {
        ...NO_OVERRIDE_INPUT,
        llmOverride: { maxTokens: 256 },
      },
      AGENT_DEFAULT,
    );
    expect(result).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      maxTokens: 256,
    });
  });

  it('inherits maxTokens default 4096 when neither side sets it', () => {
    const result = resolveSkillLlm(
      {
        ...NO_OVERRIDE_INPUT,
        llmOverride: { provider: 'openai', model: 'gpt-5-mini' },
      },
      undefined,
    );
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it('errors when neither side provides provider/model and includes the SKILL.md path', () => {
    const result = resolveSkillLlm(NO_OVERRIDE_INPUT, undefined);
    expect(result).toMatchObject({
      error: expect.stringContaining('/skills/demo/SKILL.md'),
    });
    expect((result as { error: string }).error).toContain('LLM model is required');
  });

  it('errors when override has only max_tokens and no agent default', () => {
    const result = resolveSkillLlm(
      {
        ...NO_OVERRIDE_INPUT,
        llmOverride: { maxTokens: 256 },
      },
      undefined,
    );
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});
