import type { LedgerState } from '@merchant-node/ledger';
import type { Db, Queryable } from '../db/db';

/** A fenced save matched no row: another holder saved since this handle was read, or the lease moved. */
export class LedgerConflict extends Error {
  constructor(readonly owner: string) {
    super(`The ledger of ${owner} changed under this holder or its lease moved: not saved`);
    this.name = 'LedgerConflict';
  }
}

/** The admin request a save was to mark applied is no longer pending: nothing was saved. */
export class RequestNotPending extends Error {
  constructor(readonly requestId: string) {
    super(`Admin request ${requestId} is not pending: not applied again`);
    this.name = 'RequestNotPending';
  }
}

export interface SaveOptions {
  /** An `admin_requests` id marked `applied` in the same transaction as the save. */
  appliedRequest?: string;
  /** More writes that commit with the save or not at all (the setup pass marks owner events recorded). */
  alongside?: (tx: Queryable) => Promise<void>;
}

/**
 * The ledger as JSON text. A `text` column, not `jsonb`: jsonb refuses the
 * `\u0000` escape and lone surrogates, which a buyer can put in any string
 * field, and one such order would fail every save of its store.
 */
export function serializeLedger(state: LedgerState): string {
  return JSON.stringify(state);
}

/**
 * The ledger as stored, its version unchecked: a host upgrades it before use
 * (merchant-node's `upgradeLedger`) and saves the result through the fence.
 */
export function parseLedger(text: string, owner: string): LedgerState {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The ledger of ${owner} is not a JSON object`);
  }
  return parsed as LedgerState;
}

/** The first ledger row of a new store (or an imported one): fence 1, no lease epoch yet. */
export async function insertLedger(
  tx: Queryable,
  owner: string,
  state: LedgerState,
  now: number,
): Promise<void> {
  await tx.query(
    `insert into ledgers (owner, row_version, lease_epoch, state, updated_at)
     values ($1, 1, 0, $2, $3)`,
    [owner, serializeLedger(state), now],
  );
}

/**
 * One run's view of a store's ledger, read at `open`. Its saves are fenced on
 * the row version it last read or wrote, and on the lease (owner, epoch,
 * holder) still being current. A handle whose save failed is never reused:
 * the caller opens a fresh one from the database.
 */
export class LedgerHandle {
  private version: number;
  private current: LedgerState;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    readonly owner: string,
    readonly epoch: number,
    readonly holder: string,
    rowVersion: number,
    state: LedgerState,
  ) {
    this.version = rowVersion;
    this.current = state;
  }

  get rowVersion(): number {
    return this.version;
  }

  /** The state as read, then as last saved through this handle. */
  get state(): LedgerState {
    return this.current;
  }

  /**
   * Save `state` if the row is still at this handle's version and the lease
   * is still this holder's at this epoch, and mark `appliedRequest` applied in
   * the same transaction. Throws `LedgerConflict` (nothing written) otherwise.
   */
  async save(state: LedgerState, options: SaveOptions = {}): Promise<void> {
    const text = serializeLedger(state);
    const at = this.now();
    const rowVersion = await this.db.transaction(async (tx) => {
      const [row] = await tx.query<{ row_version: number }>(
        `update ledgers set state = $3, row_version = row_version + 1, lease_epoch = $4, updated_at = $5
         where owner = $1 and row_version = $2
           and exists (select 1 from leases l where l.owner = $1 and l.epoch = $4 and l.holder = $6)
         returning row_version`,
        [this.owner, this.version, text, this.epoch, at, this.holder],
      );
      if (row === undefined) {
        throw new LedgerConflict(this.owner);
      }
      if (options.appliedRequest !== undefined) {
        const marked = await tx.query(
          `update admin_requests set state = 'applied', applied_at = $2
           where id = $1 and owner = $3 and state = 'pending' returning 1`,
          [options.appliedRequest, at, this.owner],
        );
        if (marked.length === 0) {
          throw new RequestNotPending(options.appliedRequest);
        }
      }
      await options.alongside?.(tx);
      return row.row_version;
    });
    this.version = rowVersion;
    this.current = state;
  }
}

/** The stores' ledgers in Postgres, one row each, written only through fenced handles. */
export class PgLedgerStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** A handle on the row as it is now, for a run under the lease (`epoch`, `holder`). */
  async open(owner: string, epoch: number, holder: string): Promise<LedgerHandle> {
    const [row] = await this.db.query<{ row_version: number; state: string }>(
      'select row_version, state from ledgers where owner = $1',
      [owner],
    );
    if (row === undefined) {
      throw new Error(`No ledger for ${owner}`);
    }
    return new LedgerHandle(
      this.db,
      this.now,
      owner,
      epoch,
      holder,
      row.row_version,
      parseLedger(row.state, owner),
    );
  }
}
