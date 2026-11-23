/**
 * Suspension (sub-plan step 15). A `suspend` request moves the store to
 * `suspending` and runs a setup pass with every product sold out (the
 * replaceable listings say so; `recordPublished` retires the terms of each
 * listing that went out). The clock (`suspending_since`) starts only once
 * every listing is out or unchanged: a sold-out listing no relay took keeps
 * its terms standing, so the pass is retried with backoff first. From then
 * the node keeps intake and sweep for `TERMS_STAND_SECS` (the unpaid order
 * lifetime plus skew) and until its webhook outbox is empty; then the store
 * is `suspended` and its lease let go.
 */
import type { LedgerState } from '@merchant-node/ledger';
import type { Db } from '../db/db';
import type { StoreStatus } from '../state/leases';
import { type LedgerHandle, LedgerConflict, RequestNotPending } from '../state/ledger-store';
import { TERMS_STAND_SECS } from './load';
import { type SetupPassDeps, SetupPassFailed, runStoreSetupPass } from './setup-pass';
import { controlBackoffMs } from './start-checks';
import type { StoreSupervisor } from './supervisor';

/** The statuses a store may be suspended from. */
const SUSPEND_FROM: readonly StoreStatus[] = ['active', 'degraded', 'halted'];

export interface SuspensionDeps {
  db: Db;
  supervisor: Pick<StoreSupervisor, 'applyControl' | 'leased'>;
  setup: SetupPassDeps;
  log?: (message: string) => void;
  /** Seconds. */
  now: () => number;
}

