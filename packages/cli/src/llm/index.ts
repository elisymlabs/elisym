/**
 * CLI-level LLM facade.
 *
 * The provider registry, descriptors, and concrete client classes
 * (Anthropic, OpenAI) live under `./providers/` + `./registry.ts`.
 * Concrete clients implement `logUsage` themselves (printing token
 * counts to stdout after each API response) - keeping log code in the
 * client lets it read the raw provider response without an extra
 * round-trip. SDK clients no longer exist; CLI is the only consumer.
 *
 * This module exposes:
 * - `createLlmClient(config)`: registry-driven factory
 * - `verifyLlmApiKey(provider, key)`: registry-driven probe
 * - `LlmConfig`, `LlmProvider`, `LlmKeyVerification` shapes
 * - registry surface (`getLlmProvider`, `listLlmProviders`,
 *   `getRegisteredProviderIds`, `registerLlmProvider`)
 */

import type { LlmClient } from '@elisym/sdk/skills';
import { getLlmProvider, getRegisteredProviderIds, type LlmKeyVerification } from './registry';

export type { LlmKeyVerification, LlmProviderDescriptor, LlmUsage } from './registry';
export {
  getLlmProvider,
  getRegisteredProviderIds,
  listLlmProviders,
  registerLlmProvider,
} from './registry';

export type LlmProvider = string;

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Print `[LLM] <model> tokens: in=N out=M ...` after each call. Default: false. */
  logUsage?: boolean;
}

/**
 * Build an `LlmClient` for the given config. Throws when the provider
 * id is not registered (typically a typo in elisym.yaml or SKILL.md
 * `provider:` override).
 */
export function createLlmClient(config: LlmConfig): LlmClient {
  const descriptor = getLlmProvider(config.provider);
  if (!descriptor) {
    const known = getRegisteredProviderIds().join(', ') || '<none>';
    throw new Error(`Unknown LLM provider "${config.provider}". Registered: ${known}.`);
  }
  if (!config.apiKey) {
    throw new Error(`${descriptor.envVar} is required for skill runtime`);
  }
  return descriptor.createClient({
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    logUsage: config.logUsage,
  });
}

/**
 * Verify that an LLM API key is accepted by the provider before the agent
 * publishes capabilities. Delegates to the descriptor's `verifyKey`.
 */
export async function verifyLlmApiKey(
  provider: LlmProvider,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmKeyVerification> {
  const descriptor = getLlmProvider(provider);
  if (!descriptor) {
    return {
      ok: false,
      reason: 'unavailable',
      error: `Unknown LLM provider "${provider}"`,
    };
  }
  return descriptor.verifyKey(apiKey, signal);
}
