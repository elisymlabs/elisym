import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  loadSkillsFromDir,
  parseSkillMd,
  validateSkillFrontmatter,
} from '../src/skills/loader';
import { resolveInsidePath } from '../src/skills/path-safety';
import { MAX_STATIC_FILE_SIZE } from '../src/skills/staticFileSkill';

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
    expect(parsed.priceSubunits).toBe(2_000_000n);
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
    expect(parsed.priceSubunits).toBe(0n);
  });

  it('allows missing price when allowFreeSkills is set', () => {
    const parsed = validateSkillFrontmatter(
      { name: 'x', description: 'y', capabilities: ['cap'] },
      'prompt',
      { allowFreeSkills: true },
    );
    expect(parsed.priceSubunits).toBe(0n);
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
    expect(skills[0]?.priceSubunits).toBe(1_000_000n);
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
    expect(skills[0]?.priceSubunits).toBe(0n);
  });

  it('ignores entries that are not directories', () => {
    writeFileSync(join(tmpDir, 'not-a-skill.txt'), 'hello', 'utf-8');
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });

  it('loads a USDC-priced skill with `token: usdc`', () => {
    writeSkill(
      'usdc-summary',
      `---
name: usdc-summary
description: Summarize text for USDC
capabilities: [summarize]
price: 0.05
token: usdc
---

body
`,
    );
    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.priceSubunits).toBe(50_000n);
    expect(skill.asset.token).toBe('usdc');
    expect(skill.asset.symbol).toBe('USDC');
    expect(skill.asset.decimals).toBe(6);
  });

  it('rejects a skill with an unknown token', () => {
    writeSkill(
      'badtoken',
      `---
name: badtoken
description: bad
capabilities: [bad]
price: 0.1
token: doge
---

body
`,
    );
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });
});

describe('validateSkillFrontmatter (mode)', () => {
  it('defaults mode to "llm" when omitted', () => {
    const parsed = validateSkillFrontmatter(
      { name: 'x', description: 'y', capabilities: ['cap'], price: 0.001 },
      'prompt',
    );
    expect(parsed.mode).toBe('llm');
  });

  it('accepts mode "static-file" with output_file', () => {
    const parsed = validateSkillFrontmatter(
      {
        name: 'x',
        description: 'y',
        capabilities: ['cap'],
        price: 0.001,
        mode: 'static-file',
        output_file: './welcome.md',
      },
      '',
    );
    expect(parsed.mode).toBe('static-file');
    expect(parsed.outputFile).toBe('./welcome.md');
  });

  it('rejects mode "static-file" without output_file', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-file',
        },
        '',
      ),
    ).toThrow(/requires "output_file"/);
  });

  it('rejects mode "static-file" with extraneous script', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-file',
          output_file: './a.md',
          script: './oops.sh',
        },
        '',
      ),
    ).toThrow(/"script" is not valid/);
  });

  it('accepts mode "static-script" with script', () => {
    const parsed = validateSkillFrontmatter(
      {
        name: 'x',
        description: 'y',
        capabilities: ['cap'],
        price: 0.001,
        mode: 'static-script',
        script: './gen.sh',
        script_args: ['--quiet'],
        script_timeout_ms: 5000,
      },
      '',
    );
    expect(parsed.mode).toBe('static-script');
    expect(parsed.script).toBe('./gen.sh');
    expect(parsed.scriptArgs).toEqual(['--quiet']);
    expect(parsed.scriptTimeoutMs).toBe(5000);
  });

  it('accepts mode "dynamic-script" with script', () => {
    const parsed = validateSkillFrontmatter(
      {
        name: 'x',
        description: 'y',
        capabilities: ['cap'],
        price: 0.001,
        mode: 'dynamic-script',
        script: './proxy.sh',
      },
      '',
    );
    expect(parsed.mode).toBe('dynamic-script');
    expect(parsed.scriptArgs).toEqual([]);
  });

  it('rejects script modes without script', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-script',
        },
        '',
      ),
    ).toThrow(/requires "script"/);
  });

  it('rejects unknown mode value', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'magic',
        },
        '',
      ),
    ).toThrow(/invalid mode/);
  });

  it('rejects tools in non-llm mode', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-script',
          script: './gen.sh',
          tools: [{ name: 't', description: 'd', command: ['echo'] }],
        },
        '',
      ),
    ).toThrow(/"tools" is only valid in mode 'llm'/);
  });

  it('rejects output_file in script modes', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-script',
          script: './a.sh',
          output_file: './a.md',
        },
        '',
      ),
    ).toThrow(/"output_file" is only valid in mode 'static-file'/);
  });

  it('rejects script_args/script_timeout_ms in non-script modes', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          script_args: ['--x'],
        },
        '',
      ),
    ).toThrow(/"script_args" is only valid/);
  });

  it('rejects non-array script_args', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-script',
          script: './a.sh',
          script_args: '--x',
        },
        '',
      ),
    ).toThrow(/array of strings/);
  });

  it('rejects non-positive script_timeout_ms', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          name: 'x',
          description: 'y',
          capabilities: ['cap'],
          price: 0.001,
          mode: 'static-script',
          script: './a.sh',
          script_timeout_ms: 0,
        },
        '',
      ),
    ).toThrow(/positive integer/);
  });
});