/** Whether a webhook may still be sent for a paid order: a pending entry before its deadline. */
export function outboxEmpty(state: Pick<LedgerState, 'orders'>, now: number): boolean {
  return !Object.values(state.orders).some(
    (order) => order.webhook?.state === 'pending' && order.webhook.deadline > now,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Suspensions {
  /** Per store: the next sold-out pass after one that did not get every listing out. */
  private readonly retries = new Map<string, { attempt: number; nextAt: number }>();

  constructor(private readonly deps: SuspensionDeps) {}

  /**
   * Apply a `suspend` request on the store's control queue: `suspending`
   * (marked applied in the same transaction, fenced on the lease), then the
   * sold-out pass. A store already winding down only marks the request.
   */
  async applyRequest(owner: string, requestId: string): Promise<void> {
    await this.deps.supervisor.applyControl(owner, async (handle) => {
      await this.enter(owner, requestId, handle);
      return this.soldOutPass(owner, handle);
    });
  }

  /**
   * One round over the stores this holder serves: a `suspending` store
   * without its clock gets its sold-out pass again when its backoff is due;
   * one whose clock ran past `TERMS_STAND_SECS` with an empty outbox is
   * `suspended`. Resolves to the owners suspended in this round.
   */
  async tick(): Promise<string[]> {
    const owners = this.deps.supervisor.leased;
    if (owners.length === 0) {
      return [];
    }
    const rows = await this.deps.db.query<{
      owner: string;
      suspending_since: number | null;
      state: string;
    }>(
      `select s.owner, s.suspending_since, l.state from stores s join ledgers l on l.owner = s.owner
       where s.owner = any($1::text[]) and s.status = 'suspending' order by s.owner`,
      [owners],
    );
    const suspending = new Set(rows.map((row) => row.owner));
    for (const owner of [...this.retries.keys()]) {
      if (!suspending.has(owner)) {
        this.retries.delete(owner);
      }
    }
    const suspended: string[] = [];
    const now = this.deps.now();
    for (const row of rows) {
      try {
        if (row.suspending_since === null) {
          if ((this.retries.get(row.owner)?.nextAt ?? 0) <= now) {
            await this.deps.supervisor.applyControl(row.owner, (handle) =>
              this.soldOutPass(row.owner, handle),
            );
          }
        } else if (
          now - row.suspending_since >= TERMS_STAND_SECS &&
          outboxEmpty(JSON.parse(row.state) as LedgerState, now)
        ) {
          const done = await this.deps.supervisor.applyControl(
            row.owner,
            (handle) => this.finish(row.owner, handle),
            { restart: (finished) => !finished },
          );
          if (done) {
            suspended.push(row.owner);
          }
        }
      } catch (error) {
        this.log(row.owner, `suspension: ${errorText(error)}`);
      }
    }
    return suspended;
  }

  private log(owner: string, message: string): void {
    (this.deps.log ?? ((line: string) => console.error(line)))(
      `store ${owner.slice(0, 12)}: ${message}`,
    );
  }

  /** `suspending` and the request applied, in one transaction under this run's lease. */
  private async enter(owner: string, requestId: string, handle: LedgerHandle): Promise<void> {
    const now = this.deps.now();
    await this.deps.db.transaction(async (tx) => {
      const held = await tx.query(
        'select 1 from leases where owner = $1 and holder = $2 and epoch = $3',
        [owner, handle.holder, handle.epoch],
      );
      if (held.length === 0) {
        throw new LedgerConflict(owner);
      }
      const moved = await tx.query(
        `update stores set status = 'suspending', status_reason = 'suspended by the owner',
           suspending_since = null
         where owner = $1 and status = any($2::text[]) returning 1`,
        [owner, SUSPEND_FROM],
      );
      const marked = await tx.query(
        `update admin_requests set state = 'applied', applied_at = $3, result = $4
         where id = $1 and owner = $2 and state = 'pending' returning 1`,
        [requestId, owner, now, JSON.stringify({ suspending: true, entered: moved.length > 0 })],
      );
      if (marked.length === 0) {
        throw new RequestNotPending(requestId);
      }
    });
    this.retries.delete(owner);
  }

  /**
   * Publish every listing sold out (the store's status is `suspending`, so the
   * setup pass reads its products sold out) and start the clock when every
   * one is out or unchanged; else retry with backoff. True when the clock runs.
   */
  private async soldOutPass(owner: string, handle: LedgerHandle): Promise<boolean> {
    const { db } = this.deps;
    const [row] = await db.query<{ status: StoreStatus; suspending_since: number | null }>(
      'select status, suspending_since from stores where owner = $1',
      [owner],
    );
    if (row === undefined || row.status !== 'suspending') {
      return false;
    }
    if (row.suspending_since !== null) {
      return true;
    }
    let complete: boolean;
    let problem: string | undefined;
    try {
      const result = await runStoreSetupPass(this.deps.setup, owner, handle);
      complete =
        result.kind === 'no_payout_list' ||
        result.outcomes.every((outcome) => outcome.listing !== 'failed');
      if (!complete && result.kind === 'done') {
        problem = `sold-out listings no relay took: ${result.outcomes
          .filter((outcome) => outcome.listing === 'failed')
          .map((outcome) => outcome.d)
          .join(', ')}`;
      }
    } catch (error) {
      if (!(error instanceof SetupPassFailed)) {
        throw error;
      }
      complete = false;
      problem = error.message;
    }
    const now = this.deps.now();
    if (!complete) {
      const attempt = this.retries.get(owner)?.attempt ?? 0;
      const waitMs = controlBackoffMs(attempt);
      this.retries.set(owner, { attempt: attempt + 1, nextAt: now + Math.ceil(waitMs / 1000) });
      this.log(owner, `suspension: ${problem ?? 'not every listing out'}; again in ${waitMs} ms`);
      return false;
    }
    this.retries.delete(owner);
    await db.query(
      `update stores set suspending_since = $2
       where owner = $1 and status = 'suspending' and suspending_since is null
         and exists (select 1 from leases l where l.owner = $1 and l.holder = $3 and l.epoch = $4)`,
      [owner, now, handle.holder, handle.epoch],
    );
    return true;
  }

  /** `suspended`, lease let go, when the outbox is still empty on the fresh handle. */
  private async finish(owner: string, handle: LedgerHandle): Promise<boolean> {
    const now = this.deps.now();
    if (!outboxEmpty(handle.state, now)) {
      return false;
    }
    return this.deps.db.transaction(async (tx) => {
      const moved = await tx.query(
        `update stores set status = 'suspended',
           status_reason = 'suspended: every order past its lifetime and every webhook sent'
         where owner = $1 and status = 'suspending' and suspending_since is not null
           and suspending_since <= $2
           and exists (select 1 from leases l where l.owner = $1 and l.holder = $3 and l.epoch = $4)
         returning 1`,
        [owner, now - TERMS_STAND_SECS, handle.holder, handle.epoch],
      );
      if (moved.length === 0) {
        return false;
      }
      await tx.query('update leases set expires_at = 0 where owner = $1 and holder = $2', [
        owner,
        handle.holder,
      ]);
      return true;
    });
  }
}
