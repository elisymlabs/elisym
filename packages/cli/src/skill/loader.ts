/**
 * Load skills from SKILL.md files in a directory.
 * Frontmatter uses YAML (Agent Skills standard).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ScriptSkill } from './script-skill.js';
import type { Skill } from './index.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Convert SOL (number) to lamports (integer). */
function solToLamports(sol: number): number {
  if (!Number.isFinite(sol) || sol < 0) {
    return 0;
  }
  return Math.round(sol * LAMPORTS_PER_SOL);
}

interface SkillToolParam {
  name: string;
  description: string;
  required?: boolean;
}

interface SkillToolDef {
  name: string;
  description: string;
  command: string[];
  parameters?: SkillToolParam[];
}

interface SkillFrontmatter {
  name: string;
  description: string;
  capabilities: string[];
  /** Price in SOL (e.g. 0.01). Converted to lamports internally. Default: 0 (free). */
  price?: number;
  /** Hero image URL (takes priority over image_file). */
  image?: string;
  /** Local file path for hero image. Uploaded on first start, URL written back to image. */
  image_file?: string;
  tools?: SkillToolDef[];
  max_tool_rounds?: number;
}

/** Parse a SKILL.md file into frontmatter + system prompt. */
function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; systemPrompt: string } {
  const lines = content.split('\n');
  let start = -1;
  let end = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      if (start === -1) {
        start = i;
      } else {
        end = i;
        break;
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error('SKILL.md must have YAML frontmatter between --- delimiters');
  }

  const yamlStr = lines.slice(start + 1, end).join('\n');
  const frontmatter = YAML.parse(yamlStr) as SkillFrontmatter;

  // W3: Validate required fields
  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw new Error('SKILL.md: missing or invalid "name" field');
  }
  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    throw new Error('SKILL.md: missing or invalid "description" field');
  }
  if (!Array.isArray(frontmatter.capabilities) || frontmatter.capabilities.length === 0) {
    throw new Error('SKILL.md: "capabilities" must be a non-empty array');
  }

  const systemPrompt = lines
    .slice(end + 1)
    .join('\n')
    .trim();

  return { frontmatter, systemPrompt };
}

/** Load all skills from subdirectories of the given path. */
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

      skills.push(
        new ScriptSkill(
          frontmatter.name,
          frontmatter.description,
          frontmatter.capabilities,
          solToLamports(frontmatter.price ?? 0),
          frontmatter.image,
          frontmatter.image_file,
          entryPath,
          systemPrompt,
          frontmatter.tools ?? [],
          frontmatter.max_tool_rounds ?? 10,
        ),
      );
    } catch (e: any) {
      // W5: Log skill load errors instead of silently skipping
      console.warn(`  ! Skipping skill "${entry}": ${e?.message ?? 'unknown error'}`);
    }
  }

  return skills;
}
