import { HOUR_MS } from '../constants';

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

export function createSpendingBucket(options: SpendingBucketOptions): SpendingBucket {
  return {
    events: [],
    perJobCap: options.maxSpendPerJobLamports,
    perHourCap: options.maxSpendPerHourLamports,
    approvalThreshold: options.requireApprovalAboveLamports,
  };
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
