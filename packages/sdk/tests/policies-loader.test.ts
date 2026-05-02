import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPoliciesFromDir } from '../src/agent-store/policies';
import { LIMITS } from '../src/constants';

describe('loadPoliciesFromDir', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'elisym-policies-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns empty array when directory does not exist', () => {
    expect(loadPoliciesFromDir(join(tmpDir, 'nonexistent'))).toEqual([]);
  });

  it('parses a policy with full frontmatter', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'tos.md'),
      [
        '---',
        'title: Terms of Service',
        'version: "2.1"',
        'summary: Brief blurb',
        '---',
        '',
        '# Terms',
        '',
        'Body of the policy.',
      ].join('\n'),
    );

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(1);
    const tos = policies[0]!;
    expect(tos.type).toBe('tos');
    expect(tos.version).toBe('2.1');
    expect(tos.title).toBe('Terms of Service');
    expect(tos.summary).toBe('Brief blurb');
    expect(tos.content).toContain('# Terms');
    expect(tos.content).toContain('Body of the policy.');
  });

  it('applies defaults when frontmatter is missing', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(join(dir, 'data-protection.md'), 'Just a markdown body, no frontmatter.');

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(1);
    const policy = policies[0]!;
    expect(policy.type).toBe('data-protection');
    expect(policy.title).toBe('Data Protection');
    expect(policy.version).toBe('1.0');
    expect(policy.summary).toBeUndefined();
    expect(policy.content).toBe('Just a markdown body, no frontmatter.');
  });

  it('skips files with invalid type slug', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(join(dir, '-bad.md'), 'Body');

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips non-md files silently', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tos.md'), 'Body');
    writeFileSync(join(dir, 'README.txt'), 'ignored');
    writeFileSync(join(dir, '.gitignore'), '*');

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.type).toBe('tos');
  });

  it('skips empty body with warning', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tos.md'), '---\ntitle: ToS\n---\n\n');

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips oversized content with error', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    const oversized = 'x'.repeat(LIMITS.MAX_POLICY_CONTENT_LENGTH + 1);
    writeFileSync(join(dir, 'tos.md'), oversized);

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('handles malformed frontmatter gracefully', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tos.md'), '---\ntitle: ToS\nno-closing-delimiter\n\nBody');

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('respects MAX_POLICIES_PER_AGENT cap', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    for (let i = 0; i < LIMITS.MAX_POLICIES_PER_AGENT + 3; i++) {
      writeFileSync(join(dir, `policy-${String(i).padStart(2, '0')}.md`), 'Body');
    }

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(LIMITS.MAX_POLICIES_PER_AGENT);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('normalizes uppercase filename to lowercase type', () => {
    const dir = join(tmpDir, 'policies');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Privacy.md'), 'Body');

    const policies = loadPoliciesFromDir(dir);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.type).toBe('privacy');
  });
});
