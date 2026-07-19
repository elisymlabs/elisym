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
  resolveInsidePathReal,
  validateSkillFrontmatter,
  type ParsedSkill,
} from '@elisym/sdk/skills';
import { listLlmProviders } from '../llm/index.js';
import { DynamicScriptSkill, StaticFileSkill, StaticScriptSkill } from './non-llm-skills.js';
import { ScriptSkill } from './script-skill.js';
import { X402Skill } from './x402-skill.js';
import type { Skill } from './index.js';

/**
 * Per-skill LLM-key scoping: a script skill receives ONLY the key of the
 * provider its SKILL.md declares (`llm.provider` - the documented "this script
 * depends on this LLM API key" contract), never the operator's whole key ring.
 * Undeclared -> no LLM keys at all.
 */
function scopeLlmKeys(
  scriptEnv: NodeJS.ProcessEnv | undefined,
  declaredProvider: string | undefined,
): NodeJS.ProcessEnv | undefined {
  if (scriptEnv === undefined) {
    return undefined;
  }
  const env = { ...scriptEnv };
  for (const descriptor of listLlmProviders()) {
    if (descriptor.id !== declaredProvider) {
      delete env[descriptor.envVar];
    }
  }
  return env;
}

function buildCliSkill(
  parsed: ParsedSkill,
  entryPath: string,
  scriptEnv: NodeJS.ProcessEnv | undefined,
): Skill {
  // Confine image_file to the skill directory, mirroring the SDK loader's guard. A
  // third-party SKILL.md is untrusted; without this a traversing image_file (e.g.
  // ../../.secrets.json) would be read and uploaded to a public media host on
  // `start`. Drop a traversing value rather than fail the whole skill - the image
  // is cosmetic, the way output_file/script (load-bearing) hard-fail instead.
  let safeImageFile = parsed.imageFile;
  if (safeImageFile !== undefined && resolveInsidePathReal(entryPath, safeImageFile) === null) {
    console.warn(
      `SKILL.md "${parsed.name}": ignoring "image_file" that resolves outside the skill directory (directly or via symlink): ${safeImageFile}`,
    );
    safeImageFile = undefined;
  }

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
        safeImageFile,
        entryPath,
        parsed.systemPrompt,
        parsed.tools,
        parsed.maxToolRounds,
        parsed.llmOverride,
        parsed.context,
      );
      break;
    case 'static-file': {
      if (parsed.outputFile === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - outputFile missing for mode 'static-file'`,
        );
      }
      // Symlink-aware: this path is read on every paid job and returned to the
      // customer, so a planted symlink would exfiltrate whatever it points at.
      const outputFilePath = resolveInsidePathReal(entryPath, parsed.outputFile);
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
        imageFile: safeImageFile,
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
      // Symlink-aware like output_file/image_file: a script symlink escaping the
      // skill directory is rejected at load time rather than executed.
      const scriptPath = resolveInsidePathReal(entryPath, parsed.script);
      if (!scriptPath) {
        throw new Error(`SKILL.md "${parsed.name}": "script" must stay inside the skill directory`);
      }
      const scriptParams = {
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: Number(parsed.priceSubunits),
        asset: parsed.asset,
        scriptPath,
        scriptArgs: parsed.scriptArgs,
        scriptTimeoutMs: parsed.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        scriptEnv: scopeLlmKeys(scriptEnv, parsed.llmOverride?.provider),
        image: parsed.image,
        imageFile: safeImageFile,
        dir: entryPath,
        llmOverride: parsed.llmOverride,
      };
      // Only dynamic-script can exchange files, so the MIME hints are threaded
      // only there (the static-script wrapper has no such params).
      skill =
        parsed.mode === 'dynamic-script'
          ? new DynamicScriptSkill({
              ...scriptParams,
              outputMime: parsed.outputMime,
              inputMime: parsed.inputMime,
              inputText: parsed.inputText,
            })
          : new StaticScriptSkill(scriptParams);
      break;
    }
    case 'x402': {
      if (parsed.x402 === undefined) {
        throw new Error(
          `SKILL.md "${parsed.name}": internal error - x402 config missing for mode 'x402'`,
        );
      }
      skill = new X402Skill({
        name: parsed.name,
        description: parsed.description,
        capabilities: parsed.capabilities,
        priceSubunits: Number(parsed.priceSubunits),
        asset: parsed.asset,
        x402: parsed.x402,
        noInput: parsed.noInput === true,
        image: parsed.image,
        imageFile: safeImageFile,
        dir: entryPath,
      });
      break;
    }
  }
  if (parsed.rateLimit) {
    skill.rateLimit = parsed.rateLimit;
  }
  if (parsed.executionTimeoutSecs !== undefined) {
    skill.executionTimeoutSecs = parsed.executionTimeoutSecs;
  }
  return skill;
}

export interface LoadSkillsOptions {
  /**
   * Env propagated into script-mode skills (`static-script`, `dynamic-script`).
   * Typically `{ ...process.env, <PROVIDER_KEY>: <decrypted-secret>, ... }`
   * built from the agent's encrypted secrets. Per skill, every LLM provider
   * key except the one its SKILL.md declares (`llm.provider`) is stripped
   * before the env reaches the script - see `scopeLlmKeys`.
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
        // The CLI runtime wires an x402 driver into the skill context, so
        // x402 skills are executable here (SDK-only hosts reject them).
        allowX402Skills: true,
      });
      skills.push(buildCliSkill(parsed, entryPath, options.scriptEnv));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`  ! Skipping skill "${entry}": ${message}`);
    }
  }

  return skills;
}
