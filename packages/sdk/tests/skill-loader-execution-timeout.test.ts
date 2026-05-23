import { describe, expect, it } from 'vitest';
import { validateSkillFrontmatter } from '../src/skills/loader';

const baseFrontmatter = {
  name: 'test-skill',
  description: 'A test skill',
  capabilities: ['text-classification'],
  price: 0.001,
};

describe('validateSkillFrontmatter max_execution_secs', () => {
  it('returns undefined when omitted (caller falls through to agent default)', () => {
    const parsed = validateSkillFrontmatter(baseFrontmatter, 'system prompt');
    expect(parsed.executionTimeoutSecs).toBeUndefined();
  });

  it('accepts a positive integer budget', () => {
    const parsed = validateSkillFrontmatter(
      { ...baseFrontmatter, max_execution_secs: 1800 },
      'system prompt',
    );
    expect(parsed.executionTimeoutSecs).toBe(1800);
  });

  it('accepts 0 as explicit unlimited', () => {
    const parsed = validateSkillFrontmatter(
      { ...baseFrontmatter, max_execution_secs: 0 },
      'system prompt',
    );
    expect(parsed.executionTimeoutSecs).toBe(0);
  });

  it('is mode-agnostic - valid on a script mode', () => {
    const parsed = validateSkillFrontmatter(
      {
        ...baseFrontmatter,
        mode: 'static-script',
        script: 'run.sh',
        max_execution_secs: 600,
      },
      'system prompt',
    );
    expect(parsed.executionTimeoutSecs).toBe(600);
  });

  it('throws on a negative value', () => {
    expect(() =>
      validateSkillFrontmatter({ ...baseFrontmatter, max_execution_secs: -5 }, 'system prompt'),
    ).toThrow(/max_execution_secs.*non-negative/);
  });

  it('throws on a non-integer value', () => {
    expect(() =>
      validateSkillFrontmatter({ ...baseFrontmatter, max_execution_secs: 1.5 }, 'system prompt'),
    ).toThrow(/max_execution_secs.*non-negative integer/);
  });

  it('throws on a non-number value', () => {
    expect(() =>
      validateSkillFrontmatter({ ...baseFrontmatter, max_execution_secs: '600' }, 'system prompt'),
    ).toThrow(/max_execution_secs/);
  });

  it('throws on a value above the setTimeout overflow cap', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...baseFrontmatter, max_execution_secs: 2_147_484 },
        'system prompt',
      ),
    ).toThrow(/max_execution_secs.*<=/);
  });
});
