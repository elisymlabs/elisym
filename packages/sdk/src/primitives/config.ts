/**
 * Agent-name validation shared between CLI and MCP.
 * Browser-safe - no Node.js imports.
 */

import { LIMITS } from '../constants';

export function validateAgentName(name: string): void {
  if (!name || name.length > LIMITS.MAX_AGENT_NAME_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Agent name must be 1-64 characters, alphanumeric, underscore, or hyphen.');
  }
}
