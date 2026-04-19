import { pendingJobs, type JobLedgerAdapter, type JobLedgerEntry, type JobSide } from './jobLedger';

export interface RecoveryLoopLogger {
  info?(obj: Record<string, unknown>, msg?: string): void;
  warn?(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface RecoveryLoopOptions {
  adapter: JobLedgerAdapter;
  /** Called for each non-terminal provider-side entry. Should advance state. */
  onProviderPending?: (entry: JobLedgerEntry) => Promise<void>;
  /** Called for each non-terminal customer-side entry. Should advance state. */
  onCustomerPending?: (entry: JobLedgerEntry) => Promise<void>;
  /** Sweep cadence. */
  intervalMs: number;
  /** Retention for terminal entries. Passed to adapter.pruneOldEntries each sweep. */
  retentionMs: number;
  /** Concurrent per-job worker count during a sweep. */
  concurrency: number;
  /** Optional structured logger. Falls back to silence. */
  logger?: RecoveryLoopLogger;
}

export interface RecoveryLoop {
  /** Kick off an initial sweep (non-blocking) and start the periodic timer. */
  start(): void;
  /** Stop the periodic timer. Does not cancel an in-flight sweep. */
  stop(): void;
  /** Run a single sweep synchronously. Useful for tests or manual triggers. */
  sweepOnce(): Promise<void>;
}

/**
 * Generic recovery scaffold: periodic pruning + concurrent replay of
 * non-terminal ledger entries. Per-side handlers own the business
 * semantics (retry budget, re-execute, payment verify, delivery retry).
 *
 * Notes:
 * - Overlap guard: if the previous sweep is still in flight, subsequent
 *   tick fires are skipped - no queueing. The next on-schedule fire will
 *   pick up where the previous left off (ledger is idempotent).
 * - Handler errors are caught and logged at `warn` so a single bad entry
 *   doesn't poison the batch.
 */
export function createRecoveryLoop(options: RecoveryLoopOptions): RecoveryLoop {
  const { adapter, onProviderPending, onCustomerPending, intervalMs, retentionMs, concurrency } =
    options;
  const logger = options.logger ?? {};
  if (intervalMs <= 0) {
    throw new RangeError('intervalMs must be > 0');
  }
  if (concurrency <= 0) {
    throw new RangeError('concurrency must be > 0');
  }
  if (retentionMs <= 0) {
    throw new RangeError('retentionMs must be > 0');
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function runBatch(
    entries: JobLedgerEntry[],
    handler: (entry: JobLedgerEntry) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const workerCount = Math.min(concurrency, entries.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (index < entries.length) {
        const currentIndex = index++;
        const entry = entries[currentIndex];
        if (!entry) {
          continue;
        }
        try {
          await handler(entry);
        } catch (error) {
          logger.warn?.(
            {
              err: error instanceof Error ? error.message : String(error),
              jobEventId: entry.jobEventId,
              side: entry.side,
              state: entry.state,
            },
            'recovery handler threw',
          );
        }
      }
    });
    await Promise.all(workers);
  }

  async function sweepSide(
    side: JobSide,
    handler: ((entry: JobLedgerEntry) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!handler) {
      return;
    }
    const pending = await pendingJobs(adapter, side);
    if (pending.length === 0) {
      return;
    }
    logger.info?.({ [side]: pending.length }, 'recovery sweep: resuming pending jobs');
    await runBatch(pending, handler);
  }

  async function sweepOnce(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      try {
        await adapter.pruneOldEntries(retentionMs);
      } catch (error) {
        logger.warn?.(
          { err: error instanceof Error ? error.message : String(error) },
          'recovery: pruneOldEntries failed',
        );
      }
      await sweepSide('provider', onProviderPending);
      await sweepSide('customer', onCustomerPending);
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) {
      return;
    }
    // Initial sweep kicked off in background so start() returns quickly.
    sweepOnce().catch((error) =>
      logger.warn?.(
        { err: error instanceof Error ? error.message : String(error) },
        'initial recovery sweep failed',
      ),
    );
    timer = setInterval(() => {
      sweepOnce().catch((error) =>
        logger.warn?.(
          { err: error instanceof Error ? error.message : String(error) },
          'recovery sweep failed',
        ),
      );
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, stop, sweepOnce };
}
