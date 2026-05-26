import { describe, expect, it } from 'vitest';
import { validateSkillFrontmatter } from '../src/skills/loader';

const base = {
  name: 'file-skill',
  description: 'consumes a file input',
  capabilities: ['file-skill'],
  price: 0.05,
};

describe('validateSkillFrontmatter input_mime', () => {
  it('parses input_mime on a dynamic-script skill', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh', input_mime: 'image/png' },
      '',
    );
    expect(parsed.inputMime).toBe('image/png');
  });

  it('accepts wildcard conventions (* and image/*)', () => {
    const anyFile = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh', input_mime: '*' },
      '',
    );
    expect(anyFile.inputMime).toBe('*');
    const anyImage = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh', input_mime: 'image/*' },
      '',
    );
    expect(anyImage.inputMime).toBe('image/*');
  });

  it('leaves inputMime undefined when omitted', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh' },
      '',
    );
    expect(parsed.inputMime).toBeUndefined();
  });

  it('rejects an empty input_mime', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', input_mime: '' },
        '',
      ),
    ).toThrow(/non-empty string/);
  });

  it('rejects an over-long input_mime', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', input_mime: 'x'.repeat(256) },
        '',
      ),
    ).toThrow(/too long/);
  });

  it('rejects input_mime on a static-script skill (file input is dynamic-script only)', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'static-script', script: './run.sh', input_mime: 'image/png' },
        '',
      ),
    ).toThrow(/only valid in mode 'dynamic-script'/);
  });

  it('rejects input_mime on an llm skill', () => {
    expect(() => validateSkillFrontmatter({ ...base, input_mime: 'image/png' }, 'prompt')).toThrow(
      /only valid in mode 'dynamic-script'/,
    );
  });

  it('rejects input_mime on a static-file skill', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'static-file', output_file: './out.txt', input_mime: 'image/png' },
        '',
      ),
    ).toThrow(/only valid in mode 'dynamic-script'/);
  });
});
