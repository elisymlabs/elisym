import { describe, expect, it } from 'vitest';
import { validateSkillFrontmatter } from '../src/skills/loader';

const base = {
  name: 'file-skill',
  description: 'consumes a file input',
  capabilities: ['file-skill'],
  price: 0.05,
};

describe('validateSkillFrontmatter input_text', () => {
  it('parses each valid input_text value on a dynamic-script skill', () => {
    for (const value of ['none', 'optional', 'required'] as const) {
      const parsed = validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', input_text: value },
        '',
      );
      expect(parsed.inputText).toBe(value);
    }
  });

  it('leaves inputText undefined when omitted', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh' },
      '',
    );
    expect(parsed.inputText).toBeUndefined();
  });

  it('rejects an unknown input_text value', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', input_text: 'maybe' },
        '',
      ),
    ).toThrow(/input_text/);
  });

  it('rejects a non-string input_text', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', input_text: 1 },
        '',
      ),
    ).toThrow(/input_text/);
  });

  it('rejects input_text on a static-script skill', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'static-script', script: './run.sh', input_text: 'none' },
        '',
      ),
    ).toThrow(/input_text.*dynamic-script/);
  });

  it('rejects input_text on an llm skill', () => {
    expect(() =>
      validateSkillFrontmatter({ ...base, mode: 'llm', input_text: 'none' }, ''),
    ).toThrow(/input_text.*dynamic-script/);
  });

  it('rejects input_text on a static-file skill', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'static-file', output_file: './x.png', input_text: 'none' },
        '',
      ),
    ).toThrow(/input_text.*dynamic-script/);
  });
});
