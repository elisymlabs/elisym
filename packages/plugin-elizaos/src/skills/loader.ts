import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { logger } from '../lib/logger';
import { solToLamports } from '../lib/pricing';
import { ScriptSkill, type SkillToolDef } from './scriptSkill';
import type { Skill } from './types';

const DEFAULT_MAX_TOOL_ROUNDS = 10;

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  capabilities?: unknown;
  price?: unknown;
  tools?: unknown;
  max_tool_rounds?: unknown;
}

interface ParsedSkill {
  name: string;
  description: string;
  capabilities: string[];
  priceLamports: bigint;
  systemPrompt: string;
  tools: SkillToolDef[];
  maxToolRounds: number;
}

function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; systemPrompt: string } {
  const lines = content.split('\n');
  let start = -1;
  let end = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
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
  const systemPrompt = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  return { frontmatter, systemPrompt };
}

function validateTool(raw: unknown, skillName: string, index: number): SkillToolDef {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`skill "${skillName}" tool[${index}] must be an object`);
  }
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new Error(`skill "${skillName}" tool[${index}] missing name`);
  }
  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    throw new Error(`skill "${skillName}" tool "${tool.name}" missing description`);
  }
  if (!Array.isArray(tool.command) || tool.command.length === 0) {
    throw new Error(`skill "${skillName}" tool "${tool.name}" missing command[] array`);
  }
  for (const part of tool.command) {
    if (typeof part !== 'string') {
      throw new Error(`skill "${skillName}" tool "${tool.name}" command[] must be strings`);
    }
  }
  const parameters: SkillToolDef['parameters'] = [];
  if (tool.parameters !== undefined) {
    if (!Array.isArray(tool.parameters)) {
      throw new Error(`skill "${skillName}" tool "${tool.name}" parameters must be an array`);
    }
    for (let paramIndex = 0; paramIndex < tool.parameters.length; paramIndex++) {
      const param = tool.parameters[paramIndex];
      if (typeof param !== 'object' || param === null) {
        throw new Error(
          `skill "${skillName}" tool "${tool.name}" parameter[${paramIndex}] must be an object`,
        );
      }
      const record = param as Record<string, unknown>;
      if (typeof record.name !== 'string' || record.name.length === 0) {
        throw new Error(
          `skill "${skillName}" tool "${tool.name}" parameter[${paramIndex}] missing name`,
        );
      }
      if (typeof record.description !== 'string') {
        throw new Error(
          `skill "${skillName}" tool "${tool.name}" parameter "${record.name}" missing description`,
        );
      }
      parameters.push({
        name: record.name,
        description: record.description,
        required: record.required === undefined ? undefined : Boolean(record.required),
      });
    }
  }
  return {
    name: tool.name,
    description: tool.description,
    command: tool.command as string[],
    parameters,
  };
}

function validateSkill(frontmatter: SkillFrontmatter, systemPrompt: string): ParsedSkill {
  if (typeof frontmatter.name !== 'string' || frontmatter.name.length === 0) {
    throw new Error('SKILL.md: missing or invalid "name" field');
  }
  if (typeof frontmatter.description !== 'string' || frontmatter.description.length === 0) {
    throw new Error('SKILL.md: missing or invalid "description" field');
  }
  if (!Array.isArray(frontmatter.capabilities) || frontmatter.capabilities.length === 0) {
    throw new Error('SKILL.md: "capabilities" must be a non-empty array');
  }
  const capabilities: string[] = [];
  for (const capability of frontmatter.capabilities) {
    if (typeof capability !== 'string' || capability.length === 0) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": capability entries must be non-empty strings`,
      );
    }
    capabilities.push(capability);
  }

  if (frontmatter.price === undefined || frontmatter.price === null) {
    throw new Error(
      `SKILL.md "${frontmatter.name}": "price" is required (SOL; e.g. 0.002). Free skills are not supported on the protocol yet.`,
    );
  }
  const priceRaw = frontmatter.price;
  if (typeof priceRaw !== 'number' && typeof priceRaw !== 'string') {
    throw new Error(`SKILL.md "${frontmatter.name}": "price" must be a number or numeric string`);
  }
  const priceLamports = solToLamports(priceRaw);
  if (priceLamports <= 0n) {
    throw new Error(
      `SKILL.md "${frontmatter.name}": price must be > 0 SOL (got ${priceRaw}); free skills are not yet supported`,
    );
  }

  const tools: SkillToolDef[] = [];
  if (frontmatter.tools !== undefined) {
    if (!Array.isArray(frontmatter.tools)) {
      throw new Error(`SKILL.md "${frontmatter.name}": "tools" must be an array`);
    }
    for (let index = 0; index < frontmatter.tools.length; index++) {
      tools.push(validateTool(frontmatter.tools[index], frontmatter.name, index));
    }
  }

  let maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS;
  if (frontmatter.max_tool_rounds !== undefined) {
    if (
      typeof frontmatter.max_tool_rounds !== 'number' ||
      !Number.isInteger(frontmatter.max_tool_rounds) ||
      frontmatter.max_tool_rounds <= 0
    ) {
      throw new Error(
        `SKILL.md "${frontmatter.name}": "max_tool_rounds" must be a positive integer`,
      );
    }
    maxToolRounds = frontmatter.max_tool_rounds;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    capabilities,
    priceLamports,
    systemPrompt,
    tools,
    maxToolRounds,
  };
}

export function loadSkillsFromDir(skillsDir: string): Skill[] {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch (error) {
    logger.debug({ err: error, skillsDir }, 'skills directory not readable; no skills loaded');
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
      const parsed = validateSkill(frontmatter, systemPrompt);
      skills.push(
        new ScriptSkill({
          name: parsed.name,
          description: parsed.description,
          capabilities: parsed.capabilities,
          priceLamports: parsed.priceLamports,
          skillDir: entryPath,
          systemPrompt: parsed.systemPrompt,
          tools: parsed.tools,
          maxToolRounds: parsed.maxToolRounds,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ dir: entry, err: message }, 'skipping malformed skill directory');
    }
  }

  return skills;
}
