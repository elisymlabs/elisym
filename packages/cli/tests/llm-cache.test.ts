import type { LlmEntry } from '@elisym/sdk/agent-store';
import { describe, expect, it } from 'vitest';
import { cacheKeyFor, resolveTripleForOverride } from '../src/llm/cache';
import { DEFAULT_MAX_TOKENS } from '../src/llm/resolve';

const AGENT_DEFAULT: LlmEntry = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  max_tokens: 8192,
};

describe('cacheKeyFor', () => {
  it('returns identical keys for identical triples', () => {
    const a = cacheKeyFor({ provider: 'openai', model: 'gpt-5-mini', maxTokens: 1024 });
    const b = cacheKeyFor({ provider: 'openai', model: 'gpt-5-mini', maxTokens: 1024 });
    expect(a).toBe(b);
  });

  it('differs when any field differs', () => {
    const base = cacheKeyFor({ provider: 'openai', model: 'gpt-5-mini', maxTokens: 1024 });
    expect(base).not.toBe(
      cacheKeyFor({ provider: 'anthropic', model: 'gpt-5-mini', maxTokens: 1024 }),
    );
    expect(base).not.toBe(
      cacheKeyFor({ provider: 'openai', model: 'gpt-5-other', maxTokens: 1024 }),
    );
    expect(base).not.toBe(
      cacheKeyFor({ provider: 'openai', model: 'gpt-5-mini', maxTokens: 2048 }),
    );
  });

  it('does not collide on model strings containing the JSON delimiters', () => {
    const benign = cacheKeyFor({ provider: 'openai', model: 'normal', maxTokens: 1 });
    const evil = cacheKeyFor({
      provider: 'openai',
      model: '","provider":"anthropic","model":"normal',
      maxTokens: 1,
    });
    expect(benign).not.toBe(evil);
  });
});

describe('resolveTripleForOverride', () => {
  it('returns the agent default when override is undefined', () => {
    expect(resolveTripleForOverride(undefined, AGENT_DEFAULT)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      maxTokens: 8192,
    });
  });

  it('uses the override pair, inheriting maxTokens from agent default', () => {
    expect(
      resolveTripleForOverride({ provider: 'openai', model: 'gpt-5-mini' }, AGENT_DEFAULT),
    ).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      maxTokens: 8192,
    });
  });

  it('a max-tokens-only override resolves to the same triple as agent default with overridden tokens (cache hit)', () => {
    const a = resolveTripleForOverride({ maxTokens: 8192 }, AGENT_DEFAULT);
    const b = resolveTripleForOverride(undefined, AGENT_DEFAULT);
    expect(a).toEqual(b);
    if (a && b) {
      expect(cacheKeyFor(a)).toBe(cacheKeyFor(b));
    }
  });

  it('returns undefined when no agent default and override is empty / max-tokens only', () => {
    expect(resolveTripleForOverride(undefined, undefined)).toBeUndefined();
    expect(resolveTripleForOverride({ maxTokens: 256 }, undefined)).toBeUndefined();
  });

  it('falls back to DEFAULT_MAX_TOKENS when neither side sets max_tokens', () => {
    const result = resolveTripleForOverride({ provider: 'openai', model: 'gpt-5-mini' }, undefined);
    expect(result?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });
});
