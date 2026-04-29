import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadSkillsFromDir } from '../src/skill/loader.js';

function createTempSkill(dir: string, name: string, content: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);
}

describe('loadSkillsFromDir', () => {
  it('loads a valid skill', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(
        tmp,
        'summarizer',
        `---
name: summarizer
description: Summarize text
capabilities:
  - summarization
  - text-analysis
---

You are a text summarizer. Provide concise summaries.`,
      );

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe('summarizer');
      expect(skills[0]!.description).toBe('Summarize text');
      expect(skills[0]!.capabilities).toEqual(['summarization', 'text-analysis']);
      expect(skills[0]!.priceSubunits).toBe(0); // default free
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('loads skill with tools', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(
        tmp,
        'youtube',
        `---
name: youtube-summary
description: Summarize YouTube videos
capabilities:
  - youtube-summary
max_tool_rounds: 5
tools:
  - name: fetch_transcript
    description: Fetch transcript
    command: ["python3", "scripts/summarize.py"]
    parameters:
      - name: url
        description: YouTube URL
        required: true
---

You are a YouTube summarizer.`,
      );

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe('youtube-summary');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('loads multiple skills', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(
        tmp,
        's1',
        `---\nname: s1\ndescription: Skill 1\ncapabilities: [a]\n---\nPrompt 1`,
      );
      createTempSkill(
        tmp,
        's2',
        `---\nname: s2\ndescription: Skill 2\ncapabilities: [b]\n---\nPrompt 2`,
      );

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('returns empty for nonexistent directory', () => {
    expect(loadSkillsFromDir('/nonexistent/path')).toEqual([]);
  });

  it('skips directories without SKILL.md', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      mkdirSync(join(tmp, 'not-a-skill'));
      writeFileSync(join(tmp, 'not-a-skill', 'README.md'), 'nothing');

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('skips files (non-directories)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      writeFileSync(join(tmp, 'random.txt'), 'not a directory');

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('parses price in SOL and converts to lamports', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(
        tmp,
        'paid',
        `---
name: paid-skill
description: A paid skill
capabilities:
  - premium
price: 0.01
image: https://example.com/hero.png
---

Premium service.`,
      );

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.priceSubunits).toBe(10_000_000); // 0.01 SOL
      expect(skills[0]!.image).toBe('https://example.com/hero.png');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('skips SKILL.md with missing name', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(tmp, 'bad', `---\ndescription: No name\ncapabilities: [a]\n---\nPrompt`);

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('skips SKILL.md with empty capabilities', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(
        tmp,
        'bad',
        `---\nname: bad\ndescription: No caps\ncapabilities: []\n---\nPrompt`,
      );

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('skips SKILL.md with missing description', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(tmp, 'bad', `---\nname: bad\ncapabilities: [a]\n---\nPrompt`);

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('llm mode default: skill has mode === "llm" and is the LLM ScriptSkill class', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      createTempSkill(
        tmp,
        'llm',
        `---\nname: llm-skill\ndescription: LLM skill\ncapabilities: [chat]\nprice: 0.001\n---\n\nYou are helpful.`,
      );
      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.mode).toBe('llm');
      expect(skills[0]!.constructor.name).toBe('ScriptSkill');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('static-file mode: dispatch wraps StaticFileSkill and execute reads the file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      const skillDir = join(tmp, 'doc');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: doc-skill
description: Static doc
capabilities: [doc]
price: 0.001
mode: static-file
output_file: ./welcome.md
---
`,
      );
      writeFileSync(join(skillDir, 'welcome.md'), 'static body\n');

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.mode).toBe('static-file');
      expect(skills[0]!.constructor.name).toBe('StaticFileSkill');
      expect(skills[0]!.dir).toBe(skillDir);

      const out = await skills[0]!.execute(
        { data: '', inputType: 'text', tags: ['doc'], jobId: 'j' },
        { agentName: 't', agentDescription: '' },
      );
      expect(out.data).toBe('static body\n');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('static-script mode: dispatch wraps StaticScriptSkill and runs script', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      const skillDir = join(tmp, 'gen');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: gen-skill
description: Static gen
capabilities: [gen]
price: 0.001
mode: static-script
script: ./gen.sh
---
`,
      );
      const scriptPath = join(skillDir, 'gen.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
      chmodSync(scriptPath, 0o755);

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.mode).toBe('static-script');
      expect(skills[0]!.constructor.name).toBe('StaticScriptSkill');

      const out = await skills[0]!.execute(
        { data: '', inputType: 'text', tags: ['gen'], jobId: 'j' },
        { agentName: 't', agentDescription: '' },
      );
      expect(out.data).toBe('ok');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('dynamic-script mode: dispatch wraps DynamicScriptSkill and pipes stdin', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      const skillDir = join(tmp, 'upper');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: upper-skill
description: Uppercase
capabilities: [upper]
price: 0.001
mode: dynamic-script
script: ./upper.sh
---
`,
      );
      const scriptPath = join(skillDir, 'upper.sh');
      writeFileSync(scriptPath, '#!/bin/sh\ntr a-z A-Z\n');
      chmodSync(scriptPath, 0o755);

      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.mode).toBe('dynamic-script');
      expect(skills[0]!.constructor.name).toBe('DynamicScriptSkill');

      const out = await skills[0]!.execute(
        { data: 'hello', inputType: 'text', tags: ['upper'], jobId: 'j' },
        { agentName: 't', agentDescription: '' },
      );
      expect(out.data).toBe('HELLO');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('skips skill whose script escapes the skill directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      const skillDir = join(tmp, 'escape');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
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
      const skills = loadSkillsFromDir(tmp);
      expect(skills).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});
