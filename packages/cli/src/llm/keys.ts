/**
 * Resolve the API key for a given provider, walking the priority chain:
 *
 *   1. `secrets.<provider>_api_key` (per-provider, preferred).
 *   2. `secrets.llm_api_key` (legacy single-provider field, only when the
 *      provider matches the agent-level default).
 *   3. `process.env.<PROVIDER>_API_KEY` (operator convenience, especially
 *      for additional providers introduced via per-skill override).
 */

import type { Secrets } from '@elisym/sdk/agent-store';
import type { LlmProvider } from './index';

export interface ResolvedProviderKey {
  apiKey: string;
  origin: 'secrets-per-provider' | 'secrets-legacy' | 'env';
}

export type ResolveProviderKeyResult = ResolvedProviderKey | { error: string };

export interface ResolveProviderKeyInput {
  provider: LlmProvider;
  agentLevelProvider: LlmProvider | undefined;
  secrets: Secrets;
  /** Names of skills that resolved to this provider. Surfaced in error messages. */
  dependentSkills: string[];
}

const ENV_VAR_FOR_PROVIDER: Record<LlmProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const SECRET_FIELD_FOR_PROVIDER: Record<LlmProvider, 'anthropic_api_key' | 'openai_api_key'> = {
  anthropic: 'anthropic_api_key',
  openai: 'openai_api_key',
};

export function resolveProviderApiKey(input: ResolveProviderKeyInput): ResolveProviderKeyResult {
  const { provider, agentLevelProvider, secrets, dependentSkills } = input;

  const perProviderField = SECRET_FIELD_FOR_PROVIDER[provider];
  const perProviderValue = secrets[perProviderField];
  if (perProviderValue) {
    return { apiKey: perProviderValue, origin: 'secrets-per-provider' };
  }

  if (provider === agentLevelProvider && secrets.llm_api_key) {
    return { apiKey: secrets.llm_api_key, origin: 'secrets-legacy' };
  }

  const envVar = ENV_VAR_FOR_PROVIDER[provider];
  const envValue = process.env[envVar];
  if (envValue) {
    return { apiKey: envValue, origin: 'env' };
  }

  const skillList = dependentSkills.length > 0 ? dependentSkills.join(', ') : '<none>';
  return {
    error:
      `Provider "${provider}" needs an API key (required by skill(s): ${skillList}). ` +
      `Set secrets.${perProviderField} via 'npx @elisym/cli profile <agent>' or export ${envVar}.`,
  };
}
