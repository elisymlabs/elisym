import type { IAgentRuntime, Memory } from '@elizaos/core';
import { IDENTITY_MEMORY_TABLE, WALLET_MEMORY_TABLE } from '../constants';
import { logger } from './logger';

const SECRET_FIELD = 'secret';

function extractSecret(memory: Memory | undefined): string | undefined {
  if (!memory) {
    return undefined;
  }
  const value = (memory.content as Record<string, unknown> | undefined)?.[SECRET_FIELD];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function loadSecret(runtime: IAgentRuntime, tableName: string): Promise<string | undefined> {
  try {
    const memories = await runtime.getMemories({
      tableName,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      count: 100,
    });
    if (!memories || memories.length === 0) {
      return undefined;
    }
    // Prefer the oldest entry so we never silently rotate a persisted wallet
    // if a duplicate ever gets written (e.g. two rapid init calls).
    const oldest = memories
      .filter((memory) => extractSecret(memory) !== undefined)
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))[0];
    return extractSecret(oldest);
  } catch (error) {
    logger.warn({ err: error, tableName }, 'failed to load persisted elisym secret');
    return undefined;
  }
}

async function saveSecret(runtime: IAgentRuntime, tableName: string, value: string): Promise<void> {
  try {
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: {
          text: '[redacted]',
          [SECRET_FIELD]: value,
          source: 'elisym-secrets',
        },
        createdAt: Date.now(),
      },
      tableName,
      true,
    );
  } catch (error) {
    logger.error(
      { err: error, tableName },
      'failed to persist generated elisym secret; agent will regenerate on next restart',
    );
  }
}

export function loadPersistedNostrSecret(runtime: IAgentRuntime): Promise<string | undefined> {
  return loadSecret(runtime, IDENTITY_MEMORY_TABLE);
}

export function persistNostrSecret(runtime: IAgentRuntime, value: string): Promise<void> {
  return saveSecret(runtime, IDENTITY_MEMORY_TABLE, value);
}

export function loadPersistedSolanaSecret(runtime: IAgentRuntime): Promise<string | undefined> {
  return loadSecret(runtime, WALLET_MEMORY_TABLE);
}

export function persistSolanaSecret(runtime: IAgentRuntime, value: string): Promise<void> {
  return saveSecret(runtime, WALLET_MEMORY_TABLE, value);
}
