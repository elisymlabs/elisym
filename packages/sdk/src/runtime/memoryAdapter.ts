import {
  JOB_LEDGER_VERSION,
  TERMINAL_STATES,
  type JobLedgerAdapter,
  type JobLedgerEntry,
  type JobLedgerWriteInput,
  type JobSide,
} from './jobLedger';

interface Row {
  entry: JobLedgerEntry;
  /** Row timestamp, separate from entry.transitionAt so we can resolve ties. */
  rowAt: number;
}

/**
 * In-memory reference adapter. Useful for tests and ephemeral deployments
 * where no durable backing store is required. Not suitable for real
 * crash-recovery (everything is lost on process exit).
 */
export function createMemoryJobLedgerAdapter(): JobLedgerAdapter & {
  /** Test-only: drop all rows. */
  clear(): void;
  /** Test-only: inspect the raw append log. */
  rows(): ReadonlyArray<JobLedgerEntry>;
} {
  const log: Row[] = [];
  let rowCounter = 0;

  function latestByJobId(side?: JobSide): Map<string, JobLedgerEntry> {
    const latest = new Map<string, JobLedgerEntry>();
    const latestRowAt = new Map<string, number>();
    for (const row of log) {
      if (side && row.entry.side !== side) {
        continue;
      }
      const jobId = row.entry.jobEventId;
      const previous = latestRowAt.get(jobId) ?? -Infinity;
      if (row.rowAt >= previous) {
        latest.set(jobId, row.entry);
        latestRowAt.set(jobId, row.rowAt);
      }
    }
    return latest;
  }

  return {
    async write(entry: JobLedgerWriteInput): Promise<void> {
      const finalized: JobLedgerEntry = {
        ...entry,
        transitionAt: Date.now(),
        version: JOB_LEDGER_VERSION,
      };
      rowCounter += 1;
      log.push({ entry: finalized, rowAt: rowCounter });
    },
    async loadLatest(side?: JobSide): Promise<Map<string, JobLedgerEntry>> {
      return latestByJobId(side);
    },
    async pruneOldEntries(retentionMs: number): Promise<number> {
      const cutoff = Date.now() - retentionMs;
      const latest = latestByJobId();
      const dropIds = new Set<string>();
      for (const [jobId, entry] of latest) {
        if (TERMINAL_STATES.has(entry.state) && entry.transitionAt < cutoff) {
          dropIds.add(jobId);
        }
      }
      if (dropIds.size === 0) {
        return 0;
      }
      let deleted = 0;
      for (let index = log.length - 1; index >= 0; index--) {
        const row = log[index];
        if (row && dropIds.has(row.entry.jobEventId)) {
          log.splice(index, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
    clear(): void {
      log.length = 0;
      rowCounter = 0;
    },
    rows(): ReadonlyArray<JobLedgerEntry> {
      return log.map((row) => row.entry);
    },
  };
}
