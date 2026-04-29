/**
 * Resolve the API key for a given provider, walking the priority chain:
 *
 *   1. `secrets.llm_api_keys[<provider>]` (per-provider entry, preferred).
 *   2. `process.env.<descriptor.envVar>` (operator convenience).
 */

import type { Secrets } from '@elisym/sdk/agent-store';
import { getLlmProvider } from './registry';
import type { LlmProvider } from './index';

export interface ResolvedProviderKey {
  apiKey: string;
  origin: 'secrets-per-provider' | 'env';
}

export type ResolveProviderKeyResult = ResolvedProviderKey | { error: string };

export interface ResolveProviderKeyInput {
  provider: LlmProvider;
  secrets: Secrets;
  /** Names of skills that resolved to this provider. Surfaced in error messages. */
  dependentSkills: string[];
}

export function resolveProviderApiKey(input: ResolveProviderKeyInput): ResolveProviderKeyResult {
  const { provider, secrets, dependentSkills } = input;

  const descriptor = getLlmProvider(provider);
  if (!descriptor) {
    const skillList = dependentSkills.length > 0 ? dependentSkills.join(', ') : '<none>';
    return {
      error: `Provider "${provider}" is not registered (required by skill(s): ${skillList}).`,
    };
  }

  const perProviderValue = secrets.llm_api_keys?.[provider];
  if (typeof perProviderValue === 'string' && perProviderValue.length > 0) {
    return { apiKey: perProviderValue, origin: 'secrets-per-provider' };
  }

  const envValue = process.env[descriptor.envVar];
  if (envValue) {
    return { apiKey: envValue, origin: 'env' };
  }

  const skillList = dependentSkills.length > 0 ? dependentSkills.join(', ') : '<none>';
  return {
    error:
      `Provider "${provider}" needs an API key (required by skill(s): ${skillList}). ` +
      `Set secrets.llm_api_keys.${provider} via 'npx @elisym/cli profile <agent>' or export ${descriptor.envVar}.`,
  };
}
