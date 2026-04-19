import type { IAgentRuntime, Memory } from '@elizaos/core';
import { HOUR_MS, SPEND_MEMORY_TABLE } from '../constants';
import { logger } from './logger';

export class SpendingLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendingLimitError';
  }
}

interface BucketEvent {
  ts: number;
  lamports: bigint;
  pending: boolean;
}

export interface SpendingBucket {
  events: BucketEvent[];
  perJobCap: bigint;
  perHourCap: bigint;
  approvalThreshold: bigint;
}

export interface SpendingBucketOptions {
  maxSpendPerJobLamports: bigint;
  maxSpendPerHourLamports: bigint;
  requireApprovalAboveLamports: bigint;
}

export interface SpendingReservation {
  release: () => void;
  confirm: () => void;
}

export function createSpendingBucket(
  options: SpendingBucketOptions,
  initialEvents: BucketEvent[] = [],
): SpendingBucket {
  return {
    events: [...initialEvents],
    perJobCap: options.maxSpendPerJobLamports,
    perHourCap: options.maxSpendPerHourLamports,
    approvalThreshold: options.requireApprovalAboveLamports,
  };
}

interface PersistedSpendContent extends Record<string, unknown> {
  text: string;
  source: string;
  elisym_spend: true;
  lamports: string;
  ts: number;
}

function isSpendContent(value: unknown): value is PersistedSpendContent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.elisym_spend === true && typeof v.lamports === 'string' && typeof v.ts === 'number';
}

export async function loadSpendingHistory(
  runtime: IAgentRuntime,
  now: number = Date.now(),
): Promise<BucketEvent[]> {
  let memories: Memory[];
  try {
    memories = await runtime.getMemories({
      tableName: SPEND_MEMORY_TABLE,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      count: 2000,
    });
  } catch (error) {
    logger.warn({ err: error }, 'loadSpendingHistory: getMemories failed');
    return [];
  }
  const cutoff = now - HOUR_MS;
  const events: BucketEvent[] = [];
  for (const memory of memories) {
    if (!isSpendContent(memory.content)) {
      continue;
    }
    if (memory.content.ts < cutoff) {
      continue;
    }
    try {
      events.push({
        ts: memory.content.ts,
        lamports: BigInt(memory.content.lamports),
        pending: false,
      });
    } catch {
      // malformed row - skip
    }
  }
  return events;
}

export async function persistSpend(
  runtime: IAgentRuntime,
  lamports: bigint,
  ts: number = Date.now(),
): Promise<void> {
  try {
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: {
          text: `[spend] ${lamports.toString()} lamports`,
          source: 'elisym-spend',
          elisym_spend: true,
          lamports: lamports.toString(),
          ts,
        },
        createdAt: ts,
      },
      SPEND_MEMORY_TABLE,
      false,
    );
  } catch (error) {
    // Swallow but log: losing one persist call means the hourly cap
    // reports a slightly lower total after a crash - still safer than
    // failing the whole job flow because the ledger write blipped.
    logger.warn({ err: error, lamports: lamports.toString() }, 'persistSpend failed');
  }
}

function pruneBucket(bucket: SpendingBucket, now: number): void {
  const cutoff = now - HOUR_MS;
  bucket.events = bucket.events.filter((event) => event.pending || event.ts >= cutoff);
}

export function hourlyTotal(bucket: SpendingBucket, now: number = Date.now()): bigint {
  pruneBucket(bucket, now);
  return bucket.events.reduce((sum, event) => sum + event.lamports, 0n);
}

export function assertCanSpend(bucket: SpendingBucket, lamports: bigint): void {
  if (lamports <= 0n) {
    throw new SpendingLimitError(`Spend amount must be positive, got ${lamports}`);
  }
  if (lamports > bucket.perJobCap) {
    throw new SpendingLimitError(
      `Amount ${lamports} lamports exceeds per-job cap ${bucket.perJobCap}`,
    );
  }
  const total = hourlyTotal(bucket);
  if (total + lamports > bucket.perHourCap) {
    throw new SpendingLimitError(
      `Would exceed hourly cap: ${total + lamports} > ${bucket.perHourCap}`,
    );
  }
}

export function reserveSpend(
  bucket: SpendingBucket,
  lamports: bigint,
  at: number = Date.now(),
): SpendingReservation {
  assertCanSpend(bucket, lamports);
  const event: BucketEvent = { ts: at, lamports, pending: true };
  bucket.events.push(event);
  let settled = false;
  return {
    release: () => {
      if (settled) {
        return;
      }
      settled = true;
      const index = bucket.events.indexOf(event);
      if (index !== -1) {
        bucket.events.splice(index, 1);
      }
    },
    confirm: () => {
      if (settled) {
        return;
      }
      settled = true;
      event.pending = false;
      event.ts = Date.now();
    },
  };
}

export function requiresApproval(bucket: SpendingBucket, lamports: bigint): boolean {
  return lamports > bucket.approvalThreshold;
}

export function recordSpend(
  bucket: SpendingBucket,
  lamports: bigint,
  at: number = Date.now(),
): void {
  bucket.events.push({ ts: at, lamports, pending: false });
}
