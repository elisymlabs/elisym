/**
 * Shared JobLedger types + adapter interface for elisym crash recovery.
 *
 * The ledger is an append-only log of state transitions for each job,
 * keyed by the Nostr job-request event id. Each adapter chooses its own
 * storage backend (Eliza memory, SQLite, tests-only in-memory) and
 * exposes the minimal read/write surface this module defines.
 */

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

export const JOB_LEDGER_VERSION = 1;

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'delivered',
  'result_received',
  'failed',
  'cancelled',
]);

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

/**
 * Input to `adapter.write`. The adapter is responsible for stamping
 * `transitionAt` (wall-clock) and `version` so callers can spread an
 * earlier entry safely without carrying those fields forward.
 */
export type JobLedgerWriteInput = Omit<JobLedgerEntry, 'transitionAt' | 'version'>;

export interface JobLedgerAdapter {
  /** Append a new state transition for a job. */
  write(entry: JobLedgerWriteInput): Promise<void>;
  /**
   * Return the latest entry per job id. If `side` is given, restrict to
   * one side; otherwise include both.
   */
  loadLatest(side?: JobSide): Promise<Map<string, JobLedgerEntry>>;
  /**
   * Delete terminal entries whose last transition happened before
   * `now - retentionMs`. Non-terminal entries are retained so recovery
   * can keep retrying. Returns the number of entries dropped.
   */
  pruneOldEntries(retentionMs: number): Promise<number>;
}

/**
 * Convenience: return non-terminal entries for `side`, oldest-first by
 * `jobCreatedAt`. Derived from `loadLatest` so any adapter satisfies it.
 */
export async function pendingJobs(
  adapter: JobLedgerAdapter,
  side: JobSide,
): Promise<JobLedgerEntry[]> {
  const latest = await adapter.loadLatest(side);
  const pending: JobLedgerEntry[] = [];
  for (const entry of latest.values()) {
    if (!TERMINAL_STATES.has(entry.state)) {
      pending.push(entry);
    }
  }
  pending.sort((left, right) => left.jobCreatedAt - right.jobCreatedAt);
  return pending;
}

export async function findByJobId(
  adapter: JobLedgerAdapter,
  jobEventId: string,
): Promise<JobLedgerEntry | undefined> {
  const latest = await adapter.loadLatest();
  return latest.get(jobEventId);
}
