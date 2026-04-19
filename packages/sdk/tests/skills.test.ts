import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  loadSkillsFromDir,
  parseSkillMd,
  validateSkillFrontmatter,
} from '../src/skills/loader';

let tmpDir: string;

function writeSkill(name: string, body: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
  return dir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'elisym-sdk-skills-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseSkillMd', () => {
  it('extracts frontmatter and systemPrompt', () => {
    const { frontmatter, systemPrompt } = parseSkillMd(`---
name: a
description: b
capabilities: [c]
price: 0.001
---

body here
more body
`);
    expect(frontmatter.name).toBe('a');
    expect(systemPrompt).toBe('body here\nmore body');
  });

  it('throws when delimiters are missing', () => {
    expect(() => parseSkillMd('no front matter\n')).toThrow(/frontmatter/);
  });
});

describe('validateSkillFrontmatter (strict mode)', () => {
  it('accepts a paid skill with capabilities and tools', () => {
    const parsed = validateSkillFrontmatter(
      {
        name: 'x',
        description: 'y',
        capabilities: ['cap'],
        price: 0.002,
        tools: [
          {
            name: 'echo',
            description: 'echoes',
            command: ['echo'],
            parameters: [{ name: 'text', description: 't', required: true }],
          },
        ],
      },
      'prompt body',
    );
    expect(parsed.priceLamports).toBe(2_000_000n);
    expect(parsed.maxToolRounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(parsed.tools).toHaveLength(1);
  });

  it('rejects price 0 without allowFreeSkills', () => {
    expect(() =>
      validateSkillFrontmatter(
        { name: 'x', description: 'y', capabilities: ['cap'], price: 0 },
        'prompt',
      ),
    ).toThrow(/free skills/i);
  });

  it('rejects missing price without allowFreeSkills', () => {
    expect(() =>
      validateSkillFrontmatter({ name: 'x', description: 'y', capabilities: ['cap'] }, 'prompt'),
    ).toThrow(/"price" is required/);
  });

  it('allows price 0 when allowFreeSkills is set', () => {
    const parsed = validateSkillFrontmatter(
      { name: 'x', description: 'y', capabilities: ['cap'], price: 0 },
      'prompt',
      { allowFreeSkills: true },
    );
    expect(parsed.priceLamports).toBe(0n);
  });

  it('allows missing price when allowFreeSkills is set', () => {
    const parsed = validateSkillFrontmatter(
      { name: 'x', description: 'y', capabilities: ['cap'] },
      'prompt',
      { allowFreeSkills: true },
    );
    expect(parsed.priceLamports).toBe(0n);
  });

  it('rejects unicode-only prompt without crashing', () => {
    // Non-latin prompt should parse fine - just shouldn't throw.
    const parsed = validateSkillFrontmatter(
      { name: 'x', description: 'y', capabilities: ['cap'], price: 0.001 },
      'Résumez les points clés du texte suivant.',
    );
    expect(parsed.systemPrompt).toContain('Résumez');
  });

  it('rejects empty capability array', () => {
    expect(() =>
      validateSkillFrontmatter(
        { name: 'x', description: 'y', capabilities: [], price: 0.001 },
        'p',
      ),
    ).toThrow(/capabilities/);
  });

  it('rejects non-string capability entries', () => {
    expect(() =>
      validateSkillFrontmatter(
        { name: 'x', description: 'y', capabilities: ['ok', 42], price: 0.001 },
        'p',
      ),
    ).toThrow(/non-empty strings/);
  });

  it('rejects non-integer max_tool_rounds', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          max_tool_rounds: 2.5,
        },
        'p',
      ),
    ).toThrow(/positive integer/);
  });

  it('rejects tool missing command array', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          tools: [{ name: 'no-command', description: 'desc' }],
        },
        'p',
      ),
    ).toThrow(/command/);
  });

  it('captures image and image_file when present', () => {
    const parsed = validateSkillFrontmatter(
      {
        name: 'x',
        description: 'y',
        capabilities: ['cap'],
        price: 0.001,
        image: 'https://example.com/x.png',
        image_file: './local.png',
      },
      'p',
    );
    expect(parsed.image).toBe('https://example.com/x.png');
    expect(parsed.imageFile).toBe('./local.png');
  });
});

describe('loadSkillsFromDir (strict mode)', () => {
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
    expect(skills[0]?.name).toBe('summary-skill');
    expect(skills[0]?.priceLamports).toBe(1_000_000n);
  });

  it('returns an empty array when the directory is missing', () => {
    expect(loadSkillsFromDir(join(tmpDir, 'nope'))).toEqual([]);
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
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });

  it('rejects a skill with price 0 in strict mode', () => {
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
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });

  it('loads free skills when allowFreeSkills is set', () => {
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
    const skills = loadSkillsFromDir(tmpDir, { allowFreeSkills: true });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.priceLamports).toBe(0n);
  });

  it('ignores entries that are not directories', () => {
    writeFileSync(join(tmpDir, 'not-a-skill.txt'), 'hello', 'utf-8');
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });
});
