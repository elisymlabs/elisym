import {
  findByJobId as sdkFindByJobId,
  JOB_LEDGER_VERSION,
  pendingJobs as sdkPendingJobs,
  TERMINAL_STATES,
  type JobLedgerAdapter,
  type JobLedgerEntry,
  type JobLedgerWriteInput,
  type JobSide,
  type JobState,
} from '@elisym/sdk/runtime';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import { JOB_LEDGER_RETENTION_MS, JOBS_MEMORY_TABLE } from '../constants';
import { logger } from './logger';
import { incrementCounter, METRIC_JOBS_TOTAL } from './metrics';

export type {
  CustomerState,
  JobLedgerEntry,
  JobSide,
  JobState,
  ProviderState,
} from '@elisym/sdk/runtime';
export { JOB_LEDGER_VERSION, TERMINAL_STATES } from '@elisym/sdk/runtime';

interface LedgerContent extends Record<string, unknown> {
  text: string;
  source: string;
  elisym_ledger: true;
  entry: JobLedgerEntry;
}

function isLedgerContent(value: unknown): value is LedgerContent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybe = value as Record<string, unknown>;
  if (maybe.elisym_ledger !== true) {
    return false;
  }
  const entry = maybe.entry;
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const entryRecord = entry as Record<string, unknown>;
  return (
    typeof entryRecord.jobEventId === 'string' &&
    (entryRecord.side === 'provider' || entryRecord.side === 'customer') &&
    typeof entryRecord.state === 'string' &&
    typeof entryRecord.transitionAt === 'number'
  );
}

function extractEntry(memory: Memory): JobLedgerEntry | undefined {
  if (isLedgerContent(memory.content)) {
    return memory.content.entry;
  }
  return undefined;
}

// Ordering uses memory.createdAt (the DB row timestamp) so two ledger
// rows written in quick succession can still be ordered reliably even
// if their embedded entry.transitionAt happens to tie. Tests can also
// inject historical entries by writing memories with explicit
// createdAt values, without having to go through write().
function memoryTimestamp(memory: Memory): number {
  return memory.createdAt ?? 0;
}

/**
 * Build a `JobLedgerAdapter` backed by Eliza's agent memory store. Each
 * state transition is appended as a separate memory row in the
 * `elisym_jobs` table; latest-per-job is computed by scanning.
 */
export function createElizaMemoryAdapter(runtime: IAgentRuntime): JobLedgerAdapter {
  async function readAll(count: number): Promise<Memory[]> {
    try {
      return await runtime.getMemories({
        tableName: JOBS_MEMORY_TABLE,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        count,
      });
    } catch (error) {
      logger.warn({ err: error }, 'jobLedger: getMemories failed');
      return [];
    }
  }

  function computeLatest(
    memories: Memory[],
    side?: JobSide,
  ): {
    latest: Map<string, JobLedgerEntry>;
    latestTs: Map<string, number>;
  } {
    const latest = new Map<string, JobLedgerEntry>();
    const latestTs = new Map<string, number>();
    for (const memory of memories) {
      const entry = extractEntry(memory);
      if (!entry) {
        continue;
      }
      if (side && entry.side !== side) {
        continue;
      }
      const ts = memoryTimestamp(memory);
      const existingTs = latestTs.get(entry.jobEventId) ?? -Infinity;
      if (ts >= existingTs) {
        latest.set(entry.jobEventId, entry);
        latestTs.set(entry.jobEventId, ts);
      }
    }
    return { latest, latestTs };
  }

  return {
    async write(entry: JobLedgerWriteInput): Promise<void> {
      const finalized: JobLedgerEntry = {
        ...entry,
        transitionAt: Date.now(),
        version: JOB_LEDGER_VERSION,
      };
      const content: LedgerContent = {
        text: `[job-ledger] ${finalized.side} ${finalized.state} ${finalized.jobEventId.slice(0, 8)}`,
        source: 'elisym-ledger',
        elisym_ledger: true,
        entry: finalized,
      };
      try {
        await runtime.createMemory(
          {
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            content,
            createdAt: finalized.transitionAt,
          },
          JOBS_MEMORY_TABLE,
          false,
        );
        incrementCounter(METRIC_JOBS_TOTAL, { side: finalized.side, state: finalized.state });
      } catch (error) {
        // Never spread the full `finalized` entry into the log - it carries
        // rawEventJson (customer input) and resultContent (LLM output).
        // The canonical redact paths catch those by name, but we narrow
        // here so an accidental redact-paths regression cannot expose them.
        logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            jobEventId: finalized.jobEventId,
            side: finalized.side,
            state: finalized.state,
          },
          'jobLedger.write failed',
        );
      }
    },
    async loadLatest(side?: JobSide): Promise<Map<string, JobLedgerEntry>> {
      const memories = await readAll(2000);
      return computeLatest(memories, side).latest;
    },
    async pruneOldEntries(retentionMs: number): Promise<number> {
      const cutoff = Date.now() - retentionMs;
      const memories = await readAll(5000);
      const { latest, latestTs } = computeLatest(memories);
      const deletableIds = new Set<string>();
      for (const [jobEventId, entry] of latest) {
        if (TERMINAL_STATES.has(entry.state) && (latestTs.get(jobEventId) ?? 0) < cutoff) {
          deletableIds.add(jobEventId);
        }
      }
      if (deletableIds.size === 0) {
        return 0;
      }
      let deleted = 0;
      for (const memory of memories) {
        const entry = extractEntry(memory);
        if (!entry || !memory.id || !deletableIds.has(entry.jobEventId)) {
          continue;
        }
        try {
          const runtimeWithDelete = runtime as IAgentRuntime & {
            deleteMemory?: (id: string) => Promise<void>;
          };
          if (typeof runtimeWithDelete.deleteMemory === 'function') {
            await runtimeWithDelete.deleteMemory(memory.id);
            deleted++;
          }
        } catch (error) {
          logger.debug({ err: error, memoryId: memory.id }, 'jobLedger.prune: deleteMemory failed');
        }
      }
      return deleted;
    },
  };
}

/**
 * Legacy runtime-first wrappers. Preserve the historical API so existing
 * handler / test call sites don't need to thread the adapter explicitly.
 */

export async function recordTransition(
  runtime: IAgentRuntime,
  entry: JobLedgerWriteInput,
): Promise<void> {
  await createElizaMemoryAdapter(runtime).write(entry);
}

export async function loadLatest(
  runtime: IAgentRuntime,
  side?: JobSide,
): Promise<Map<string, JobLedgerEntry>> {
  return createElizaMemoryAdapter(runtime).loadLatest(side);
}

export async function pendingJobs(
  runtime: IAgentRuntime,
  side: JobSide,
): Promise<JobLedgerEntry[]> {
  return sdkPendingJobs(createElizaMemoryAdapter(runtime), side);
}

export async function findByJobId(
  runtime: IAgentRuntime,
  jobEventId: string,
): Promise<JobLedgerEntry | undefined> {
  return sdkFindByJobId(createElizaMemoryAdapter(runtime), jobEventId);
}

export async function pruneOldEntries(runtime: IAgentRuntime): Promise<number> {
  return createElizaMemoryAdapter(runtime).pruneOldEntries(JOB_LEDGER_RETENTION_MS);
}
