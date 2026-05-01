/**
 * CLI skill loader. Delegates SKILL.md parsing + validation to
 * `@elisym/sdk/skills` (one source of truth across plugin + CLI) and
 * constructs CLI's wrapper instances. CLI keeps its own Skill interface
 * (`priceSubunits: number` + `asset` + `mode`) so existing runtime.ts
 * call sites stay byte-for-byte compatible while supporting USDC and
 * non-LLM execution modes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  parseSkillMd,
  resolveInsidePath,
  validateSkillFrontmatter,
  type ParsedSkill,
} from '@elisym/sdk/skills';
import { DynamicScriptSkill, StaticFileSkill, StaticScriptSkill } from './non-llm-skills.js';
import { ScriptSkill } from './script-skill.js';
import type { Skill } from './index.js';

function buildCliSkill(
  parsed: ParsedSkill,
  entryPath: string,
  scriptEnv: NodeJS.ProcessEnv | undefined,
): Skill {
  let skill: Skill;
  switch (parsed.mode) {
    case 'llm':
      skill = new ScriptSkill(
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
        parsed.llmOverride,
      );
      break;
    case 'static-file': {
      if (parsed.outputFile === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - outputFile missing for mode 'static-file'`,
        );
      }
      const outputFilePath = resolveInsidePath(entryPath, parsed.outputFile);
      if (!outputFilePath) {
        throw new Error(
          `SKILL.md "${parsed.name}": "output_file" must stay inside the skill directory`,
        );
      }
      skill = new StaticFileSkill({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: Number(parsed.priceSubunits),
        asset: parsed.asset,
        outputFilePath,
        image: parsed.image,
        imageFile: parsed.imageFile,
        dir: entryPath,
        llmOverride: parsed.llmOverride,
      });
      break;
    }
    case 'static-script':
    case 'dynamic-script': {
      if (parsed.script === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - script missing for mode '${parsed.mode}'`,
        );
      }
      const scriptPath = resolveInsidePath(entryPath, parsed.script);
      if (!scriptPath) {
        throw new Error(`SKILL.md "${parsed.name}": "script" must stay inside the skill directory`);
      }
      const Ctor = parsed.mode === 'static-script' ? StaticScriptSkill : DynamicScriptSkill;
      skill = new Ctor({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: Number(parsed.priceSubunits),
        asset: parsed.asset,
        scriptPath,
        scriptArgs: parsed.scriptArgs,
        scriptTimeoutMs: parsed.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        scriptEnv,
        image: parsed.image,
        imageFile: parsed.imageFile,
        dir: entryPath,
        llmOverride: parsed.llmOverride,
      });
      break;
    }
  }
  if (parsed.rateLimit) {
    skill.rateLimit = parsed.rateLimit;
  }
  return skill;
}

export interface LoadSkillsOptions {
  /**
   * Env propagated into script-mode skills (`static-script`, `dynamic-script`).
   * Typically `{ ...process.env, <PROVIDER_KEY>: <decrypted-secret>, ... }`
   * built from the agent's encrypted secrets, so scripts get the same
   * provider keys that LLM-mode skills already enjoy.
   */
  scriptEnv?: NodeJS.ProcessEnv;
}

export function loadSkillsFromDir(skillsDir: string, options: LoadSkillsOptions = {}): Skill[] {
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
      skills.push(buildCliSkill(parsed, entryPath, options.scriptEnv));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`  ! Skipping skill "${entry}": ${message}`);
    }
  }

  return skills;
}
