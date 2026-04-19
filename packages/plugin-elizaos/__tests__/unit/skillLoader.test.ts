import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkillsFromDir } from '../../src/skills/loader';

let tmpDir: string;

function writeSkill(name: string, body: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
  return dir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'elisym-skills-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSkillsFromDir', () => {
  it('loads a valid SKILL.md with tools', () => {
    writeSkill(
      'summary',
      `---
name: summary-skill
description: Summarize text
capabilities:
  - summarization
price: 0.001
tools:
  - name: echo
    description: Echo the input back
    command: ['echo']
    parameters:
      - name: text
        description: text to echo
        required: true
---

You are a summarizer.
`,
    );

    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill?.name).toBe('summary-skill');
    expect(skill?.capabilities).toEqual(['summarization']);
    expect(skill?.priceLamports).toBe(1_000_000n);
  });

  it('returns an empty array when the directory is missing', () => {
    const skills = loadSkillsFromDir(join(tmpDir, 'does-not-exist'));
    expect(skills).toEqual([]);
  });

  it('skips a skill whose frontmatter is malformed YAML', () => {
    writeSkill(
      'broken',
      `---
name: broken
description: x
capabilities:
  - x
price: 0.001
tools:
  - name: [not valid YAML
---

body
`,
    );
    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toEqual([]);
  });

  it('rejects a skill with price 0', () => {
    writeSkill(
      'free',
      `---
name: free-skill
description: free
capabilities: [free]
price: 0
---

body
`,
    );
    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toEqual([]);
  });

  it('rejects a skill without a price field', () => {
    writeSkill(
      'no-price',
      `---
name: no-price
description: nope
capabilities: [x]
---

body
`,
    );
    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toEqual([]);
  });

  it('rejects a skill with no capabilities', () => {
    writeSkill(
      'empty-caps',
      `---
name: empty-caps
description: x
capabilities: []
price: 0.001
---

body
`,
    );
    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toEqual([]);
  });

  it('ignores entries that are not directories', () => {
    writeFileSync(join(tmpDir, 'not-a-skill.txt'), 'hello', 'utf-8');
    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toEqual([]);
  });
});
