/**
 * CLI skill loader. Delegates SKILL.md parsing + validation to
 * `@elisym/sdk/skills` (one source of truth across plugin + CLI) and
 * constructs CLI's `ScriptSkill` wrapper, which in turn delegates
 * execution to the SDK runner. CLI keeps its own Skill interface
 * (`priceSubunits: number` + `asset`) so existing runtime.ts call sites
 * stay byte-for-byte compatible while supporting USDC alongside SOL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMd, validateSkillFrontmatter } from '@elisym/sdk/skills';
import { ScriptSkill } from './script-skill.js';
import type { Skill } from './index.js';

export function loadSkillsFromDir(skillsDir: string): Skill[] {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const skillMdPath = join(entryPath, 'SKILL.md');
    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, systemPrompt } = parseSkillMd(content);
      const parsed = validateSkillFrontmatter(frontmatter, systemPrompt, {
        allowFreeSkills: true,
      });
      skills.push(
        new ScriptSkill(
          parsed.name,
          parsed.description,
          parsed.capabilities,
          Number(parsed.priceSubunits),
          parsed.asset,
          parsed.image,
          parsed.imageFile,
          entryPath,
          parsed.systemPrompt,
          parsed.tools,
          parsed.maxToolRounds,
        ),
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`  ! Skipping skill "${entry}": ${message}`);
    }
  }

  return skills;
}
