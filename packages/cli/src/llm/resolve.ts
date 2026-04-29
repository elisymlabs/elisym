/**
 * Resolve the effective LLM config for a single skill.
 *
 * Combines the skill-level `llmOverride` with the agent-level default. The
 * (provider, model) pair is all-or-nothing at the override level (enforced
 * at parse time in the SDK skill loader); `maxTokens` chains independently.
 */

import type { LlmEntry } from '@elisym/sdk/agent-store';
import type { Skill, SkillLlmOverride } from '@elisym/sdk/skills';
import type { LlmProvider } from './index';

export const DEFAULT_MAX_TOKENS = 4096;

export interface ResolvedSkillLlm {
  provider: LlmProvider;
  model: string;
  maxTokens: number;
}

export interface ResolveSkillLlmInput {
  skillName: string;
  /** Filesystem path to the SKILL.md so error messages point at the exact file. */
  skillMdPath: string;
  llmOverride?: SkillLlmOverride;
}

export type ResolveSkillLlmResult = ResolvedSkillLlm | { error: string };

/**
 * Resolve a skill to a concrete (provider, model, maxTokens). Returns an
 * `error` shape when the skill is `mode: 'llm'` but neither side declared
 * provider/model.
 */
export function resolveSkillLlm(
  input: ResolveSkillLlmInput,
  agentDefault: LlmEntry | undefined,
): ResolveSkillLlmResult {
  const override = input.llmOverride;
  const overridePairSet = override?.provider !== undefined && override.model !== undefined;

  let provider: LlmProvider | undefined;
  let model: string | undefined;
  if (overridePairSet) {
    provider = override.provider;
    model = override.model;
  } else if (agentDefault) {
    provider = agentDefault.provider;
    model = agentDefault.model;
  }

  if (!provider || !model) {
    return {
      error:
        `Skill "${input.skillName}" at ${input.skillMdPath}: LLM model is required - ` +
        `declare "provider" + "model" in the SKILL.md frontmatter or set agent-level llm ` +
        `via 'npx @elisym/cli profile <agent>'.`,
    };
  }

  const maxTokens = override?.maxTokens ?? agentDefault?.max_tokens ?? DEFAULT_MAX_TOKENS;

  return { provider, model, maxTokens };
}

/** Lift the override fields from a `Skill` into the input shape used here. */
export function skillResolveInput(skill: Skill, skillMdPath: string): ResolveSkillLlmInput {
  return {
    skillName: skill.name,
    skillMdPath,
    llmOverride: skill.llmOverride,
  };
}
