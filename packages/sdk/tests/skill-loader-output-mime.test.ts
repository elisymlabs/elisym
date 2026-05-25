import { describe, expect, it } from 'vitest';
import { validateSkillFrontmatter } from '../src/skills/loader';

const base = {
  name: 'file-skill',
  description: 'emits a file result',
  capabilities: ['file-skill'],
  price: 0.05,
};

describe('validateSkillFrontmatter output_mime', () => {
  it('parses output_mime on a dynamic-script skill', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh', output_mime: 'image/png' },
      '',
    );
    expect(parsed.outputMime).toBe('image/png');
  });

  it('leaves outputMime undefined when omitted', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, mode: 'dynamic-script', script: './run.sh' },
      '',
    );
    expect(parsed.outputMime).toBeUndefined();
  });

  it('rejects an empty output_mime', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', script: './run.sh', output_mime: '' },
        '',
      ),
    ).toThrow(/non-empty string/);
  });

  it("rejects output_mime on a static-script skill (file output isn't wired there)", () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'static-script', script: './run.sh', output_mime: 'image/png' },
        '',
      ),
    ).toThrow(/only valid in mode 'dynamic-script'/);
  });

  it('rejects output_mime on an llm skill', () => {
    expect(() => validateSkillFrontmatter({ ...base, output_mime: 'image/png' }, 'prompt')).toThrow(
      /only valid in mode 'dynamic-script'/,
    );
  });

  it('rejects output_mime on a static-file skill', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'static-file', output_file: './out.txt', output_mime: 'image/png' },
        '',
      ),
    ).toThrow(/only valid in mode 'dynamic-script'/);
  });
});
