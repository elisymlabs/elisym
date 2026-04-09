/**
 * Job recovery ledger - persistent JSON storage for crash recovery.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type LedgerStatus = 'paid' | 'executed' | 'delivered' | 'failed';

export interface LedgerEntry {
  job_id: string;
  status: LedgerStatus;
  input: string;
  input_type: string;
  tags: string[];
  customer_id: string;
  bid?: number;
  payment_request?: string;
  net_amount?: number;
  result?: string;
  raw_event_json?: string;
  created_at: number;
  retry_count: number;
}

const VALID_TRANSITIONS: Record<LedgerStatus, LedgerStatus[]> = {
  paid: ['executed', 'failed'],
  executed: ['delivered', 'failed'],
  delivered: [],
  failed: [],
};

export class JobLedger {
  private entries = new Map<string, LedgerEntry>();
  private path: string;

  constructor(agentName: string) {
    this.path = join(homedir(), '.elisym', 'agents', agentName, 'jobs.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const data = JSON.parse(raw) as Record<string, LedgerEntry>;
      for (const [id, entry] of Object.entries(data)) {
        this.entries.set(id, entry);
      }
    } catch (e: any) {
      // W4: Log warning on malformed ledger and backup corrupt file
      if (e?.code !== 'ENOENT') {
        console.warn(`  ! Ledger load warning: ${e?.message ?? 'unknown error'}`);
        try {
          renameSync(this.path, this.path + '.corrupt.' + Date.now());
        } catch {
          /* best effort backup */
        }
      }
    }
  }

  flush(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(this.entries);
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, this.path);
  }

  recordPaid(entry: Omit<LedgerEntry, 'status' | 'retry_count'>): void {
    if (this.entries.has(entry.job_id)) {
      return;
    }
    this.entries.set(entry.job_id, { ...entry, status: 'paid', retry_count: 0 });
    this.flush();
  }

  updatePayment(jobId: string, netAmount?: number, paymentRequest?: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      if (netAmount !== undefined) {
        entry.net_amount = netAmount;
      }
      if (paymentRequest !== undefined) {
        entry.payment_request = paymentRequest;
      }
      this.flush();
    }
  }

  /** Attempt a state transition. Returns the entry if valid, undefined otherwise. */
  private transition(jobId: string, to: LedgerStatus): LedgerEntry | undefined {
    const entry = this.entries.get(jobId);
    if (!entry) {
      return undefined;
    }
    if (!VALID_TRANSITIONS[entry.status].includes(to)) {
      return undefined;
    }
    entry.status = to;
    return entry;
  }

  markExecuted(jobId: string, result: string): void {
    const entry = this.transition(jobId, 'executed');
    if (entry) {
      entry.result = result;
      this.flush();
    }
  }

  markDelivered(jobId: string): void {
    const entry = this.transition(jobId, 'delivered');
    if (entry) {
      entry.result = undefined; // Free memory
      this.flush();
    }
  }

  markFailed(jobId: string): void {
    const entry = this.transition(jobId, 'failed');
    if (entry) {
      entry.result = undefined; // Free memory
      try {
        this.flush();
      } catch {
        /* disk full - in-memory state is still correct */
      }
    }
  }

  incrementRetry(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.retry_count++;
      this.flush();
    }
  }

  getStatus(jobId: string): LedgerStatus | undefined {
    return this.entries.get(jobId)?.status;
  }

  pendingJobs(): LedgerEntry[] {
    return [...this.entries.values()].filter((e) => e.status === 'paid' || e.status === 'executed');
  }

  /** Remove old delivered/failed entries (default: 7 days). */
  gc(maxAgeSecs = 7 * 24 * 60 * 60): void {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSecs;
    for (const [id, entry] of this.entries) {
      if (
        (entry.status === 'delivered' || entry.status === 'failed') &&
        entry.created_at < cutoff
      ) {
        this.entries.delete(id);
      }
    }
    this.flush();
  }
}
