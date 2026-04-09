/**
 * Shared agent config - validation and serialization.
 * Browser-safe - no Node.js imports.
 * parseConfig lives in config-node.ts (exported from @elisym/sdk/node).
 */

import { LIMITS } from '../constants';
import type { AgentConfig } from '../types';

export function validateAgentName(name: string): void {
  if (!name || name.length > LIMITS.MAX_AGENT_NAME_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Agent name must be 1-64 characters, alphanumeric, underscore, or hyphen.');
  }
}

/** Serialize an AgentConfig to JSON string. */
export function serializeConfig(config: AgentConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}
