/**
 * Per-skill LLM client caching.
 *
 * Different LLM skills may share or differ on (provider, model, maxTokens).
 * We deduplicate clients by a stable JSON-encoded triple so verifying API
 * keys and instantiating clients happens once per unique config.
 */

import type { LlmEntry } from '@elisym/sdk/agent-store';
import type { SkillLlmOverride } from '@elisym/sdk/skills';
import { DEFAULT_MAX_TOKENS, type ResolvedSkillLlm } from './resolve';
import type { LlmProvider } from './index';

/**
 * Stable cache key for an LLM client config. JSON-encoded so any provider /
 * model string is safely escaped (avoids ad-hoc separator collisions).
 */
export function cacheKeyFor(triple: ResolvedSkillLlm): string {
  return JSON.stringify({
    provider: triple.provider,
    model: triple.model,
    maxTokens: triple.maxTokens,
  });
}

/**
 * Resolve an `llmOverride` to a concrete (provider, model, maxTokens) using
 * the agent-level default for any field the override leaves unset. Returns
 * `undefined` when no agent-level default exists and the override is partial
 * (no provider/model) - the caller treats that as "no client available".
 */
export function resolveTripleForOverride(
  override: SkillLlmOverride | undefined,
  agentDefault: LlmEntry | undefined,
): ResolvedSkillLlm | undefined {
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
    return undefined;
  }
  const maxTokens = override?.maxTokens ?? agentDefault?.max_tokens ?? DEFAULT_MAX_TOKENS;
  return { provider, model, maxTokens };
}
