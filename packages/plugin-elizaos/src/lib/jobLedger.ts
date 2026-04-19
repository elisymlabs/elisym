import type { IAgentRuntime, Memory } from '@elizaos/core';
import { JOB_LEDGER_RETENTION_MS, JOB_LEDGER_VERSION, JOBS_MEMORY_TABLE } from '../constants';
import { logger } from './logger';
import { incrementCounter, METRIC_JOBS_TOTAL } from './metrics';

export type JobSide = 'provider' | 'customer';

export type ProviderState =
  | 'waiting_payment'
  | 'paid'
  | 'executed'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export type CustomerState =
  | 'submitted'
  | 'waiting_payment'
  | 'payment_sent'
  | 'result_received'
  | 'failed'
  | 'cancelled';

export type JobState = ProviderState | CustomerState;

const TERMINAL_STATES = new Set<JobState>(['delivered', 'result_received', 'failed', 'cancelled']);

export interface JobLedgerEntry {
  jobEventId: string;
  side: JobSide;
  state: JobState;
  capability: string;
  priceLamports: string;
  rawEventJson?: string;
  customerPubkey?: string;
  providerPubkey?: string;
  input?: string;
  paymentRequestJson?: string;
  txSignature?: string;
  resultContent?: string;
  error?: string;
  retryCount?: number;
  transitionAt: number;
  jobCreatedAt: number;
  version: number;
}

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

// Ordering uses memory.createdAt (the DB row timestamp) so that two
// ledger entries written in quick succession can still be ordered
// reliably even if their embedded entry.transitionAt happens to tie.
// Tests can also inject historical entries by writing memories with
// explicit createdAt values, without having to go through recordTransition.
function memoryTimestamp(memory: Memory): number {
  return memory.createdAt ?? 0;
}

// Callers spread an existing JobLedgerEntry to carry forward fields;
// transitionAt and version MUST be stamped fresh by this function, so the
// entry type strips them off to prevent accidental carry-over (which
// would make the new row indistinguishable-or-older than the prior one,
// breaking loadLatest's "latest by transitionAt" rule).
export async function recordTransition(
  runtime: IAgentRuntime,
  entry: Omit<JobLedgerEntry, 'transitionAt' | 'version'>,
): Promise<void> {
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
    logger.error({ err: error, entry: finalized }, 'jobLedger.recordTransition failed');
  }
}

export async function loadLatest(
  runtime: IAgentRuntime,
  side?: JobSide,
): Promise<Map<string, JobLedgerEntry>> {
  const latest = new Map<string, JobLedgerEntry>();
  let memories: Memory[];
  try {
    memories = await runtime.getMemories({
      tableName: JOBS_MEMORY_TABLE,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      count: 2000,
    });
  } catch (error) {
    logger.warn({ err: error }, 'jobLedger.loadLatest: getMemories failed');
    return latest;
  }
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
  return latest;
}

export async function pendingJobs(
  runtime: IAgentRuntime,
  side: JobSide,
): Promise<JobLedgerEntry[]> {
  const latest = await loadLatest(runtime, side);
  const pending: JobLedgerEntry[] = [];
  for (const entry of latest.values()) {
    if (!TERMINAL_STATES.has(entry.state)) {
      pending.push(entry);
    }
  }
  pending.sort((a, b) => a.jobCreatedAt - b.jobCreatedAt);
  return pending;
}

export async function findByJobId(
  runtime: IAgentRuntime,
  jobEventId: string,
): Promise<JobLedgerEntry | undefined> {
  const latest = await loadLatest(runtime);
  return latest.get(jobEventId);
}

// Drop ledger entries older than JOB_LEDGER_RETENTION_MS where the latest
// state is terminal. Non-terminal (stuck) entries are retained indefinitely
// so recovery keeps trying; operators can mark them failed manually.
export async function pruneOldEntries(runtime: IAgentRuntime): Promise<number> {
  const cutoff = Date.now() - JOB_LEDGER_RETENTION_MS;
  let memories: Memory[];
  try {
    memories = await runtime.getMemories({
      tableName: JOBS_MEMORY_TABLE,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      count: 5000,
    });
  } catch (error) {
    logger.warn({ err: error }, 'jobLedger.pruneOldEntries: getMemories failed');
    return 0;
  }
  const latest = new Map<string, JobLedgerEntry>();
  const latestTs = new Map<string, number>();
  for (const memory of memories) {
    const entry = extractEntry(memory);
    if (!entry) {
      continue;
    }
    const ts = memoryTimestamp(memory);
    const existingTs = latestTs.get(entry.jobEventId) ?? -Infinity;
    if (ts >= existingTs) {
      latest.set(entry.jobEventId, entry);
      latestTs.set(entry.jobEventId, ts);
    }
  }
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
}