describe('resolveInsidePath', () => {
  it('resolves a child path inside the root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-path-'));
    try {
      expect(resolveInsidePath(tmp, './a.txt')).toBe(join(tmp, 'a.txt'));
      expect(resolveInsidePath(tmp, 'sub/b.txt')).toBe(join(tmp, 'sub', 'b.txt'));
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('rejects traversal with ..', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-path-'));
    try {
      expect(resolveInsidePath(tmp, '../escape.txt')).toBeNull();
      expect(resolveInsidePath(tmp, 'sub/../../escape.txt')).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('rejects the root itself (would overwrite the dir)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-path-'));
    try {
      expect(resolveInsidePath(tmp, '.')).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe('loadSkillsFromDir (mode dispatch + execute)', () => {
  it('loads a static-file skill and execute returns file contents', async () => {
    const dir = writeSkill(
      'doc',
      `---
name: doc-skill
description: Static document
capabilities: [doc]
price: 0.001
mode: static-file
output_file: ./welcome.md
---

ignored body
`,
    );
    writeFileSync(join(dir, 'welcome.md'), 'hello world\n', 'utf-8');

    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.constructor.name).toBe('StaticFileSkill');

    const out = await skill.execute(
      { data: '', inputType: 'text', tags: ['doc'], jobId: 'j1' },
      { agentName: 't', agentDescription: '' },
    );
    expect(out.data).toBe('hello world\n');
  });

  it('rejects a static-file skill whose output_file escapes the skill dir', () => {
    writeSkill(
      'evil',
      `---
name: evil
description: bad
capabilities: [bad]
price: 0.001
mode: static-file
output_file: ../../../etc/passwd
---

`,
    );
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });

  it('static-file: caps result at MAX_STATIC_FILE_SIZE', async () => {
    const dir = writeSkill(
      'big',
      `---
name: big-doc
description: big
capabilities: [big]
price: 0.001
mode: static-file
output_file: ./big.txt
---

`,
    );
    const oversized = 'x'.repeat(MAX_STATIC_FILE_SIZE + 1);
    writeFileSync(join(dir, 'big.txt'), oversized, 'utf-8');

    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    await expect(
      skills[0]!.execute(
        { data: '', inputType: 'text', tags: ['big'], jobId: 'j-big' },
        { agentName: 't', agentDescription: '' },
      ),
    ).rejects.toThrow(/exceeds/);
  });

  it('loads a static-script skill and execute returns trimmed stdout', async () => {
    const dir = writeSkill(
      'gen',
      `---
name: gen-skill
description: Static generator
capabilities: [gen]
price: 0.001
mode: static-script
script: ./gen.sh
---

`,
    );
    const scriptPath = join(dir, 'gen.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho "static result"', 'utf-8');
    chmodSync(scriptPath, 0o755);

    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.constructor.name).toBe('StaticScriptSkill');

    const out = await skills[0]!.execute(
      { data: '', inputType: 'text', tags: ['gen'], jobId: 'j2' },
      { agentName: 't', agentDescription: '' },
    );
    expect(out.data).toBe('static result');
  });

  it('static-script: throws on non-zero exit with stderr surfaced', async () => {
    const dir = writeSkill(
      'fail',
      `---
name: fail-skill
description: fails
capabilities: [fail]
price: 0.001
mode: static-script
script: ./fail.sh
---

`,
    );
    const scriptPath = join(dir, 'fail.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho "boom" >&2\nexit 7', 'utf-8');
    chmodSync(scriptPath, 0o755);

    const skills = loadSkillsFromDir(tmpDir);
    await expect(
      skills[0]!.execute(
        { data: '', inputType: 'text', tags: ['fail'], jobId: 'j3' },
        { agentName: 't', agentDescription: '' },
      ),
    ).rejects.toThrow(/exit 7.*boom/);
  });

  it('loads a dynamic-script skill and execute pipes stdin to stdout', async () => {
    const dir = writeSkill(
      'upper',
      `---
name: upper-skill
description: Uppercase via script
capabilities: [upper]
price: 0.001
mode: dynamic-script
script: ./upper.sh
---

`,
    );
    const scriptPath = join(dir, 'upper.sh');
    writeFileSync(scriptPath, '#!/bin/sh\ntr a-z A-Z', 'utf-8');
    chmodSync(scriptPath, 0o755);

    const skills = loadSkillsFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.constructor.name).toBe('DynamicScriptSkill');

    const out = await skills[0]!.execute(
      { data: 'hello there', inputType: 'text', tags: ['upper'], jobId: 'j4' },
      { agentName: 't', agentDescription: '' },
    );
    expect(out.data).toBe('HELLO THERE');
  });

  it('dynamic-script: passes script_args after the script', async () => {
    const dir = writeSkill(
      'echo-args',
      `---
name: echo-args
description: echoes args + stdin
capabilities: [echo]
price: 0.001
mode: dynamic-script
script: ./e.sh
script_args: ['flag-a', 'flag-b']
---

`,
    );
    const scriptPath = join(dir, 'e.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho "args=$1,$2"\ncat', 'utf-8');
    chmodSync(scriptPath, 0o755);

    const skills = loadSkillsFromDir(tmpDir);
    const out = await skills[0]!.execute(
      { data: 'tail-input', inputType: 'text', tags: ['echo'], jobId: 'j5' },
      { agentName: 't', agentDescription: '' },
    );
    expect(out.data).toContain('args=flag-a,flag-b');
    expect(out.data).toContain('tail-input');
  });

  it('static-script: closes stdin so children that read it do not hang', async () => {
    const dir = writeSkill(
      'reads-stdin',
      `---
name: reads-stdin
description: reads stdin then exits
capabilities: [r]
price: 0.001
mode: static-script
script: ./read.sh
script_timeout_ms: 5000
---

`,
    );
    // `cat` would block forever if stdin is not closed by the parent.
    // With a 5s skill timeout, an unfixed runScript would surface a
    // null-exit timeout instead of resolving promptly.
    const scriptPath = join(dir, 'read.sh');
    writeFileSync(scriptPath, '#!/bin/sh\ncat\necho done', 'utf-8');
    chmodSync(scriptPath, 0o755);

    const skills = loadSkillsFromDir(tmpDir);
    const start = Date.now();
    const out = await skills[0]!.execute(
      { data: '', inputType: 'text', tags: ['r'], jobId: 'j-stdin' },
      { agentName: 't', agentDescription: '' },
    );
    expect(out.data).toBe('done');
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('static-script: rejects script that escapes skill directory', () => {
    writeSkill(
      'escape',
      `---
name: escape
description: bad
capabilities: [bad]
price: 0.001
mode: static-script
script: ../../../bin/sh
---

`,
    );
    expect(loadSkillsFromDir(tmpDir)).toEqual([]);
  });
});
