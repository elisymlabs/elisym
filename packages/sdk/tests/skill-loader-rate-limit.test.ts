import { describe, expect, it } from 'vitest';
import { validateSkillFrontmatter } from '../src/skills/loader';

const baseFrontmatter = {
  name: 'test-skill',
  description: 'A test skill',
  capabilities: ['text-classification'],
  price: 0.001,
};

describe('validateSkillFrontmatter rate_limit', () => {
  it('parses snake_case rate_limit to camelCase', () => {
    const parsed = validateSkillFrontmatter(
      {
        ...baseFrontmatter,
        rate_limit: { per_window_secs: 60, max_per_window: 5 },
      },
      'system prompt',
    );
    expect(parsed.rateLimit).toEqual({ perWindowMs: 60_000, maxPerWindow: 5 });
  });

  it('returns undefined when rate_limit is omitted', () => {
    const parsed = validateSkillFrontmatter(baseFrontmatter, 'system prompt');
    expect(parsed.rateLimit).toBeUndefined();
  });

  it('throws when rate_limit is not an object', () => {
    expect(() =>
      validateSkillFrontmatter({ ...baseFrontmatter, rate_limit: 'invalid' }, 'system prompt'),
    ).toThrow(/rate_limit.*must be an object/);
  });

  it('throws when per_window_secs is missing', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, rate_limit: { max_per_window: 3 } },
        'system prompt',
      ),
    ).toThrow(/per_window_secs/);
  });

  it('throws when max_per_window is missing', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, rate_limit: { per_window_secs: 60 } },
        'system prompt',
      ),
    ).toThrow(/max_per_window/);
  });

  it('throws when per_window_secs is non-integer', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, rate_limit: { per_window_secs: 1.5, max_per_window: 3 } },
        'system prompt',
      ),
    ).toThrow(/per_window_secs/);
  });

  it('throws when per_window_secs exceeds 24h', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, rate_limit: { per_window_secs: 86401, max_per_window: 3 } },
        'system prompt',
      ),
    ).toThrow(/per_window_secs/);
  });

  it('throws when max_per_window is zero', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, rate_limit: { per_window_secs: 60, max_per_window: 0 } },
        'system prompt',
      ),
    ).toThrow(/max_per_window/);
  });

  it('throws when max_per_window exceeds 10000', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, rate_limit: { per_window_secs: 60, max_per_window: 10001 } },
        'system prompt',
      ),
    ).toThrow(/max_per_window/);
  });

  it('accepts boundary values', () => {
    const parsed = validateSkillFrontmatter(
      {
        ...baseFrontmatter,
        rate_limit: { per_window_secs: 86400, max_per_window: 10000 },
      },
      'system prompt',
    );
    expect(parsed.rateLimit).toEqual({ perWindowMs: 86_400_000, maxPerWindow: 10000 });
  });
});
